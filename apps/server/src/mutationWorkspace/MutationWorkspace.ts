// @effect-diagnostics nodeBuiltinImport:off -- a synchronous sha256 keys the template page memo.
import * as NodeCrypto from "node:crypto";

import type { ThreadId } from "@t3tools/contracts";
import {
  injectWorkspaceBridge,
  WORKSPACE_KIT_DOCS_TOOL_NAME,
  WORKSPACE_MAX_TITLE_LENGTH,
  type WorkspaceReference,
} from "@t3tools/shared/mutationWorkspace";
import {
  readWorkspaceChrome,
  resolveWorkspaceChromeValues,
  type WorkspaceChrome,
} from "@t3tools/shared/mutationWorkspaceChrome";
import {
  type KitDocs,
  type WorkspaceKit,
  type WorkspacePagePlan,
  templateOptionsTag,
  workspaceKit,
} from "@t3tools/workspace-kit";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { readMediaFileHeader } from "../assets/MediaFile.ts";
import { openWorkspaceAsset } from "../assets/WorkspaceAssetFile.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as HeadlessChrome from "../htmlRender/headlessChrome.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as FfmpegDryRun from "./FfmpegDryRun.ts";
import {
  defaultValidationLevel,
  exportFfmpegInputs,
  injectValidationHost,
  PageReport,
  shapeValidation,
  skippedValidation,
  VALIDATION_PROBLEM_PREFIXES,
  VALIDATION_SETTLED_EXPRESSION,
  validationAssetUrl,
  validationHostScript,
  validationReportExpression,
  type ValidationAsset,
  type WorkspaceValidation,
  type WorkspaceValidationLevel,
} from "./workspaceValidation.ts";

export class WorkspaceAssetNotFoundError extends Schema.TaggedError<WorkspaceAssetNotFoundError>()(
  "WorkspaceAssetNotFoundError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `These assets are not readable files: ${this.paths.join(", ")}. Pass absolute paths to existing files.`;
  }
}

export class WorkspaceChromeInvalidError extends Schema.TaggedError<WorkspaceChromeInvalidError>()(
  "WorkspaceChromeInvalidError",
  { problem: Schema.String },
) {
  override get message(): string {
    return `The chrome manifest is invalid: ${this.problem}. Fix it and call workspace_mutate again.`;
  }
}

export class WorkspaceKitInvalidError extends Schema.TaggedError<WorkspaceKitInvalidError>()(
  "WorkspaceKitInvalidError",
  { problem: Schema.String },
) {
  override get message(): string {
    return `${this.problem} Call ${WORKSPACE_KIT_DOCS_TOOL_NAME} for the exact names and options.`;
  }
}

export class WorkspaceStoreError extends Schema.TaggedError<WorkspaceStoreError>()(
  "WorkspaceStoreError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The workspace could not be stored.";
  }
}

export type WorkspacePublishError =
  | HtmlRender.HtmlRenderPrepareError
  | WorkspaceAssetNotFoundError
  | WorkspaceChromeInvalidError
  | WorkspaceKitInvalidError
  | WorkspaceStoreError;

/** What an agent asks `workspace_mutate` to build. */
export interface WorkspacePublishInput {
  readonly threadId: ThreadId;
  /** The agent's own page; absent when it builds from a template. */
  readonly html?: string | undefined;
  readonly title: string;
  readonly assetPaths: ReadonlyArray<string>;
  /** Kit primitives injected as `window.t3kit.<name>` before the page's scripts. */
  readonly kit?: ReadonlyArray<string> | undefined;
  /** A kit template that is the whole page, configured by its options. */
  readonly template?:
    | { readonly id: string; readonly options?: Readonly<Record<string, unknown>> | undefined }
    | undefined;
  /**
   * The agent's chrome manifest, validated here. Undefined means the
   * template's own manifest, if it declares one, or a bare page.
   */
  readonly chrome?: unknown;
  /** How far to check the page; undefined means `defaultValidationLevel`. */
  readonly validation?: WorkspaceValidationLevel | undefined;
}

/** A stored workspace, and what its page reported when T3 booted it. */
export interface WorkspacePublished {
  readonly reference: WorkspaceReference;
  readonly validation: WorkspaceValidation;
}

/**
 * Agent-built workspaces that replace a thread's chat interface, stored as
 * thread attachments like HTML renders.
 */
