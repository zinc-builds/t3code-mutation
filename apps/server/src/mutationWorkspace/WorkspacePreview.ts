import {
  type ThreadId,
  type WorkspacePreviewActInput,
  type WorkspacePreviewActResult,
  WorkspacePreviewError,
  type WorkspacePreviewEvent,
  type WorkspacePreviewOpenInput,
  type WorkspacePreviewSession,
  type WorkspacePreviewSubscribeInput,
} from "@t3tools/contracts";
import { workspacePreviewOrigin } from "@t3tools/shared/mutationWorkspace";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as PreviewManager from "../preview/Manager.ts";
import * as WorkspaceAssets from "./WorkspaceAssets.ts";
import * as WorkspacePreviewBrowser from "./WorkspacePreviewBrowser.ts";

/**
 * Live pages a workspace reviews, such as the user's dev server for a design
 * review. The workspace's sandboxed page cannot load or read the site, so the
 * environment opens it in a review page of its own browser and the workspace
 * works through these methods. A review page opens only on an origin the
 * thread's `workspace_mutate` calls declared or one of its preview tabs shows,
 * and lives while a client follows its events (`subscribe`), so a closed tab
 * or dropped connection cannot leave it running.
 */
export class WorkspacePreview extends Context.Service<
  WorkspacePreview,
  {
    readonly open: (
      input: WorkspacePreviewOpenInput,
    ) => Effect.Effect<WorkspacePreviewSession, WorkspacePreviewError>;
    readonly act: (
      input: WorkspacePreviewActInput,
    ) => Effect.Effect<WorkspacePreviewActResult, WorkspacePreviewError>;
    /**
     * The page's own changes until it closes. A session that is gone, or not
     * the thread's, yields one `closed` event.
     */
    readonly subscribe: (
      input: WorkspacePreviewSubscribeInput,
    ) => Stream.Stream<WorkspacePreviewEvent>;
  }
>()("t3/mutationWorkspace/WorkspacePreview") {}

/** Each review page holds a renderer process on the environment. */
const MAX_SESSIONS = 6;
/** How long a page nobody follows stays open, so a reconnecting client finds it. */
const UNWATCHED_GRACE = "1 minute";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
/** A full-page capture stops this far down, in CSS pixels, to bound its size. */
const FULL_PAGE_MAX_HEIGHT = 8_000;

interface Session {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly page: WorkspacePreviewBrowser.WorkspacePreviewPage;
  readonly scope: Scope.Closeable;
  readonly listeners: Set<(event: WorkspacePreviewEvent) => void>;
  closed: boolean;
  /** Closes the page while nobody follows it. */
  expiry: Fiber.Fiber<void> | null;
}

type CloseReason = Extract<WorkspacePreviewEvent, { readonly _tag: "closed" }>["reason"];

const failed = (cause: unknown) => new WorkspacePreviewError({ reason: "failed", cause });

