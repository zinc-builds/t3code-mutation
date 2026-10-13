import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/** Largest control state a thread's workspace may store, as UTF-8 JSON. */
export const WORKSPACE_MAX_STATE_BYTES = 64 * 1024;

/**
 * The control state a mutation workspace page keeps for its thread. Clients
 * read it when the page starts and replace it as the user works the controls;
 * the agent reads the same state through `workspace_state`.
 */
export const WorkspaceReadStateInput = Schema.Struct({ threadId: ThreadId });
export type WorkspaceReadStateInput = typeof WorkspaceReadStateInput.Type;

export const WorkspaceReadStateResult = Schema.Struct({
  /** The page's last stored state, or null before it stored any. */
  state: Schema.Unknown,
});
export type WorkspaceReadStateResult = typeof WorkspaceReadStateResult.Type;

export const WorkspaceUpdateStateInput = Schema.Struct({
  threadId: ThreadId,
  state: Schema.Unknown,
});
export type WorkspaceUpdateStateInput = typeof WorkspaceUpdateStateInput.Type;

export class WorkspaceStateError extends Schema.TaggedError<WorkspaceStateError>()(
  "WorkspaceStateError",
  {
    reason: Schema.Literals(["too-large", "invalid-thread", "store-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "too-large":
        return `Workspace state must be at most ${WORKSPACE_MAX_STATE_BYTES} bytes of JSON.`;
      case "invalid-thread":
        return "This thread cannot store workspace state.";
      case "store-failed":
        return "The workspace state could not be read or saved.";
    }
  }
}
