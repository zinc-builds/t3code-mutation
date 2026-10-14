import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../processRunner.ts";
import * as MediaPrepare from "./MediaPrepare.ts";
import * as PhononRuntime from "./PhononRuntime.ts";
import { decodeTranscriptFile, type WorkerTranscript } from "./transcriptFile.ts";

const WITH_AUDIO = JSON.stringify({
  format: { duration: "4.25" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" },
    { codec_type: "audio", codec_name: "aac" },
  ],
});
const SILENT = JSON.stringify({
  format: { duration: "2" },
  streams: [{ codec_type: "video", codec_name: "h264", width: 640, height: 480 }],
});

/** A PATH holding stand-ins for ffprobe (answering by file name) and ffmpeg. */
const fakeTools = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bin = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-bin-" });
  const ffprobe = [
    "#!/bin/sh",
    "for last; do :; done",
    'case "$last" in',
    `  *silent*) echo '${SILENT}' ;;`,
    '  *broken*) echo "Invalid data found when processing input" >&2; exit 1 ;;',
    `  *) echo '${WITH_AUDIO}' ;;`,
    "esac",
    "",
  ].join("\n");
  yield* fs.writeFileString(path.join(bin, "ffprobe"), ffprobe);
  yield* fs.writeFileString(path.join(bin, "ffmpeg"), "#!/bin/sh\nexit 0\n");
  yield* fs.chmod(path.join(bin, "ffprobe"), 0o755);
  yield* fs.chmod(path.join(bin, "ffmpeg"), 0o755);
  return bin;
});

const transcriptOf = (text: string): WorkerTranscript => ({
  text,
  segments: [{ start: 0.1234, end: 1.5, text }],
  words: text
    .split(" ")
    .map((word, index) => ({ start: index * 0.5, end: index * 0.5 + 0.4, text: word })),
  audioSeconds: 4.25,
  decodeSeconds: 0.1,
  truncated: false,
});

