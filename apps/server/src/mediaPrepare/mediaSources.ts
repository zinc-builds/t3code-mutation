import { audioMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import { VIDEO_FILE_EXTENSIONS } from "@t3tools/shared/video";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

/** Folders expand to the files a workspace can play: the extensions T3 serves as video or audio. */
const isMediaFileName = (name: string) => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const extension = name.slice(dot).toLowerCase();
  return (
    VIDEO_FILE_EXTENSIONS.includes(extension.slice(1)) ||
    audioMimeTypeFromExtension(extension) !== null
  );
};

/** One source file, by its canonical path, with what its cache key needs. */
export interface MediaSource {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** A path the agent named that yielded no source. */
interface MediaSourceProblem {
  readonly path: string;
  readonly error: string;
}

interface ExpandedSources {
  readonly sources: ReadonlyArray<MediaSource>;
  readonly problems: ReadonlyArray<MediaSourceProblem>;
}

/**
 * Turns the agent's paths into source files. A file is taken as named, whatever
 * its extension, since ffprobe decides what it holds; a folder yields its media
 * files, recursively, skipping dot-files such as the `._IMG_0151.MOV`
 * AppleDouble files exFAT drives carry. Paths resolve through symlinks, and a
 * file named twice appears once. Paths that yield nothing are problems, not
 * failures, so one bad path does not cost the rest.
 */
export const expandMediaSources = Effect.fn("mediaSources.expand")(function* (
  paths: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sources = new Map<string, MediaSource>();
  const problems: Array<MediaSourceProblem> = [];

  const statOrNone = (target: string) =>
    fs.stat(target).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(error),
      }),
    );

  // The modification time keys the cache, so a file without one is a problem, not a stale hit.
  const addFile = (canonical: string, info: FileSystem.File.Info) => {
    if (Option.isNone(info.mtime)) {
      problems.push({
        path: canonical,
        error: "The filesystem reports no modification time for this file.",
      });
      return;
    }
    sources.set(canonical, {
      path: canonical,
      size: Number(info.size),
      mtimeMs: info.mtime.value.getTime(),
    });
  };

  const walk: (directory: string) => Effect.Effect<number, PlatformError.PlatformError> =
    Effect.fnUntraced(function* (directory: string) {
      const names = (yield* fs.readDirectory(directory)).toSorted();
      let found = 0;
      for (const name of names) {
        if (name.startsWith(".")) continue;
        const child = path.join(directory, name);
        const info = yield* statOrNone(child);
        if (Option.isNone(info)) continue;
        if (info.value.type === "Directory") {
          found += yield* walk(child);
        } else if (info.value.type === "File" && isMediaFileName(name)) {
          addFile(child, info.value);
          found += 1;
        }
      }
      return found;
    });

  for (const given of paths) {
    const canonical = yield* fs.realPath(given).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(error),
      }),
    );
    if (Option.isNone(canonical)) {
      problems.push({ path: given, error: "No file or folder exists at this path." });
      continue;
    }
    const info = yield* fs.stat(canonical.value);
    if (info.type === "File") {
      addFile(canonical.value, info);
    } else if (info.type === "Directory") {
      const found = yield* walk(canonical.value);
      if (found === 0) {
        problems.push({ path: given, error: "This folder holds no video or audio files." });
      }
    } else {
      problems.push({ path: given, error: "This is neither a file nor a folder." });
    }
  }
  return {
    sources: [...sources.values()],
    problems,
  } satisfies ExpandedSources;
});
