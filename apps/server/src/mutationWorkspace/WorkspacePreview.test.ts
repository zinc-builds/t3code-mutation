import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ThreadId,
  WorkspacePreviewError,
  type WorkspacePreviewElement,
  type WorkspacePreviewViewport,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PreviewManager from "../preview/Manager.ts";
import * as WorkspaceAssets from "./WorkspaceAssets.ts";
import * as WorkspacePreview from "./WorkspacePreview.ts";
import * as WorkspacePreviewBrowser from "./WorkspacePreviewBrowser.ts";

const thread = ThreadId.make("thread-review");
const other = ThreadId.make("thread-other");
const DECLARED = "http://localhost:5173";

const element = (selector: string): WorkspacePreviewElement => ({
  selector,
  tag: "section",
  box: { x: 0, y: 40, width: 1280, height: 600 },
  text: "Ship faster",
  html: `<section id="hero">`,
  styles: { "font-size": "48px" },
});

interface FakePage {
  url: string;
  viewport: WorkspacePreviewViewport;
  highlighted: string | null;
  readonly onEvent: (event: WorkspacePreviewBrowser.WorkspacePreviewPageEvent) => void;
  readonly closed: Deferred.Deferred<void>;
}

/** Pages that load any URL except one naming "down", and record what was done to them. */
const fakeBrowser = (pages: Array<FakePage>) =>
  Layer.succeed(
    WorkspacePreviewBrowser.WorkspacePreviewBrowser,
    WorkspacePreviewBrowser.WorkspacePreviewBrowser.of({
      open: ({ viewport, onEvent }) =>
        Effect.gen(function* () {
          const closed = yield* Deferred.make<void>();
          const page: FakePage = {
            url: "about:blank",
            viewport,
            highlighted: null,
            onEvent,
            closed,
          };
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
          pages.push(page);
          return {
            goto: (url) =>
              url.includes("down")
                ? Effect.fail(new WorkspacePreviewError({ reason: "unreachable" }))
                : Effect.sync(() => {
                    page.url = url;
                  }),
            reload: Effect.void,
            location: Effect.sync(() => ({ url: page.url, title: "Fake app" })),
            viewport: Effect.sync(() => page.viewport),
            setViewport: (next) =>
              Effect.sync(() => {
                page.viewport = next;
              }),
            screenshot: ({ fullPage, maxHeight }) =>
              Effect.succeed({
                png: new Uint8Array([137, 80, 78, 71]),
                width: page.viewport.width,
                height: fullPage ? Math.min(20_000, maxHeight) : page.viewport.height,
                scrollY: fullPage ? 0 : 120,
              }),
            elementsAt: () => Effect.succeed([element("#hero"), element("main")]),
            inspect: (selector) =>
              selector === "[["
                ? Effect.fail(new WorkspacePreviewError({ reason: "invalid-selector" }))
                : Effect.succeed(selector === "#hero" ? element("#hero") : null),
            highlight: (selector) =>
              Effect.sync(() => {
                if (selector !== null && selector !== "#hero") return false;
                page.highlighted = selector;
                return true;
              }),
            scrollTo: (y) => Effect.succeed(y),
          };
        }),
    }),
  );

/** The service over fake pages, the thread's declared origin, and real preview tabs. */
const layer = (pages: Array<FakePage>) =>
  WorkspacePreview.layer.pipe(
    Layer.provide(fakeBrowser(pages)),
    Layer.provide(
      Layer.mock(WorkspaceAssets.WorkspaceAssets)({
        declaresPreviewOrigin: (threadId, origin) =>
          Effect.succeed(threadId === thread && origin === DECLARED),
      }),
    ),
    Layer.provideMerge(PreviewManager.layer),
    Layer.provide(NodeCrypto.layer),
  );

const withService = <A, E>(
  body: (
    service: WorkspacePreview.WorkspacePreview["Service"],
    pages: Array<FakePage>,
  ) => Effect.Effect<A, E, PreviewManager.PreviewManager>,
) => {
  const pages: Array<FakePage> = [];
  return Effect.gen(function* () {
    const service = yield* WorkspacePreview.WorkspacePreview;
    return yield* body(service, pages);
  }).pipe(Effect.provide(layer(pages)));
};

const reason = <A>(effect: Effect.Effect<A, WorkspacePreviewError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

it.effect("opens only declared origins and origins the thread's preview tabs show", () =>
  withService((service, pages) =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.open({ threadId: thread, url: "http://localhost:4000/" });
      yield* manager.open({ threadId: other, url: "http://localhost:9000/" });

      // Any page on a declared origin, or on a preview tab's.
      const opened = yield* service.open({ threadId: thread, url: `${DECLARED}/settings` });
      assert.strictEqual(opened.url, `${DECLARED}/settings`);
      assert.deepStrictEqual(opened.viewport, { width: 1280, height: 800 });
      yield* service.open({ threadId: thread, url: "http://localhost:4000/about" });

      // Not another origin, another thread's tab, or anything but http(s).
      assert.strictEqual(
        yield* reason(service.open({ threadId: thread, url: "http://localhost:8080/" })),
        "undeclared-url",
      );
      assert.strictEqual(
        yield* reason(service.open({ threadId: thread, url: "http://localhost:9000/" })),
        "undeclared-url",
      );
      assert.strictEqual(
        yield* reason(service.open({ threadId: other, url: `${DECLARED}/` })),
        "undeclared-url",
      );
      assert.strictEqual(
        yield* reason(service.open({ threadId: thread, url: "file:///etc/hosts" })),
        "invalid-url",
      );
      // Refused URLs never reach the browser.
      assert.strictEqual(pages.length, 2);
    }),
  ),
);

