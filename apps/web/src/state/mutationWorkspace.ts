import { createMutationWorkspaceEnvironmentAtoms } from "@t3tools/client-runtime/state/mutation-workspace";

import { connectionAtomRuntime } from "../connection/runtime";

export const mutationWorkspaceEnvironment =
  createMutationWorkspaceEnvironmentAtoms(connectionAtomRuntime);
