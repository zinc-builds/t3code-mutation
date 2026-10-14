/**
 * How a file a mutation workspace was handed is opened and typed. The asset
 * route serves `workspace-asset` resources through this, and publish-time
 * validation hands the page its assets through it too, so a file the client
 * could not load also fails validation.
 */
import {
  audioMimeTypeFromExtension,
  mediaMimeTypeFromExtension,
} from "@t3tools/shared/filePreview";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Mime from "effect/http/Mime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { openMediaFile, type OpenMediaFile } from "./MediaFile.ts";

const DOWNLOAD_MIME_TYPE_PATTERN = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;

/**
 * Whether a download may carry this Content-Type: not one a browser renders as
 * a document if a proxy strips the disposition header (HTML, any XML).
 */
export const isSafeDownloadMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) &&
  !/(?:^text\/html$|\/xml(?:$|-)|\+xml$)/i.test(mimeType.trim().toLowerCase());

/** How the asset route serves a workspace asset's bytes. */
export interface WorkspaceAssetContent {
  readonly mimeType: string;
  /** Served as an attachment with a sandboxing CSP; media is served inline as media files are. */
  readonly download: boolean;
}

/**
 * Images, video, and audio serve inline as media files do. Anything else (a
 * CSV, a JSON table, a page) downloads with its inferred type when that type is
 * download-safe, and as `application/octet-stream` otherwise, so it never
 * renders as a document.
 */
export function workspaceAssetContent(filePath: string): WorkspaceAssetContent {
  const dot = filePath.lastIndexOf(".");
  const extension = dot > filePath.search(/[^\\/]*$/) ? filePath.slice(dot) : "";
  const media = mediaMimeTypeFromExtension(extension) ?? audioMimeTypeFromExtension(extension);
  if (media !== null) return { mimeType: media, download: false };
  const inferred = Option.getOrUndefined(Mime.getType(filePath));
  return {
    mimeType:
      inferred !== undefined && isSafeDownloadMimeType(inferred)
        ? inferred
        : "application/octet-stream",
    download: true,
  };
}

/** A workspace asset opened for one read, by its canonical path. */
export interface OpenWorkspaceAsset extends WorkspaceAssetContent {
  readonly path: string;
  readonly file: OpenMediaFile;
}

/**
 * Opens an absolute path as a regular file through its canonical path, or
 * null when it is relative, missing, or not a regular file. With `identity`,
 * the path must already be canonical and still be that file.
 */
export const openWorkspaceAsset = Effect.fn("WorkspaceAssetFile.openWorkspaceAsset")(function* (
  filePath: string,
  identity?: { readonly device: string; readonly inode: string },
) {
  const path = yield* Path.Path;
  if (!path.isAbsolute(filePath)) return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const canonical = yield* fileSystem.realPath(filePath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(error),
    }),
  );
  if (Option.isNone(canonical)) return null;
  if (identity !== undefined && canonical.value !== filePath) return null;
  const file = yield* openMediaFile(canonical.value, identity);
  return file === null
    ? null
    : ({
        path: canonical.value,
        file,
        ...workspaceAssetContent(canonical.value),
      } satisfies OpenWorkspaceAsset);
});
