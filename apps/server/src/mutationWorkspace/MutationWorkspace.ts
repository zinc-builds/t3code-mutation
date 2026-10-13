// @effect-diagnostics nodeBuiltinImport:off -- a synchronous sha256 keys the template page memo.
import * as NodeCrypto from "node:crypto";

import type { ThreadId } from "@t3tools/contracts";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as HeadlessChrome from "../htmlRender/headlessChrome.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import {
  injectValidationHost,
  shapeValidation,
  skippedValidation,
  VALIDATION_PROBLEM_PREFIXES,
  VALIDATION_SETTLED_EXPRESSION,
  validationAssetUrl,
  validationHostScript,
  type ValidationAsset,
  type WorkspaceValidation,
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
  /** The agent's chrome manifest, validated here; undefined for a bare page. */
  readonly chrome?: unknown;
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
// The page's own budget, from navigation to settled.
const VALIDATION_PAGE_BUDGET = "4 seconds";
// Everything else included: waiting for a browser slot, launching it, reading assets.
const VALIDATION_TIMEOUT = "7 seconds";
// Assembled template pages kept, by content hash.
const MAX_TEMPLATE_SHELLS = 16;

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
  const checkAssets = Effect.fn("MutationWorkspace.checkAssets")(function* (
    assetPaths: ReadonlyArray<string>,
  ) {
    const missing: Array<string> = [];
    for (const assetPath of assetPaths) {
      const info = path.isAbsolute(assetPath)
        ? yield* fileSystem.stat(assetPath).pipe(Effect.option)
        : undefined;
      if (info === undefined || info._tag === "None" || info.value.type !== "File") {
        missing.push(assetPath);
      }
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
      const size = Number((yield* fileSystem.stat(assetPath)).size);
      if (size > MAX_VALIDATION_ASSET_BYTES || total + size > MAX_VALIDATION_ASSETS_BYTES) {
        omitted.push(assetPath);
        continue;
      }
      total += size;
      const url = validationAssetUrl(assets.length);
      const mimeType =
        hostPreviewMimeTypeFromExtension(path.extname(assetPath)) ?? "application/octet-stream";
      resources.set(
        url,
        HeadlessChrome.servedResource(yield* fileSystem.readFile(assetPath), mimeType),
      );
      assets.push({ name: path.basename(assetPath), mimeType, path: assetPath, url });
    }
    return { assets, resources, omitted };
  });

  const validate = (input: {
    readonly html: string;
    readonly assetPaths: ReadonlyArray<string>;
    readonly chrome: WorkspaceChrome | undefined;
  }) =>
    Effect.gen(function* () {
      const { assets, resources, omitted } = yield* validationAssets(input.assetPaths);
      const host = validationHostScript({
        assets,
        controls: input.chrome === undefined ? {} : resolveWorkspaceChromeValues(input.chrome),
      });
      const observation = yield* htmlRender.observe({
        html: injectValidationHost(input.html, host),
        width: VALIDATION_WIDTH,
        resources,
        problemPrefixes: VALIDATION_PROBLEM_PREFIXES,
        settledExpression: VALIDATION_SETTLED_EXPRESSION,
        budget: VALIDATION_PAGE_BUDGET,
      });
      return shapeValidation(observation, omitted);
    }).pipe(
      Effect.timeoutOrElse({
        duration: VALIDATION_TIMEOUT,
        orElse: () =>
          Effect.succeed(
            skippedValidation(`the preview browser did not finish within ${VALIDATION_TIMEOUT}`),
          ),
      }),
      Effect.catch((cause) =>
        Effect.logWarning("Could not validate a workspace page; publishing it unchecked.", {
          cause,
        }).pipe(Effect.as(skippedValidation(cause.message))),
      ),
      Effect.withSpan("MutationWorkspace.validate"),
    );

  const publish = Effect.fn("MutationWorkspace.publish")(function* (input: WorkspacePublishInput) {
    const plan = kit.planPage({ html: input.html, kit: input.kit, template: input.template });
    if (!plan.ok) return yield* new WorkspaceKitInvalidError({ problem: plan.error });
    const chrome = input.chrome === undefined ? undefined : readWorkspaceChrome(input.chrome);
    if (chrome !== undefined && !chrome.ok) {
      return yield* new WorkspaceChromeInvalidError({ problem: chrome.error });
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
        validate({ html, assetPaths: input.assetPaths, chrome: chrome?.chrome }),
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

/** Builds workspaces from a given kit; tests pass a fixture kit. */
export const layerWithKit = (kit: WorkspaceKit) => Layer.effect(MutationWorkspace, make(kit));

export const layer = layerWithKit(workspaceKit);
