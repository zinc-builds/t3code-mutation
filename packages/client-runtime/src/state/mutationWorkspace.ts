import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * RPC commands a mutation workspace host makes for its page: the thread's
 * stored control state, read when the page starts and replaced as the user
 * works the controls. Each client instantiates them with its own connection
 * runtime (`mutationWorkspaceEnvironment` in web).
 */
export function createMutationWorkspaceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    readState: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workspace:read-state",
      tag: WS_METHODS.workspaceReadState,
    }),
    updateState: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workspace:update-state",
      tag: WS_METHODS.workspaceUpdateState,
      // Each write replaces the whole state, so only the newest queued one matters
      // and an older write can never land after a newer one.
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
    }),
  };
}