const make = Effect.gen(function* () {
  const browser = yield* WorkspacePreviewBrowser.WorkspacePreviewBrowser;
  const workspaceAssets = yield* WorkspaceAssets.WorkspaceAssets;
  const previewManager = yield* PreviewManager.PreviewManager;
  const crypto = yield* Crypto.Crypto;
  const serviceScope = yield* Effect.scope;
  // Page events arrive from the browser, outside any fiber.
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const sessions = new Map<string, Session>();
  let opening = 0;

  /** An origin a `workspace_mutate` call declared, or one a preview tab of the thread shows. */
  const authorizeUrl = Effect.fn("WorkspacePreview.authorizeUrl")(function* (
    threadId: ThreadId,
    url: string,
  ) {
    const origin = workspacePreviewOrigin(url);
    if (origin === undefined) return yield* new WorkspacePreviewError({ reason: "invalid-url" });
    if (
      yield* workspaceAssets.declaresPreviewOrigin(threadId, origin).pipe(Effect.mapError(failed))
    )
      return;
    const { sessions: tabs } = yield* previewManager.list({ threadId });
    const shown = tabs.some(
      (tab) =>
        tab.navStatus._tag !== "Idle" && workspacePreviewOrigin(tab.navStatus.url) === origin,
    );
    if (!shown) return yield* new WorkspacePreviewError({ reason: "undeclared-url" });
  });

  const close = Effect.fn("WorkspacePreview.close")(function* (
    session: Session,
    reason: CloseReason,
  ) {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.id);
    const event: WorkspacePreviewEvent = { _tag: "closed", sessionId: session.id, reason };
    for (const listener of session.listeners) listener(event);
    session.listeners.clear();
    if (session.expiry !== null) yield* Fiber.interrupt(session.expiry);
    yield* Scope.close(session.scope, Exit.void);
  });

  /** Starts the countdown that closes a page nobody follows. */
  const expireUnwatched = (session: Session) =>
    Effect.sleep(UNWATCHED_GRACE).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          session.expiry = null;
          return close(session, "expired");
        }),
      ),
      Effect.forkIn(serviceScope),
      Effect.map((fiber) => {
        session.expiry = fiber;
      }),
    );

  const onPageEvent = (
    session: Session,
    event: WorkspacePreviewBrowser.WorkspacePreviewPageEvent,
  ): Effect.Effect<void> => {
    if (session.closed) return Effect.void;
    if (event === "closed") return close(session, "crashed");
    return session.page.location.pipe(
      Effect.map(({ url, title }) => {
        if (session.closed) return;
        const changed: WorkspacePreviewEvent = {
          _tag: "changed",
          sessionId: session.id,
          reason: event,
          url,
          title,
        };
        for (const listener of session.listeners) listener(changed);
      }),
    );
  };

  const open: WorkspacePreview["Service"]["open"] = Effect.fn("WorkspacePreview.open")(
    function* (input) {
      yield* authorizeUrl(input.threadId, input.url);
      if (sessions.size + opening >= MAX_SESSIONS) {
        return yield* new WorkspacePreviewError({
          reason: "busy",
          detail: `At most ${MAX_SESSIONS} run at once.`,
        });
      }
      opening += 1;
      const session = yield* Effect.gen(function* () {
        const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const scope = yield* Scope.make();
        let opened: Session | undefined;
        const page = yield* Effect.gen(function* () {
          const page = yield* browser
            .open({
              viewport: input.viewport ?? DEFAULT_VIEWPORT,
              onEvent: (event) => {
                if (opened !== undefined) runFork(onPageEvent(opened, event));
              },
            })
            .pipe(Scope.provide(scope));
          yield* page.goto(input.url);
          return page;
        }).pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit))),
        );
        opened = {
          id,
          threadId: input.threadId,
          page,
          scope,
          listeners: new Set(),
          closed: false,
          expiry: null,
        };
        sessions.set(id, opened);
        yield* expireUnwatched(opened);
        return opened;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            opening -= 1;
          }),
        ),
      );
      const location = yield* session.page.location;
      return {
        sessionId: session.id,
        url: location.url,
        title: location.title,
        viewport: yield* session.page.viewport,
      };
    },
  );

  /** The session, when it is open and belongs to the thread. */
  const find = (threadId: ThreadId, sessionId: string) => {
    const session = sessions.get(sessionId);
    return session !== undefined && session.threadId === threadId ? session : undefined;
  };

  const act: WorkspacePreview["Service"]["act"] = Effect.fn("WorkspacePreview.act")(
    function* (input) {
      const session = find(input.threadId, input.sessionId);
      if (session === undefined) return yield* new WorkspacePreviewError({ reason: "not-found" });
      const { page } = session;
      const action = input.action;
      switch (action._tag) {
        case "screenshot": {
          const fullPage = action.fullPage ?? false;
          const capture = yield* page.screenshot({ fullPage, maxHeight: FULL_PAGE_MAX_HEIGHT });
          return {
            _tag: "screenshot",
            mimeType: "image/png",
            data: Buffer.from(capture.png).toString("base64"),
            width: capture.width,
            height: capture.height,
            scrollY: capture.scrollY,
            fullPage,
          } as const;
        }
        case "elementsAt":
          return {
            _tag: "elements",
            elements: yield* page.elementsAt(action.x, action.y),
          } as const;
        case "inspect":
          return { _tag: "element", element: yield* page.inspect(action.selector) } as const;
        case "highlight": {
          if (!(yield* page.highlight(action.selector))) {
            return yield* new WorkspacePreviewError({
              reason: "invalid-selector",
              detail: "Nothing in the page matches it.",
            });
          }
          return { _tag: "done" } as const;
        }
        case "scroll":
          return {
            _tag: "scrolled",
            scrollY: yield* page.scrollTo(Math.max(0, action.y)),
          } as const;
        case "setViewport":
          yield* page.setViewport(action.viewport);
          return { _tag: "viewport", viewport: yield* page.viewport } as const;
        case "setStyles":
          yield* page.setStyles(action.css);
          return { _tag: "done" } as const;
        case "reload":
          yield* page.reload;
          return { _tag: "done" } as const;
        case "close":
          yield* close(session, "closed");
          return { _tag: "done" } as const;
      }
    },
  );

  const subscribe: WorkspacePreview["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<WorkspacePreviewEvent, Cause.Done>();
        const listener = (event: WorkspacePreviewEvent) => {
          Queue.offerUnsafe(queue, event);
          if (event._tag === "closed") Queue.endUnsafe(queue);
        };
        // The listener joins as the stream starts, so no event after that is missed.
        yield* Effect.acquireRelease(
          Effect.suspend(() => {
            const session = find(input.threadId, input.sessionId);
            if (session === undefined) {
              listener({ _tag: "closed", sessionId: input.sessionId, reason: "unknown" });
              return Effect.succeed(undefined);
            }
            session.listeners.add(listener);
            const expiry = session.expiry;
            session.expiry = null;
            return (expiry === null ? Effect.void : Fiber.interrupt(expiry)).pipe(
              Effect.as(session),
            );
          }),
          (session) => {
            if (session === undefined || session.closed) return Effect.void;
            session.listeners.delete(listener);
            return session.listeners.size === 0 && session.expiry === null
              ? expireUnwatched(session)
              : Effect.void;
          },
        );
        return Stream.fromQueue(queue);
      }),
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.values()], (session) => close(session, "closed"), {
      discard: true,
    }),
  );

  return WorkspacePreview.of({ open, act, subscribe });
});

export const layer = Layer.effect(WorkspacePreview, make);