it.effect("closes the page when it cannot load, and caps how many run at once", () =>
  withService((service, pages) =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* reason(service.open({ threadId: thread, url: `${DECLARED}/down` })),
        "unreachable",
      );
      yield* Deferred.await(pages[0]!.closed);
      for (let index = 0; index < 6; index += 1) {
        yield* service.open({ threadId: thread, url: `${DECLARED}/${index}` });
      }
      assert.strictEqual(
        yield* reason(service.open({ threadId: thread, url: `${DECLARED}/7` })),
        "busy",
      );
    }),
  ),
);

it.effect("acts on the thread's own session and shapes each result", () =>
  withService((service, pages) =>
    Effect.gen(function* () {
      const { sessionId } = yield* service.open({
        threadId: thread,
        url: `${DECLARED}/`,
        viewport: { width: 390, height: 844 },
      });
      const act = (action: Parameters<typeof service.act>[0]["action"]) =>
        service.act({ threadId: thread, sessionId, action });

      const shot = yield* act({ _tag: "screenshot" });
      assert.deepStrictEqual(shot, {
        _tag: "screenshot",
        mimeType: "image/png",
        data: Buffer.from([137, 80, 78, 71]).toString("base64"),
        width: 390,
        height: 844,
        scrollY: 120,
        fullPage: false,
      });
      const full = yield* act({ _tag: "screenshot", fullPage: true });
      assert.include(full, { height: 8_000, scrollY: 0, fullPage: true });

      const under = yield* act({ _tag: "elementsAt", x: 10, y: 60 });
      assert.deepStrictEqual(
        under._tag === "elements" ? under.elements.map((found) => found.selector) : [],
        ["#hero", "main"],
      );
      assert.deepStrictEqual(yield* act({ _tag: "inspect", selector: ".missing" }), {
        _tag: "element",
        element: null,
      });
      assert.strictEqual(
        yield* reason(act({ _tag: "inspect", selector: "[[" })),
        "invalid-selector",
      );

      yield* act({ _tag: "highlight", selector: "#hero" });
      assert.strictEqual(pages[0]!.highlighted, "#hero");
      assert.strictEqual(
        yield* reason(act({ _tag: "highlight", selector: ".missing" })),
        "invalid-selector",
      );
      assert.deepStrictEqual(yield* act({ _tag: "scroll", y: -50 }), {
        _tag: "scrolled",
        scrollY: 0,
      });
      assert.deepStrictEqual(
        yield* act({ _tag: "setViewport", viewport: { width: 1440, height: 900 } }),
        { _tag: "viewport", viewport: { width: 1440, height: 900 } },
      );

      // Another thread cannot reach the session, even by its id.
      assert.strictEqual(
        yield* reason(service.act({ threadId: other, sessionId, action: { _tag: "reload" } })),
        "not-found",
      );

      yield* act({ _tag: "close" });
      yield* Deferred.await(pages[0]!.closed);
      assert.strictEqual(yield* reason(act({ _tag: "reload" })), "not-found");
    }),
  ),
);

it.effect("streams the page's own changes until it closes", () =>
  withService((service, pages) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sessionId } = yield* service.open({ threadId: thread, url: `${DECLARED}/` });
        const pull = yield* Stream.toPull(service.subscribe({ threadId: thread, sessionId }));
        // Started at once, so the subscription is in place before the page changes.
        const first = yield* Effect.forkChild(pull, { startImmediately: true });

        pages[0]!.onEvent("mutated");
        assert.deepStrictEqual(yield* Fiber.join(first), [
          { _tag: "changed", sessionId, reason: "mutated", url: `${DECLARED}/`, title: "Fake app" },
        ]);

        // The page crashing ends the session for everyone following it.
        pages[0]!.onEvent("closed");
        assert.deepStrictEqual(yield* pull, [{ _tag: "closed", sessionId, reason: "crashed" }]);
        yield* Deferred.await(pages[0]!.closed);

        // A session that is gone, or another thread's, answers with one closed event.
        const gone = yield* Stream.runCollect(service.subscribe({ threadId: thread, sessionId }));
        assert.deepStrictEqual(gone, [{ _tag: "closed", sessionId, reason: "unknown" }]);
      }),
    ),
  ),
);

it.effect("closes a page nobody follows after a minute", () =>
  withService((service, pages) =>
    Effect.gen(function* () {
      // Opened but never followed.
      yield* service.open({ threadId: thread, url: `${DECLARED}/a` });
      yield* TestClock.adjust("61 seconds");
      yield* Deferred.await(pages[0]!.closed);

      // Followed: it stays open, then closes a minute after the last follower leaves.
      const { sessionId } = yield* service.open({ threadId: thread, url: `${DECLARED}/b` });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pull = yield* Stream.toPull(service.subscribe({ threadId: thread, sessionId }));
          const following = yield* Effect.forkChild(pull, { startImmediately: true });
          yield* TestClock.adjust("5 minutes");
          const still = yield* service.act({
            threadId: thread,
            sessionId,
            action: { _tag: "scroll", y: 10 },
          });
          assert.deepStrictEqual(still, { _tag: "scrolled", scrollY: 10 });
          yield* Fiber.interrupt(following);
        }),
      );
      yield* TestClock.adjust("61 seconds");
      yield* Deferred.await(pages[1]!.closed);
    }),
  ),
);