export class MutationWorkspace extends Context.Service<
  MutationWorkspace,
  {
    /**
     * Stores the page and, meanwhile, boots it in the preview browser to
     * collect its errors (skipped when the browser is not installed).
     */
    readonly publish: (
      input: WorkspacePublishInput,
    ) => Effect.Effect<WorkspacePublished, WorkspacePublishError>;
    /** Primitive docs headers and template options; `names` omitted means everything. */
    readonly kitDocs: (
      names?: ReadonlyArray<string>,
    ) => Effect.Effect<KitDocs, WorkspaceKitInvalidError>;
  }
>()("t3/mutationWorkspace/MutationWorkspace") {}

const MIB = 1024 * 1024;
// Validation hands assets to the page over the browser's pipe, so it stops at a size
// a quick boot can carry; larger ones are left out and named in the result.
const MAX_VALIDATION_ASSET_BYTES = 32 * MIB;
const MAX_VALIDATION_ASSETS_BYTES = 64 * MIB;
const VALIDATION_WIDTH = 1_280;
// The page's own budget, from navigation to settled, and then everything else
// included: waiting for a browser slot, launching it, reading assets. A full
// check gives a slow page (a photo developed in software WebGL) longer to boot,
// since it cannot export before then.
const VALIDATION_PAGE_BUDGET = { boot: "4 seconds", full: "6 seconds" } as const;
const VALIDATION_TIMEOUT = { boot: "7 seconds", full: "9 seconds" } as const;
// At level `full`, the export's own budget once the page has settled, and the
// dry runs' after it. Validation as a whole takes at most the sum of the three.
const VALIDATION_EXPORT_BUDGET = "6 seconds";
const VALIDATION_FFMPEG_BUDGET = "4 seconds";
// A boot-only report is a synchronous read of what the stand-in recorded.
const VALIDATION_REPORT_BUDGET = "1 second";
const decodePageReport = Schema.decodeUnknownEffect(PageReport);
const totalOf = (...budgets: ReadonlyArray<Duration.Input>) =>
  Duration.millis(budgets.reduce<number>((total, budget) => total + Duration.toMillis(budget), 0));
// Assembled template pages kept, by content hash.
const MAX_TEMPLATE_SHELLS = 16;

/** A stored page to validate, and what it was built with. */
interface ValidationInput {
  readonly html: string;
  readonly level: WorkspaceValidationLevel;
  readonly template: boolean;
  readonly assetPaths: ReadonlyArray<string>;
  readonly chrome: WorkspaceChrome | undefined;
}

/** A template page assembled once: everything before and after its options tag. */
interface TemplateShell {
  readonly before: string;
  readonly after: string;
}

const templateShellKey = (plan: WorkspacePagePlan) =>
  NodeCrypto.createHash("sha256")
    .update(plan.html)
    .update("\0")
    .update(plan.primitives.map((primitive) => primitive.name).join(","))
    .digest("hex");

