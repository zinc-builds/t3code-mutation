import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  WORKSPACE_KIT_DOCS_TOOL_NAME,
  WORKSPACE_MAX_ASSETS,
  WORKSPACE_MAX_TITLE_LENGTH,
  WORKSPACE_MUTATE_TOOL_NAME,
  WORKSPACE_RESTORE_TOOL_NAME,
  WORKSPACE_STATE_TOOL_NAME,
} from "@t3tools/shared/mutationWorkspace";
import { workspaceKit } from "@t3tools/workspace-kit";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as MutationWorkspace from "../../../mutationWorkspace/MutationWorkspace.ts";
import * as WorkspaceState from "../../../mutationWorkspace/WorkspaceState.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { WORKSPACE_VALIDATION_LEVELS } from "../../../mutationWorkspace/workspaceValidation.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { WORKSPACE_GUIDES } from "./guides.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  MutationWorkspace.MutationWorkspace,
  WorkspaceState.WorkspaceState,
];

const WorkspaceMutateTool = Tool.make(WORKSPACE_MUTATE_TOOL_NAME, {
  description: `Replace this thread's chat view with a workspace built for the user's task, until they are done. Use it for hands-on, iterative work the user will adjust by eye, which a dedicated application serves better than chat: grading a photo, cutting a video, mixing audio, exploring a dataset, laying out a design. Not for a one-shot edit they fully specified: make that with your own tools and offer a workspace in your reply. Prefer template: {id} when one fits, which is ready in seconds: ${workspaceKit.templateIds.join(", ")}. For anything else, first call ${WORKSPACE_KIT_DOCS_TOOL_NAME} with no arguments for the catalog and guides, and read page-guide before writing html. Calling this again rebuilds in place and keeps the user's control state. T3 tests the page itself and returns what broke in validation; fix listed errors with another call. Then reply briefly, because the user is already looking at it, and call ${WORKSPACE_RESTORE_TOOL_NAME} when they are finished.`,
  parameters: Schema.Struct({
    html: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000_000)),
    ).annotate({
      description:
        "A complete, self-contained HTML document for the workspace. Required unless you pass template, and not allowed with one.",
    }),
    template: Schema.optional(
      Schema.Struct({
        id: Schema.String.annotate({ description: "A template id." }),
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
      description: `Native toolbar, sidebar and inspector. See chrome-guide in ${WORKSPACE_KIT_DOCS_TOOL_NAME}.`,
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
      description: `"boot" loads the page; "full" also runs its export. See validation-guide in ${WORKSPACE_KIT_DOCS_TOOL_NAME}.`,
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
      notValidated: Schema.optional(Schema.Array(Schema.String)),
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
  description: `Workspace docs, in tiers. No arguments: the catalog of templates by category, kit primitives, and guide names. With names: the full docs for those templates (options, examples, boltOn, the exact window.t3template API for options.customScript; read it before writing one), primitives (API, usage), and guides (${Object.keys(WORKSPACE_GUIDES).join(", ")}).`,
  parameters: Schema.Struct({
    names: Schema.optional(Schema.Array(Schema.String)).annotate({
      description: "Template ids, primitive names and guide names to read.",
    }),
  }),
  success: Schema.Struct({
    catalog: Schema.optional(Schema.String),
    guides: Schema.Array(Schema.Struct({ name: Schema.String, docs: Schema.String })),
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
