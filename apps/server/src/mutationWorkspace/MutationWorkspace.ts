import type { ThreadId } from "@t3tools/contracts";
import {
  injectWorkspaceBridge,
  WORKSPACE_KIT_DOCS_TOOL_NAME,
  WORKSPACE_MAX_TITLE_LENGTH,
  type WorkspaceReference,
} from "@t3tools/shared/mutationWorkspace";
import { readWorkspaceChrome } from "@t3tools/shared/mutationWorkspaceChrome";
import { type KitDocs, type WorkspaceKit, workspaceKit } from "@t3tools/workspace-kit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";

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

/**
 * Agent-built workspaces that replace a thread's chat interface, stored as
 * thread attachments like HTML renders.
 */
export class MutationWorkspace extends Context.Service<
  MutationWorkspace,
  {
    readonly publish: (
      input: WorkspacePublishInput,
    ) => Effect.Effect<WorkspaceReference, WorkspacePublishError>;
    /** Primitive docs headers and template options; `names` omitted means everything. */
    readonly kitDocs: (
      names?: ReadonlyArray<string>,
    ) => Effect.Effect<KitDocs, WorkspaceKitInvalidError>;
  }
>()("t3/mutationWorkspace/MutationWorkspace") {}

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

  const publish = Effect.fn("MutationWorkspace.publish")(function* (input: WorkspacePublishInput) {
    const plan = kit.planPage({ html: input.html, kit: input.kit, template: input.template });
    if (!plan.ok) return yield* new WorkspaceKitInvalidError({ problem: plan.error });
    const chrome = input.chrome === undefined ? undefined : readWorkspaceChrome(input.chrome);
    if (chrome !== undefined && !chrome.ok) {
      return yield* new WorkspaceChromeInvalidError({ problem: chrome.error });
    }
    yield* checkAssets(input.assetPaths);
    // Kit sources go in after prepare, so they never count against the page's limits.
    // Each injector inserts at the head start: the bridge, then the kit, then the page.
    const prepared = yield* htmlRender.prepare(plan.value.html);
    const html = injectWorkspaceBridge(kit.inject(prepared, plan.value));
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
    yield* fileSystem
      .writeFileString(filePath, html)
      .pipe(Effect.mapError((cause) => new WorkspaceStoreError({ cause })));
    return {
      attachmentId,
      title: input.title.trim().slice(0, WORKSPACE_MAX_TITLE_LENGTH) || "Workspace",
      assets: input.assetPaths.map((assetPath) => ({
        path: assetPath,
        name: path.basename(assetPath),
      })),
      ...(chrome === undefined ? {} : { chrome: chrome.chrome }),
    } satisfies WorkspaceReference;
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