const makeHarness = Effect.fn("test.makeMediaPrepareHarness")(function* (options?: {
  readonly hold?: Deferred.Deferred<void>;
  readonly started?: Deferred.Deferred<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-" }));
  const media = path.join(root, "media");
  const cacheDir = path.join(root, "cache");
  yield* fs.makeDirectory(media);
  const calls: Array<PhononRuntime.TranscribeRequest> = [];
  const runtime = PhononRuntime.PhononRuntime.of({
    transcribe: (request) =>
      Effect.gen(function* () {
        calls.push(request);
        if (options?.started !== undefined) yield* Deferred.succeed(options.started, undefined);
        if (options?.hold !== undefined) yield* Deferred.await(options.hold);
        if (request.path.includes("garbled")) {
          return yield* new PhononRuntime.PhononTranscribeError({ reason: "the decoder gave up." });
        }
        return transcriptOf(`words of ${path.basename(request.path)}`);
      }),
    activity: Effect.succeedSome("installing the transcription runtime"),
  });
  const service = yield* MediaPrepare.makeMediaPrepare({ cacheDir }).pipe(
    Effect.provideService(PhononRuntime.PhononRuntime, runtime),
    Effect.provide(ProcessRunner.layer),
  );
  const bin = yield* fakeTools;
  const prepare = (
    input: Partial<MediaPrepare.MediaPrepareInput> & { readonly paths: ReadonlyArray<string> },
    searchPath = bin,
  ) =>
    service
      .prepare({ transcribe: true, hotwords: [], ...input })
      .pipe(Effect.provideService(HostProcess.Environment, { PATH: searchPath }));
  return { fs, path, media, cacheDir, calls, prepare };
});

it.layer(NodeServices.layer)("MediaPrepare", (it) => {
  it.effect("writes one transcript per source in the cache, never beside the media", () =>
    Effect.gen(function* () {
      const { fs, path, media, cacheDir, calls, prepare } = yield* makeHarness();
      yield* fs.writeFileString(path.join(media, "IMG_0151.MOV"), "video");
      yield* fs.writeFileString(path.join(media, "silent.mp4"), "video");

      const result = yield* prepare({ paths: [media], hotwords: ["Quillon"] });

      expect(result.pending).toEqual([]);
      const [clip, silent] = result.files;
      expect(silent).toEqual({
        source: path.join(media, "silent.mp4"),
        duration: 2,
        width: 640,
        height: 480,
        codec: "h264",
        hasAudio: false,
      });
      assert.isDefined(clip?.transcript);
      expect(clip).toMatchObject({
        source: path.join(media, "IMG_0151.MOV"),
        duration: 4.25,
        fps: 30,
        hasAudio: true,
        words: 3,
      });
      expect(clip!.transcript!.startsWith(`${cacheDir}${path.sep}`)).toBe(true);
      expect(path.basename(clip!.transcript!)).toBe("IMG_0151.transcript.json");
      expect(calls.map((call) => [path.basename(call.path), call.hotwords])).toEqual([
        ["IMG_0151.MOV", ["Quillon"]],
      ]);
      expect(calls[0]!.ffmpeg.endsWith(`${path.sep}ffmpeg`)).toBe(true);

      const file = JSON.parse(yield* fs.readFileString(clip!.transcript!));
      expect(file).toEqual({
        v: 1,
        source: path.join(media, "IMG_0151.MOV"),
        duration: 4.25,
        model: "FermionResearch/Phonon-2",
        text: "words of IMG_0151.MOV",
        segments: [{ start: 0.123, end: 1.5, text: "words of IMG_0151.MOV" }],
        words: [
          { start: 0, end: 0.4, text: "words" },
          { start: 0.5, end: 0.9, text: "of" },
          { start: 1, end: 1.4, text: "IMG_0151.MOV" },
        ],
      });
      yield* decodeTranscriptFile(JSON.stringify(file));
      expect((yield* fs.readDirectory(media)).toSorted()).toEqual(["IMG_0151.MOV", "silent.mp4"]);
      expect(result.totals).toMatchObject({
        files: 2,
        done: 2,
        transcribed: 1,
        words: 3,
        fromCache: 0,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("answers a repeat call from the cache until the source or the options change", () =>
    Effect.gen(function* () {
      const { fs, path, media, calls, prepare } = yield* makeHarness();
      const clip = path.join(media, "talk.mov");
      yield* fs.writeFileString(clip, "video");

      const first = yield* prepare({ paths: [clip] });
      const again = yield* prepare({ paths: [clip] });
      expect(calls).toHaveLength(1);
      expect(again.files).toEqual(first.files);
      expect(again.totals).toMatchObject({ transcribed: 1, fromCache: 1 });

      yield* prepare({ paths: [clip], hotwords: ["Ada"] });
      expect(calls).toHaveLength(2);

      const later = (yield* DateTime.now).pipe(DateTime.add({ minutes: 1 }), DateTime.toDate);
      yield* fs.utimes(clip, later, later);
      const edited = yield* prepare({ paths: [clip] });
      expect(calls).toHaveLength(3);
      expect(edited.files[0]!.transcript).not.toBe(first.files[0]!.transcript);
    }).pipe(Effect.scoped),
  );

  it.effect("reports each failure on its own file and keeps the rest", () =>
    Effect.gen(function* () {
      const { fs, path, media, prepare } = yield* makeHarness();
      for (const name of ["good.mov", "garbled.mov", "broken.mov"]) {
        yield* fs.writeFileString(path.join(media, name), "video");
      }
      const result = yield* prepare({ paths: [media, path.join(media, "gone.mov")] });

      const byName = new Map(result.files.map((file) => [path.basename(file.source), file]));
      expect(byName.get("gone.mov")?.error).toBe("No file or folder exists at this path.");
      expect(byName.get("broken.mov")?.error).toBe(
        "ffprobe could not read this file: Invalid data found when processing input",
      );
      expect(byName.get("garbled.mov")).toMatchObject({
        duration: 4.25,
        error: "Transcription failed: the decoder gave up.",
      });
      expect(byName.get("garbled.mov")?.transcript).toBeUndefined();
      expect(byName.get("good.mov")?.words).toBe(3);
      expect(result.totals).toMatchObject({ files: 4, failed: 3, transcribed: 1 });
    }).pipe(Effect.scoped),
  );

  it.effect("returns pending work after the wait and hands it to the next call", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const { fs, path, media, calls, prepare } = yield* makeHarness({ hold, started });
      const clip = path.join(media, "long.mov");
      yield* fs.writeFileString(clip, "video");

      const waiting = yield* prepare({ paths: [clip], wait: "45 seconds" }).pipe(Effect.forkChild);
      // The call starts its wait before the file reaches transcription.
      yield* Deferred.await(started);
      yield* TestClock.adjust("45 seconds");
      const early = yield* Fiber.join(waiting);
      expect(early.pending).toEqual([clip]);
      expect(early.files).toEqual([]);
      expect(Option.getOrNull(early.activity)).toBe("installing the transcription runtime");

      yield* Deferred.succeed(hold, undefined);
      const later = yield* prepare({ paths: [clip] });
      expect(later.pending).toEqual([]);
      expect(later.files[0]?.words).toBe(3);
      // The second call joined the first call's work instead of starting its own.
      expect(calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("probes only when transcription is off", () =>
    Effect.gen(function* () {
      const { fs, path, media, calls, prepare } = yield* makeHarness();
      yield* fs.writeFileString(path.join(media, "a.mov"), "video");
      const result = yield* prepare({ paths: [media], transcribe: false });
      expect(calls).toEqual([]);
      expect(result.files[0]).toMatchObject({ hasAudio: true, duration: 4.25 });
      expect(result.files[0]?.transcript).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("names the fix when ffmpeg is missing and refuses relative paths", () =>
    Effect.gen(function* () {
      const { fs, path, media, prepare } = yield* makeHarness();
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-nobin-" });
      const missing = yield* prepare({ paths: [media] }, empty).pipe(Effect.flip);
      expect(missing._tag).toBe("MediaPrepareToolMissingError");
      expect(missing.message).toContain("brew install ffmpeg");

      const relative = yield* prepare({ paths: [path.join("media", "a.mov")] }).pipe(Effect.flip);
      expect(relative._tag).toBe("MediaPrepareRelativePathError");
    }).pipe(Effect.scoped),
  );
});
