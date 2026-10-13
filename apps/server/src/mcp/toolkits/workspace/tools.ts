import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { HTML_RENDER_THEME_GUIDE } from "@t3tools/shared/htmlRender";
import {
  WORKSPACE_MAX_ASSETS,
  WORKSPACE_MAX_TITLE_LENGTH,
  WORKSPACE_MUTATE_TOOL_NAME,
  WORKSPACE_PAGE_GUIDE,
  WORKSPACE_RESTORE_TOOL_NAME,
  WORKSPACE_STATE_TOOL_NAME,
} from "@t3tools/shared/mutationWorkspace";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as MutationWorkspace from "../../../mutationWorkspace/MutationWorkspace.ts";
import * as WorkspaceState from "../../../mutationWorkspace/WorkspaceState.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  MutationWorkspace.MutationWorkspace,
  WorkspaceState.WorkspaceState,
];

const WorkspaceMutateTool = Tool.make(WORKSPACE_MUTATE_TOOL_NAME, {
  description: `Transform this thread's interface into a workspace built for the user's task, replacing the chat view until the task is done. Use it when the user asks to do hands-on work that a dedicated professional application serves better than chat: editing a photo they attached or one on disk, cutting a video, mixing audio, exploring a dataset, laying out a design. Write the whole interface from scratch for this request. Calling it again rebuilds the workspace in place (the user's control state is kept), so iterate when the user asks for more tools. Write one self-contained document with inline <style> and <script>; remote http(s) libraries load as-is. ${WORKSPACE_PAGE_GUIDE} ${HTML_RENDER_THEME_GUIDE} After calling it, reply briefly about what you built; the user is already looking at it. When the user is finished, call ${WORKSPACE_RESTORE_TOOL_NAME}.`,
  parameters: Schema.Struct({
    html: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000_000)).annotate({
      description: "A complete, self-contained HTML document for the workspace.",
    }),
    title: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(WORKSPACE_MAX_TITLE_LENGTH),
    ).annotate({ description: 'Short name of the workspace, such as "Photo editor".' }),
    assets: Schema.optional(
      Schema.Array(Schema.String).check(Schema.isMaxLength(WORKSPACE_MAX_ASSETS)),
    ).annotate({
      description:
        "Absolute paths of files on this machine the workspace works on (images, video), in addition to images the user attached in this thread. Each appears in t3.workspace.assets().",
    }),
  }),
  success: Schema.Struct({
    mutationWorkspace: Schema.Struct({
      attachmentId: Schema.String,
      title: Schema.String,
      assets: Schema.Array(Schema.Struct({ path: Schema.String, name: Schema.String })),
    }),
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Build workspace")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WorkspaceRestoreTool = Tool.make(WORKSPACE_RESTORE_TOOL_NAME, {
  description: `Return this thread from its workspace to the normal chat interface. Call it when the user says they are done with the workspace, or asks to go back to chatting or to other work. The workspace stays reachable from the thread history.`,
  parameters: Schema.Struct({
    summary: Schema.optional(Schema.String.check(Schema.isMaxLength(500))).annotate({
      description: "One line on what was accomplished in the workspace.",
    }),
  }),
  success: Schema.Struct({ restored: Schema.Boolean, message: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Return to chat")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WorkspaceStateTool = Tool.make(WORKSPACE_STATE_TOOL_NAME, {
  description: `Read the current control values of this thread's workspace: the last object its page stored with t3.workspace.setState. Call it before acting on a message the user sent from the workspace when the request depends on what they have set (for example "apply this to the full-resolution file").`,
  // No `parameters`: an explicit Schema.Struct({}) is not a valid MCP input schema (see worktree/tools.ts).
  success: Schema.Struct({ state: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read workspace controls")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const WorkspaceToolkit = Toolkit.make(
  WorkspaceMutateTool,
  WorkspaceRestoreTool,
  WorkspaceStateTool,
);
