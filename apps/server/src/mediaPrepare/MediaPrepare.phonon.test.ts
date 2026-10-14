import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as MediaPrepare from "./MediaPrepare.ts";
import * as PhononRuntime from "./PhononRuntime.ts";
import { decodeTranscriptFile } from "./transcriptFile.ts";

// The real runtime: installs fermion-research into a fresh venv (or the one
// T3CODE_TEST_PHONON_ROOT names), loads Phonon-2, and transcribes a clip
// spoken by macOS `say`. Run with T3CODE_TEST_PHONON=1; it needs Python 3.12+,
// ffmpeg, network access on a fresh root, and macOS for `say`.
const SENTENCE = "Well, the most important thing about editing is knowing what to cut.";

describe.skipIf(process.env.T3CODE_TEST_PHONON !== "1")("MediaPrepare with Phonon-2", () => {
  it.live(
    "transcribes a spoken clip into the transcript file shape, then answers from the cache",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* ProcessRunner.ProcessRunner;
        const scratch = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-phonon-real-" }),
        );
        const root = process.env.T3CODE_TEST_PHONON_ROOT ?? path.join(scratch, "phonon");
        const media = path.join(scratch, "media");
        yield* fs.makeDirectory(media);
        const speech = path.join(scratch, "speech.aiff");
        const clip = path.join(media, "spoken.mp4");
        const say = yield* runner.run({ command: "say", args: ["-o", speech, SENTENCE] });
        expect(say.code, "this test needs macOS `say`").toBe(0);
        const encode = yield* runner.run({
          command: "ffmpeg",
          // A black picture under the spoken track, so the clip is a video like a phone's.
          args: [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=320x240:r=30",
            "-i",
            speech,
            "-shortest",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            clip,
          ],
        });
        expect(encode.code, encode.stderr).toBe(0);

        const runtime = yield* PhononRuntime.makePhononRuntime({ root });
        const service = yield* MediaPrepare.makeMediaPrepare({
          cacheDir: path.join(scratch, "cache"),
          wait: "20 minutes",
        }).pipe(Effect.provideService(PhononRuntime.PhononRuntime, runtime));

        const first = yield* service.prepare({ paths: [media], transcribe: true, hotwords: [] });
        expect(first.pending).toEqual([]);
        const [file] = first.files;
        expect(file?.error).toBeUndefined();
        expect(file).toMatchObject({ source: clip, width: 320, height: 240, hasAudio: true });
        const transcript = yield* decodeTranscriptFile(yield* fs.readFileString(file!.transcript!));
        expect(transcript.source).toBe(clip);
        expect(transcript.model).toBe("FermionResearch/Phonon-2");
        expect(transcript.text.toLowerCase()).toContain("editing");
        expect(transcript.words.length).toBeGreaterThan(8);
        const editing = transcript.words.find((word) => /editing/i.test(word.text));
        expect(editing!.start).toBeGreaterThan(0.5);
        expect(editing!.end).toBeLessThan(transcript.duration);
        expect(transcript.segments.map((segment) => segment.text).join(" ")).toBe(transcript.text);
        expect(yield* fs.readDirectory(media)).toEqual(["spoken.mp4"]);

        const again = yield* service.prepare({ paths: [media], transcribe: true, hotwords: [] });
        expect(again.totals).toMatchObject({ fromCache: 1, transcribed: 1 });
      }).pipe(
        Effect.scoped,
        Effect.provide(ProcessRunner.layer),
        Effect.provide(NodeServices.layer),
      ),
    20 * 60_000,
  );
});
