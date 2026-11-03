import type { RunId, ThreadId, WorkspaceStateError } from "@t3tools/contracts";
import {
  WORKSPACE_MUTATE_TOOL_NAME,
  WORKSPACE_RESTORE_TOOL_NAME,
  type WorkspaceReference,
} from "@t3tools/shared/mutationWorkspace";
import { isWorkspaceRestoreToolItem, workspaceFromToolItem } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { instantChartsForRequest, type InstantWorkspaceMatch } from "./instantWorkspace.ts";
import * as MutationWorkspace from "./MutationWorkspace.ts";
import * as WorkspaceState from "./WorkspaceState.ts";

/** The most a context block adds to a prompt, tags included. */
export const WORKSPACE_CONTEXT_MAX_BYTES = 4096;

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/** The longest prefix of `text` within `maxBytes` of UTF-8, never splitting a character. */
function truncateToBytes(text: string, maxBytes: number) {
  const decoded = new TextDecoder().decode(encoder.encode(text).subarray(0, Math.max(0, maxBytes)));
  return decoded.endsWith("\uFFFD") && !text.startsWith(decoded) ? decoded.slice(0, -1) : decoded;
}

function contextBlock(workspace: WorkspaceReference, state: unknown) {
  const open = "<workspace_context>\n";
  const close = "\n</workspace_context>";
  const intro = `Your workspace "${workspace.title}" is open in this thread. Its controls, as the user has set them (what workspace_state returns):\n`;
  const json = JSON.stringify(state);
  const whole = `${open}${intro}${json}${close}`;
  if (byteLength(whole) <= WORKSPACE_CONTEXT_MAX_BYTES) return whole;
  const cut = "\n(cut short; call workspace_state for the full state)";
  const room = WORKSPACE_CONTEXT_MAX_BYTES - byteLength(`${open}${intro}${cut}${close}`);
  return `${open}${intro}${truncateToBytes(json, room)}${cut}${close}`;
}

/**
 * What a provider is told about the thread's workspace with each user message,
 * so every provider sees the page's controls without calling workspace_state.
 */
export class WorkspaceTurnContext extends Context.Service<
  WorkspaceTurnContext,
  {
    /**
     * A `<workspace_context>` block (at most {@link WORKSPACE_CONTEXT_MAX_BYTES})
     * to put before a user's message: the stored control state of the workspace
     * the agent last opened with workspace_mutate and has not closed with
     * workspace_restore. Empty when there is no such workspace or no state.
     */
    readonly forUserMessage: (
      threadId: ThreadId,
    ) => Effect.Effect<string, WorkspaceStateError | ProjectionStore.ProjectionStoreV2Error>;
    /**
     * Publishes the workspace an obvious request asks for, without a model. None when the thread
     * already has one open or the page cannot be built; the agent then handles the request.
     */
    readonly openInstant: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly cwd: string;
      readonly text: string;
      readonly match: InstantWorkspaceMatch;
    }) => Effect.Effect<Option.Option<InstantWorkspaceOpened>>;
  }
>()("t3/mutationWorkspace/WorkspaceTurnContext") {}

export interface InstantWorkspaceOpened {
  /** What the tool item records, as if the agent had called workspace_mutate. */
  readonly input: unknown;
  readonly output: unknown;
  /** Put before the user's message so the agent carries on from the open workspace. */
  readonly context: string;
}

const SAMPLE_BYTES = 8192;
const EMPTY_SAMPLE = { text: "", truncated: false };

