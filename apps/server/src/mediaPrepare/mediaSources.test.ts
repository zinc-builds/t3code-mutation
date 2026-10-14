import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandMediaSources } from "./mediaSources.ts";

it.layer(NodeServices.layer)("expandMediaSources", (it) => {
  it.effect("expands folders to their media, recursively, and keeps named files as given", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-" }));
      const write = (name: string) =>
        fs
          .makeDirectory(path.dirname(path.join(root, name)), { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(path.join(root, name), name)));
      yield* write("shoot/IMG_0151.MOV");
      yield* write("shoot/._IMG_0151.MOV");
      yield* write("shoot/notes.txt");
      yield* write("shoot/day2/voice.m4a");
      yield* write("shoot/.hidden/clip.mp4");
      yield* write("odd/recording.bin");
      yield* fs.makeDirectory(path.join(root, "empty"));

      const { sources, problems } = yield* expandMediaSources([
        path.join(root, "shoot"),
        path.join(root, "shoot", "IMG_0151.MOV"),
        path.join(root, "odd", "recording.bin"),
        path.join(root, "empty"),
        path.join(root, "missing.mov"),
      ]);

      expect(sources.map((source) => path.relative(root, source.path))).toEqual([
        path.join("shoot", "IMG_0151.MOV"),
        path.join("shoot", "day2", "voice.m4a"),
        path.join("odd", "recording.bin"),
      ]);
      expect(sources[0]!.size).toBe("shoot/IMG_0151.MOV".length);
      expect(sources[0]!.mtimeMs).toBeGreaterThan(0);
      expect(problems).toEqual([
        { path: path.join(root, "empty"), error: "This folder holds no video or audio files." },
        { path: path.join(root, "missing.mov"), error: "No file or folder exists at this path." },
      ]);
    }).pipe(Effect.scoped),
  );
});
