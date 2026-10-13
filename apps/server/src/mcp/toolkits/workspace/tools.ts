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
import { WORKSPACE_VALIDATION_LEVELS } from "../../../mutationWorkspace/workspaceValidation.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  MutationWorkspace.MutationWorkspace,
  WorkspaceState.WorkspaceState,
];

// Order matters to agents: the cheapest path that fits comes first.
const WORKSPACE_BUILD_GUIDE = `Build it the fastest way that fits, in this order. 1) A template, when one matches the task: pass template: {id, options} and no html; it is a complete pro app ready in seconds, and options.customScript (JS run with (t3template, options)) bolts on anything it lacks, using only the calls in that template's boltOn docs. 2) Otherwise kit primitives plus glue: pass kit: [names] and write only the layout and wiring in html; T3 injects each primitive as window.t3kit.<name> before your scripts, at no cost to your output. 3) Only when neither covers the task, write the whole interface from scratch. Call ${WORKSPACE_KIT_DOCS_TOOL_NAME} with the names you will use for their exact APIs and options before writing glue; never hand-roll what a primitive does.\n${workspaceKit.catalog}`;

const WorkspaceMutateTool = Tool.make(WORKSPACE_MUTATE_TOOL_NAME, {
  description: `Transform this thread's interface into a workspace built for the user's task, replacing the chat view until the task is done. Use it for hands-on, iterative work on an artifact that the user will adjust by eye over several steps, in space or in time, which a dedicated professional application serves better than chat: grading or retouching a photo they attached or one on disk, cutting a video, mixing audio, exploring a dataset, laying out a design. Do not use it for a one-shot edit the user fully specified ("make it black and white", "trim the first five seconds"): make that edit with your own tools, and offer a workspace in your reply when fine-tuning by hand would help. ${WORKSPACE_BUILD_GUIDE}\nCalling it again rebuilds the workspace in place (the user's control state is kept), so iterate when the user asks for more tools. A page you write is one self-contained document with inline <style> and <script>; remote http(s) libraries load as-is. ${WORKSPACE_PAGE_GUIDE} ${HTML_RENDER_THEME_GUIDE} T3 boots the published page itself (and, at validation "full", runs its export) and returns what broke in the result's validation, so do not screenshot or test it yourself; when validation lists errors, fix them with another call. After calling it, reply briefly about what you built; the user is already looking at it. When the user is finished, call ${WORKSPACE_RESTORE_TOOL_NAME}. Declare the app's toolbar, sidebar, and inspector with \`chrome\` so T3 renders them natively and the page only needs its canvas or timeline.`,
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
      description: `${WORKSPACE_CHROME_GUIDE} A template that declares its own chrome gets it when you omit this; passing chrome replaces the template's.`,
    }),
    preview: Schema.optional(
      Schema.Struct({
        url: Schema.String.annotate({
          description: "Absolute http(s) URL, such as http://localhost:5173/.",
        }),
      }),
    ).annotate({
      description:
        "A live web page the workspace reviews, usually the user's dev server for a design review. The page reaches it through t3.workspace.preview; it may open any URL on this origin, and no other.",
    }),
    validation: Schema.optional(Schema.Literals(WORKSPACE_VALIDATION_LEVELS)).annotate({
      description:
        'How far T3 checks the page before returning. "boot" loads it with your assets for a few seconds and reports uncaught exceptions, console errors, customScript failures, and setChrome patches T3 would reject. "full" then also calls window.t3template.export() (up to 6 s; its files are captured, not delivered to the user) and dry-runs each ffmpeg command the export returns against your assets with this machine\'s ffmpeg (0.5 s of output each, up to 4 s in all; skipped when ffmpeg is not installed). Default: "full" for a template with options.customScript, since bolt-ons most often break an export that loads fine; "boot" otherwise. Pass "full" after changing what an export reads; pass "boot" to skip the export while iterating on layout.',
    }),
  }),
  success: Schema.Struct({
    mutationWorkspace: Schema.Struct({
      attachmentId: Schema.String,
      title: Schema.String,
      assets: Schema.Array(Schema.Struct({ path: Schema.String, name: Schema.String })),
      chrome: Schema.optional(Schema.Unknown),
      preview: Schema.optional(Schema.Struct({ url: Schema.String })),
    }),
    validation: Schema.Struct({
      level: Schema.Literals(WORKSPACE_VALIDATION_LEVELS),
      ok: Schema.Boolean,
      errors: Schema.Array(
        Schema.Struct({
          source: Schema.Literals([
            "customScript",
            "exception",
            "console",
            "export",
            "ffmpeg",
            "chrome",
          ]),
          message: Schema.String,
        }),
      ),
      moreErrors: Schema.optional(Schema.Number),
      skipped: Schema.optional(Schema.String),
      omittedAssets: Schema.optional(Schema.Array(Schema.String)),
      export: Schema.optional(
        Schema.Struct({
          skipped: Schema.optional(Schema.String),
          files: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              type: Schema.String,
              size: Schema.Number,
              width: Schema.optional(Schema.Number),
              height: Schema.optional(Schema.Number),
            }),
          ),
          ffmpeg: Schema.optional(
            Schema.Array(
              Schema.Struct({
                command: Schema.Number,
                status: Schema.Literals(["ok", "failed", "not-run"]),
                reason: Schema.optional(Schema.String),
              }),
            ),
          ),
          ffmpegSkipped: Schema.optional(Schema.String),
        }),
      ),
    }).annotate({
      description:
        "What the page reported when T3 booted it with your assets for a few seconds and, at level full, ran its export: uncaught exceptions, console errors, a template's customScript failures, setChrome patches T3 rejects (chrome), export() failures and unreadable files (export), and ffmpeg dry-run failures with ffmpeg's stderr (ffmpeg). export lists the files produced, with pixel sizes for images, and each ffmpeg command's dry run. ok means no errors were seen; skipped says why the page was not checked.",
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
  description: `Read the workspace kit's exact docs before building with ${WORKSPACE_MUTATE_TOOL_NAME}: each primitive's API header (create options, methods, events, a usage example) and each template's summary, kit, options with defaults, examples, and boltOn: the exact window.t3template API for options.customScript (summary, one line per call, reservedShortcuts, a runnable example). Read a template's boltOn before writing its customScript; do not guess calls. Pass the primitive names and template ids you plan to use; omit names for everything (large). Primitives: ${workspaceKit.primitiveNames.join(", ")}. Templates: ${workspaceKit.templateIds.join(", ") || "none installed yet"}.`,
  parameters: Schema.Struct({
    names: Schema.optional(Schema.Array(Schema.String)).annotate({
      description: "Primitive names and template ids to document.",
    }),
  }),
  success: Schema.Struct({
    primitives: Schema.Array(Schema.Struct({ name: Schema.String, docs: Schema.String })),
    // Each template's manifest as written: fields beyond these reach the agent too.
    templates: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          summary: Schema.String,
          kit: Schema.Array(Schema.String),
          options: Schema.Record(Schema.String, Schema.Unknown),
          examples: Schema.Array(Schema.Unknown),
          boltOn: Schema.StructWithRest(
            Schema.Struct({
              summary: Schema.String,
              api: Schema.Array(Schema.String),
              reservedShortcuts: Schema.Array(Schema.String),
              example: Schema.String,
            }),
            [Schema.Record(Schema.String, Schema.Unknown)],
          ),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
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
