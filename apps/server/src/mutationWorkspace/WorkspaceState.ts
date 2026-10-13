import type { ThreadId } from "@t3tools/contracts";
import { WORKSPACE_MAX_STATE_BYTES } from "@t3tools/shared/mutationWorkspace";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

const StateJson = Schema.fromJsonString(Schema.Unknown);
const decodeState = Schema.decodeEffect(StateJson);
const encodeState = Schema.encodeEffect(StateJson);

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

/**
 * The control state of a thread's workspace: the last object its page stored.
 * One per thread, so it survives the agent rebuilding the workspace.
 */
export class WorkspaceState extends Context.Service<
  WorkspaceState,
  {
    /** The stored state, or undefined before any was set. */
    readonly read: (threadId: ThreadId) => Effect.Effect<unknown, WorkspaceStateError>;
    readonly write: (
      threadId: ThreadId,
      state: unknown,
    ) => Effect.Effect<void, WorkspaceStateError>;
  }
>()("t3/mutationWorkspace/WorkspaceState") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const stateDir = path.join(config.stateDir, "mutation-workspaces");
  const storeFailed = (cause: unknown) =>
    new WorkspaceStateError({ reason: "store-failed", cause });

  const statePath = (threadId: ThreadId) => {
    const segment = toSafeThreadAttachmentSegment(threadId);
    return segment === null
      ? Effect.fail(new WorkspaceStateError({ reason: "invalid-thread" }))
      : Effect.succeed(path.join(stateDir, `${segment}.json`));
  };

  const read = Effect.fn("WorkspaceState.read")(function* (threadId: ThreadId) {
    const file = yield* statePath(threadId);
    if (!(yield* fileSystem.exists(file).pipe(Effect.mapError(storeFailed)))) return undefined;
    const text = yield* fileSystem.readFileString(file).pipe(Effect.mapError(storeFailed));
    return yield* decodeState(text).pipe(Effect.mapError(storeFailed));
  });

  const write = Effect.fn("WorkspaceState.write")(function* (threadId: ThreadId, state: unknown) {
    const file = yield* statePath(threadId);
    const text = yield* encodeState(state ?? null).pipe(Effect.mapError(storeFailed));
    if (Buffer.byteLength(text) > WORKSPACE_MAX_STATE_BYTES) {
      return yield* new WorkspaceStateError({ reason: "too-large" });
    }
    yield* fileSystem
      .makeDirectory(stateDir, { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(file, text)), Effect.mapError(storeFailed));
  });

  return WorkspaceState.of({ read, write });
});

export const layer = Layer.effect(WorkspaceState, make);
