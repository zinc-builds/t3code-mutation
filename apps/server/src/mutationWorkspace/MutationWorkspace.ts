import type { ThreadId } from "@t3tools/contracts";
import {
  injectWorkspaceBridge,
  WORKSPACE_MAX_TITLE_LENGTH,
  type WorkspaceReference,
} from "@t3tools/shared/mutationWorkspace";
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
  | WorkspaceStoreError;

/**
 * Agent-built workspaces that replace a thread's chat interface, stored as
 * thread attachments like HTML renders.
 */
export class MutationWorkspace extends Context.Service<
  MutationWorkspace,
  {
    readonly publish: (input: {
      readonly threadId: ThreadId;
      readonly html: string;
      readonly title: string;
      readonly assetPaths: ReadonlyArray<string>;
    }) => Effect.Effect<WorkspaceReference, WorkspacePublishError>;
  }
>()("t3/mutationWorkspace/MutationWorkspace") {}

const make = Effect.gen(function* () {
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

  const publish = Effect.fn("MutationWorkspace.publish")(function* (input: {
    readonly threadId: ThreadId;
    readonly html: string;
    readonly title: string;
    readonly assetPaths: ReadonlyArray<string>;
  }) {
    yield* checkAssets(input.assetPaths);
    const html = injectWorkspaceBridge(yield* htmlRender.prepare(input.html));
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
    } satisfies WorkspaceReference;
  });

  return MutationWorkspace.of({ publish });
});

export const layer = Layer.effect(MutationWorkspace, make);