const make = Effect.fn("MutationWorkspace.make")(function* (kit: WorkspaceKit) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const htmlRender = yield* HtmlRender.HtmlRender;
  const ffmpegDryRun = yield* FfmpegDryRun.FfmpegDryRun;
  const openAsset = (assetPath: string) =>
    openWorkspaceAsset(assetPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  // Each asset is opened the way the asset route serves it to the workspace,
  // so a file the client could not load is refused here.
  const checkAssets = Effect.fn("MutationWorkspace.checkAssets")(function* (
    assetPaths: ReadonlyArray<string>,
  ) {
    const missing: Array<string> = [];
    for (const assetPath of assetPaths) {
      const readable = yield* openAsset(assetPath).pipe(
        Effect.map((asset) => asset !== null),
        Effect.scoped,
        // A file that fails to open (no read permission) is one the route refuses too.
        Effect.orElseSucceed(() => false),
      );
      if (!readable) missing.push(assetPath);
    }
    if (missing.length > 0) return yield* new WorkspaceAssetNotFoundError({ paths: missing });
  });

  // Kit sources go in after prepare, so they never count against the page's limits.
  // Each injector inserts at the head start: the bridge, then the kit, then the page.
  const assemble = (plan: WorkspacePagePlan) =>
    htmlRender
      .prepare(plan.html)
      .pipe(Effect.map((prepared) => injectWorkspaceBridge(kit.inject(prepared, plan))));

  // A template page differs between publishes only in its options, so everything
  // around the options tag is assembled once per template and kit.
  const templateShells = new Map<string, TemplateShell>();
  const templateShell = Effect.fn("MutationWorkspace.templateShell")(function* (
    plan: WorkspacePagePlan & { readonly template: NonNullable<WorkspacePagePlan["template"]> },
  ) {
    const key = templateShellKey(plan);
    const cached = templateShells.get(key);
    if (cached !== undefined) {
      // Newest last, so the first key is the one to evict.
      templateShells.delete(key);
      templateShells.set(key, cached);
      return cached;
    }
    const page = yield* assemble({ ...plan, template: { ...plan.template, options: {} } });
    const emptyTag = templateOptionsTag({});
    const at = page.indexOf(emptyTag);
    if (at === -1) return yield* Effect.die(new Error("The template page lost its options tag."));
    const shell = { before: page.slice(0, at), after: page.slice(at + emptyTag.length) };
    templateShells.set(key, shell);
    if (templateShells.size > MAX_TEMPLATE_SHELLS) {
      templateShells.delete(templateShells.keys().next().value!);
    }
    return shell;
  });

  const assemblePage = (plan: WorkspacePagePlan) => {
    const template = plan.template;
    return template === undefined
      ? assemble(plan)
      : templateShell({ ...plan, template }).pipe(
          Effect.map((shell) => shell.before + templateOptionsTag(template.options) + shell.after),
        );
  };

  /** The assets validation can hand the page, served from its own origin, and the ones left out. */
  const validationAssets = Effect.fn("MutationWorkspace.validationAssets")(function* (
    assetPaths: ReadonlyArray<string>,
  ) {
    const assets: Array<ValidationAsset> = [];
    const resources = new Map<string, HeadlessChrome.ServedResource>();
    const omitted: Array<string> = [];
    let total = 0;
    for (const assetPath of assetPaths) {
      // Read and typed as the asset route serves it to the client's host.
      const served = yield* Effect.scoped(
        Effect.gen(function* () {
          const asset = yield* openAsset(assetPath);
          if (asset === null) return yield* new WorkspaceAssetNotFoundError({ paths: [assetPath] });
          const size = Number(asset.file.info.size);
          if (size > MAX_VALIDATION_ASSET_BYTES || total + size > MAX_VALIDATION_ASSETS_BYTES) {
            return null;
          }
          total += size;
          const bytes = yield* readMediaFileHeader(asset.path, asset.file, size);
          return { mimeType: asset.mimeType, bytes };
        }),
      );
      if (served === null) {
        omitted.push(assetPath);
        continue;
      }
      const url = validationAssetUrl(assets.length);
      resources.set(url, HeadlessChrome.servedResource(served.bytes, served.mimeType));
      assets.push({
        name: path.basename(assetPath),
        mimeType: served.mimeType,
        path: assetPath,
        url,
      });
    }
    return { assets, resources, omitted };
  });

  /** Boots the page, then at level `full` runs its export; bounded by the three budgets. */
  const observe = (input: ValidationInput) =>
    Effect.gen(function* () {
      const { assets, resources, omitted } = yield* validationAssets(input.assetPaths);
      const host = validationHostScript({
        assets,
        controls: input.chrome === undefined ? {} : resolveWorkspaceChromeValues(input.chrome),
        template: input.template,
        chrome: input.chrome !== undefined,
      });
      const observation = yield* htmlRender.observe({
        html: injectValidationHost(input.html, host),
        width: VALIDATION_WIDTH,
        resources,
        problemPrefixes: VALIDATION_PROBLEM_PREFIXES,
        settledExpression: VALIDATION_SETTLED_EXPRESSION,
        budget: VALIDATION_PAGE_BUDGET[input.level],
        probe: {
          expression: validationReportExpression(input.level),
          budget: input.level === "full" ? VALIDATION_EXPORT_BUDGET : VALIDATION_REPORT_BUDGET,
        },
      });
      const probed = Option.flatMap(observation, (page) =>
        page.probe === undefined ? Option.none() : page.probe.value,
      );
      const report = Option.isNone(probed) ? undefined : yield* decodePageReport(probed.value);
      return { observation, report, omitted };
    }).pipe(
      Effect.timeoutOption(
        totalOf(
          VALIDATION_TIMEOUT[input.level],
          input.level === "full" ? VALIDATION_EXPORT_BUDGET : VALIDATION_REPORT_BUDGET,
        ),
      ),
    );

  const validate = (input: ValidationInput) =>
    Effect.gen(function* () {
      const observed = yield* observe(input);
      if (Option.isNone(observed)) {
        return skippedValidation(
          input.level,
          `the preview browser did not finish within ${VALIDATION_TIMEOUT[input.level]}`,
        );
      }
      const { observation, report, omitted } = observed.value;
      const { commands, files } =
        report === undefined ? { commands: [], files: [] } : exportFfmpegInputs(report);
      const ffmpeg =
        commands.length === 0
          ? undefined
          : yield* ffmpegDryRun
              .dryRun({
                commands,
                assetPaths: input.assetPaths,
                files,
                budget: VALIDATION_FFMPEG_BUDGET,
              })
              // The dry run stops each command at its budget; this bounds the setup around them.
              .pipe(
                Effect.timeoutOption(totalOf(VALIDATION_FFMPEG_BUDGET, "1 second")),
                Effect.map(Option.getOrUndefined),
              );
      return shapeValidation({
        level: input.level,
        observation,
        report,
        ffmpeg,
        chrome: input.chrome,
        omittedAssets: omitted,
        pageBudget: VALIDATION_PAGE_BUDGET[input.level],
        exportBudget: VALIDATION_EXPORT_BUDGET,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not validate a workspace page; publishing it unchecked.", {
          cause,
        }).pipe(Effect.as(skippedValidation(input.level, cause.message))),
      ),
      Effect.withSpan("MutationWorkspace.validate"),
    );

  const publish = Effect.fn("MutationWorkspace.publish")(function* (input: WorkspacePublishInput) {
    const plan = kit.planPage({ html: input.html, kit: input.kit, template: input.template });
    if (!plan.ok) return yield* new WorkspaceKitInvalidError({ problem: plan.error });
    // The agent's manifest replaces the template's own, as a whole.
    const chromeInput = input.chrome ?? plan.value.template?.chrome;
    const chrome = chromeInput === undefined ? undefined : readWorkspaceChrome(chromeInput);
    if (chrome !== undefined && !chrome.ok) {
      return yield* new WorkspaceChromeInvalidError({
        problem:
          input.chrome === undefined
            ? `template "${plan.value.template?.id}" declares chrome T3 rejects (${chrome.error}); pass your own chrome`
            : chrome.error,
      });
    }
    yield* checkAssets(input.assetPaths);
    const html = yield* assemblePage(plan.value);
    // The `-html` id suffix makes the asset route serve it as a sandboxed text/html document.
    const attachmentId = createAttachmentId(input.threadId, "html");
    const filePath =
      attachmentId === null
        ? null
        : resolveAttachmentRelativePath({
            attachmentsDir: config.attachmentsDir,
            relativePath: `${attachmentId}.html`,
          });
    if (attachmentId === null || filePath === null) {
      return yield* new WorkspaceStoreError({ cause: new Error("Invalid thread id.") });
    }
    const [, validation] = yield* Effect.all(
      [
        fileSystem
          .writeFileString(filePath, html)
          .pipe(Effect.mapError((cause) => new WorkspaceStoreError({ cause }))),
        validate({
          html,
          level: input.validation ?? defaultValidationLevel(plan.value.template),
          template: plan.value.template !== undefined,
          assetPaths: input.assetPaths,
          chrome: chrome?.chrome,
        }),
      ],
      { concurrency: 2 },
    );
    const reference = {
      attachmentId,
      title: input.title.trim().slice(0, WORKSPACE_MAX_TITLE_LENGTH) || "Workspace",
      assets: input.assetPaths.map((assetPath) => ({
        path: assetPath,
        name: path.basename(assetPath),
      })),
      ...(chrome === undefined ? {} : { chrome: chrome.chrome }),
    } satisfies WorkspaceReference;
    return { reference, validation } satisfies WorkspacePublished;
  });

  const kitDocs = (names?: ReadonlyArray<string>) => {
    const docs = kit.docs(names);
    return docs.ok
      ? Effect.succeed(docs.value)
      : Effect.fail(new WorkspaceKitInvalidError({ problem: docs.error }));
  };

  return MutationWorkspace.of({ publish, kitDocs });
});

/** Builds workspaces from a given kit; tests pass a fixture kit and their own dry run. */
export const layerWithKit = (kit: WorkspaceKit) => Layer.effect(MutationWorkspace, make(kit));

export const layer = layerWithKit(workspaceKit).pipe(Layer.provide(FfmpegDryRun.layer));
