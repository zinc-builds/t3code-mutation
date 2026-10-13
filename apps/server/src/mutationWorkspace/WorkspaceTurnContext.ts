import type { ThreadId, WorkspaceStateError } from "@t3tools/contracts";
import { type WorkspaceReference } from "@t3tools/shared/mutationWorkspace";
import { isWorkspaceRestoreToolItem, workspaceFromToolItem } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
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
  }
>()("t3/mutationWorkspace/WorkspaceTurnContext") {}

const make = Effect.gen(function* () {
  const workspaceState = yield* WorkspaceState.WorkspaceState;
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

  return WorkspaceTurnContext.of({ forUserMessage });
});

export const layer = Layer.effect(WorkspaceTurnContext, make);