const make = Effect.gen(function* () {
  const workspaceState = yield* WorkspaceState.WorkspaceState;
  const workspaces = yield* MutationWorkspace.MutationWorkspace;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

  const forUserMessage = Effect.fn("WorkspaceTurnContext.forUserMessage")(function* (
    threadId: ThreadId,
  ) {
    // Most threads never had a workspace; their missing state skips the item read.
    const state = yield* workspaceState.read(threadId);
    if (state === undefined || state === null) return "";
    const { turnItems } = yield* projectionStore.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["dynamic_tool"],
      turnItemStatuses: ["completed"],
    });
    for (let index = turnItems.length - 1; index >= 0; index -= 1) {
      const item = turnItems[index]!;
      if (item.type !== "dynamic_tool") continue;
      const workspace = workspaceFromToolItem(item);
      if (workspace !== undefined) return contextBlock(workspace, state);
      if (isWorkspaceRestoreToolItem(item)) return "";
    }
    return "";
  });

  const hasOpenWorkspace = Effect.fn("WorkspaceTurnContext.hasOpenWorkspace")(function* (
    threadId: ThreadId,
  ) {
    const { turnItems } = yield* projectionStore.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["dynamic_tool"],
      turnItemStatuses: ["completed"],
    });
    for (let index = turnItems.length - 1; index >= 0; index -= 1) {
      const item = turnItems[index]!;
      if (item.type !== "dynamic_tool") continue;
      if (workspaceFromToolItem(item) !== undefined) return true;
      if (isWorkspaceRestoreToolItem(item)) return false;
    }
    return false;
  });

  // Only the start of the file: a request should not wait on reading a huge dataset.
  const readSample = (filePath: string) =>
    fileSystem.open(filePath).pipe(
      Effect.flatMap((file) => file.readAlloc(SAMPLE_BYTES)),
      Effect.map((bytes) =>
        Option.match(bytes, {
          onNone: () => EMPTY_SAMPLE,
          onSome: (read) => ({
            text: new TextDecoder().decode(read),
            truncated: read.byteLength >= SAMPLE_BYTES,
          }),
        }),
      ),
      Effect.scoped,
      Effect.orElseSucceed(() => EMPTY_SAMPLE),
    );

  // The page lists a thread's images oldest first and photo-develop opens the first, so with
  // another image in the thread only the agent can pick the one this message means.
  const hasOtherThreadImages = Effect.fn("WorkspaceTurnContext.hasOtherThreadImages")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const { turnItems } = yield* projectionStore.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["user_message"],
    });
    return turnItems.some(
      (item) =>
        item.type === "user_message" &&
        item.runId !== runId &&
        item.attachments.some((attachment) => attachment.type === "image"),
    );
  });

  const openInstant = Effect.fn("WorkspaceTurnContext.openInstant")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly cwd: string;
      readonly text: string;
      readonly match: InstantWorkspaceMatch;
    }) {
      const { file, templateId } = input.match;
      if (
        (yield* hasOpenWorkspace(input.threadId)) ||
        (templateId === "photo-develop" &&
          (yield* hasOtherThreadImages(input.threadId, input.runId)))
      ) {
        return Option.none<InstantWorkspaceOpened>();
      }
      const asset = file === undefined ? undefined : path.resolve(input.cwd, file);
      const charts =
        asset === undefined || file === undefined || templateId !== "data-explore"
          ? undefined
          : instantChartsForRequest({
              text: input.text,
              file,
              ...(yield* readSample(asset).pipe(
                Effect.map(({ text, truncated }) => ({ sample: text, truncated })),
              )),
            });
      const template =
        charts === undefined ? { id: templateId } : { id: templateId, options: { charts } };
      const title = asset === undefined ? "Workspace" : path.basename(asset);
      const assets = asset === undefined ? [] : [asset];
      const { reference, validation } = yield* workspaces.publish({
        threadId: input.threadId,
        title,
        template,
        assetPaths: assets,
      });
      const context = `<workspace_context>\nT3 already opened the ${templateId} workspace${asset === undefined ? "" : ` on ${asset}`} for this request${charts === undefined ? "" : ", charting the columns it names"}, and the user is looking at it. Do not open it again. If they asked about something specific it does not show yet, read what you need and call ${WORKSPACE_MUTATE_TOOL_NAME} once with options. If this is not what they wanted, call ${WORKSPACE_RESTORE_TOOL_NAME}. Otherwise reply briefly.\n</workspace_context>`;
      return Option.some({
        input: { title, template, assets },
        output: { structuredContent: { mutationWorkspace: reference, validation } },
        context,
      });
    },
    (effect) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logInfo("Left an instant workspace to the agent.", { cause }).pipe(
            Effect.as(Option.none<InstantWorkspaceOpened>()),
          ),
        ),
      ),
  );

  return WorkspaceTurnContext.of({ forUserMessage, openInstant });
});

export const layer = Layer.effect(WorkspaceTurnContext, make);
