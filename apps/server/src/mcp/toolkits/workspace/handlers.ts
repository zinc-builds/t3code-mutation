import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MutationWorkspace from "../../../mutationWorkspace/MutationWorkspace.ts";
import { workspaceMutateAdvice } from "../../../mutationWorkspace/workspaceValidation.ts";
import * as WorkspaceState from "../../../mutationWorkspace/WorkspaceState.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WorkspaceToolkit } from "./tools.ts";

const INVALID_REQUEST_ERRORS = new Set([
  "HtmlRenderImagesNotFoundError",
  "HtmlRenderImageTooLargeError",
  "HtmlRenderPageTooLargeError",
  "WorkspaceAssetNotFoundError",
  "WorkspaceChromeInvalidError",
  "WorkspaceKitInvalidError",
  "WorkspacePreviewUrlInvalidError",
]);

// Every workspace error message is built on the server and tells the agent what to do next.
const toFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: INVALID_REQUEST_ERRORS.has(error._tag) ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const callingThread = (operation: string) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const { thread } = yield* McpInvocationContext.requireThreadScope(scope, operation);
    return thread.threadId;
  });

const handlers = {
  // The workspace replaces the calling thread's view, so it needs that thread's live run.
  workspace_mutate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callingThread("workspace_mutate");
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const { reference, validation } = yield* workspace
        .publish({
          threadId,
          html: input.html,
          template: input.template,
          kit: input.kit,
          title: input.title,
          assetPaths: input.assets ?? [],
          chrome: input.chrome,
          preview: input.preview,
          validation: input.validation,
        })
        .pipe(Effect.mapError(toFailure));
      return {
        mutationWorkspace: reference,
        validation,
        message: workspaceMutateAdvice(validation),
      };
    }),
  ),
  // Clients leave the workspace when they see this call complete.
  workspace_restore: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      yield* callingThread("workspace_restore");
      return {
        restored: true,
        message: "The thread is back in its chat interface.",
      };
    }),
  ),
  workspace_kit_docs: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      return yield* workspace.kitDocs(input.names).pipe(Effect.mapError(toFailure));
    }),
  ),
  workspace_state: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const threadId = yield* callingThread("workspace_state");
      const workspaceState = yield* WorkspaceState.WorkspaceState;
      const state = yield* workspaceState.read(threadId).pipe(Effect.mapError(toFailure));
      return { state: state ?? null };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof WorkspaceToolkit.tools>;

export const layer = McpToolAccess.toLayer(WorkspaceToolkit, handlers);
