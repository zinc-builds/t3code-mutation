import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { HTML_RENDER_THEME_GUIDE } from "@t3tools/shared/htmlRender";
import {
  WORKSPACE_KIT_DOCS_TOOL_NAME,
  WORKSPACE_MAX_ASSETS,
  WORKSPACE_MAX_TITLE_LENGTH,
  WORKSPACE_MUTATE_TOOL_NAME,
  WORKSPACE_PAGE_GUIDE,
  WORKSPACE_RESTORE_TOOL_NAME,
  WORKSPACE_STATE_TOOL_NAME,
} from "@t3tools/shared/mutationWorkspace";
import { WORKSPACE_CHROME_GUIDE } from "@t3tools/shared/mutationWorkspaceChrome";
import { workspaceKit } from "@t3tools/workspace-kit";
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

// Order matters to agents: the cheapest path that fits comes first.
const WORKSPACE_BUILD_GUIDE = `Build it the fastest way that fits, in this order. 1) A template, when one matches the task: pass template: {id, options} and no html; it is a complete pro app ready in seconds, and options.customScript (JS run with (t3template, options)) bolts on anything it lacks. 2) Otherwise kit primitives plus glue: pass kit: [names] and write only the layout and wiring in html; T3 injects each primitive as window.t3kit.<name> before your scripts, at no cost to your output. 3) Only when neither covers the task, write the whole interface from scratch. Call ${WORKSPACE_KIT_DOCS_TOOL_NAME} with the names you will use for their exact APIs and options before writing glue; never hand-roll what a primitive does.\n${workspaceKit.catalog}`;

const WorkspaceMutateTool = Tool.make(WORKSPACE_MUTATE_TOOL_NAME, {
  description: `Transform this thread's interface into a workspace built for the user's task, replacing the chat view until the task is done. Use it for hands-on, iterative work on an artifact that the user will adjust by eye over several steps, in space or in time, which a dedicated professional application serves better than chat: grading or retouching a photo they attached or one on disk, cutting a video, mixing audio, exploring a dataset, laying out a design. Do not use it for a one-shot edit the user fully specified ("make it black and white", "trim the first five seconds"): make that edit with your own tools, and offer a workspace in your reply when fine-tuning by hand would help. ${WORKSPACE_BUILD_GUIDE}\nCalling it again rebuilds the workspace in place (the user's control state is kept), so iterate when the user asks for more tools. A page you write is one self-contained document with inline <style> and <script>; remote http(s) libraries load as-is. ${WORKSPACE_PAGE_GUIDE} ${HTML_RENDER_THEME_GUIDE} After calling it, reply briefly about what you built; the user is already looking at it. When the user is finished, call ${WORKSPACE_RESTORE_TOOL_NAME}. Declare the app's toolbar, sidebar, and inspector with \`chrome\` so T3 renders them natively and the page only needs its canvas or timeline.`,
  parameters: Schema.Struct({
    html: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000_000)),
    ).annotate({
      description:
        "A complete, self-contained HTML document for the workspace. Required unless you pass template, and not allowed with one.",
    }),
    template: Schema.optional(
      Schema.Struct({
        id: Schema.String.annotate({ description: "A template id from the catalog." }),
        options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
          description: `The template's options (see ${WORKSPACE_KIT_DOCS_TOOL_NAME}); omitted keys take their defaults.`,
        }),
      }),
    ).annotate({
      description:
        "Build the workspace from a kit template instead of html. Its primitives are injected for you.",
    }),
    kit: Schema.optional(Schema.Array(Schema.String)).annotate({
      description:
        "Kit primitive names to inject as window.t3kit.<name> before the page's scripts (added to a template's own); write only glue around them.",
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
    chrome: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
      description: WORKSPACE_CHROME_GUIDE,
    }),
  }),
  success: Schema.Struct({
    mutationWorkspace: Schema.Struct({
      attachmentId: Schema.String,
      title: Schema.String,
      assets: Schema.Array(Schema.Struct({ path: Schema.String, name: Schema.String })),
      chrome: Schema.optional(Schema.Unknown),
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

const WorkspaceKitDocsTool = Tool.make(WORKSPACE_KIT_DOCS_TOOL_NAME, {
  description: `Read the workspace kit's exact docs before building with ${WORKSPACE_MUTATE_TOOL_NAME}: each primitive's API header (create options, methods, events, a usage example) and each template's summary, kit, options with defaults, and examples. Pass the primitive names and template ids you plan to use; omit names for everything (large). Primitives: ${workspaceKit.primitiveNames.join(", ")}. Templates: ${workspaceKit.templateIds.join(", ") || "none installed yet"}.`,
  parameters: Schema.Struct({
    names: Schema.optional(Schema.Array(Schema.String)).annotate({
      description: "Primitive names and template ids to document.",
    }),
  }),
  success: Schema.Struct({
    primitives: Schema.Array(Schema.Struct({ name: Schema.String, docs: Schema.String })),
    templates: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        summary: Schema.String,
        kit: Schema.Array(Schema.String),
        options: Schema.Record(Schema.String, Schema.Unknown),
        examples: Schema.Array(Schema.Unknown),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read workspace kit docs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

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
  description: `Read the current control values of this thread's workspace: the last object its page stored with t3.workspace.setState, or {controls, page} for a workspace with chrome (controls are the native control values by id). Each message the user sends while the workspace is open already carries them in a <workspace_context> block, cut short when large; call this for the full state, or when a request depends on what they have set since (for example "apply this to the full-resolution file").`,
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
  WorkspaceKitDocsTool,
);
