import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as FfmpegDryRun from "./FfmpegDryRun.ts";

interface Run {
  readonly input: ProcessRunner.ProcessRunInput;
  /** The scratch folder while ffmpeg ran: each name and what it holds. */
  readonly files: ReadonlyArray<readonly [string, string]>;
}

const output = (
  overrides: Partial<ProcessRunner.ProcessRunOutput>,
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

/** A fake ffmpeg: records each run with the scratch folder's contents, and answers in turn. */
const fakeRunner = (
  runs: Array<Run>,
  answers: ReadonlyArray<Partial<ProcessRunner.ProcessRunOutput>>,
) =>
  Layer.effect(
    ProcessRunner.ProcessRunner,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            const names = (yield* fileSystem.readDirectory(input.cwd!)).toSorted();
            const files = yield* Effect.forEach(names, (name) =>
              fileSystem
                .readFileString(path.join(input.cwd!, name))
                .pipe(Effect.map((text) => [name, text] as const)),
            );
            runs.push({ input, files });
            return output(answers[runs.length - 1] ?? {});
          }).pipe(Effect.orDie),
      });
    }),
  );

/** A directory holding an executable named ffmpeg, to stand as PATH. */
const fakeFfmpegOnPath = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bin = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ffmpeg-bin-" });
  const ffmpeg = path.join(bin, "ffmpeg");
  yield* fileSystem.writeFileString(ffmpeg, "#!/bin/sh\nexit 0\n");
  yield* fileSystem.chmod(ffmpeg, 0o755);
  return { bin, ffmpeg };
});

it.layer(NodeServices.layer)("FfmpegDryRun", (it) => {
  it.effect(
    "runs each command in a scratch folder of assets and export files, then removes it",
    () => {
      const runs: Array<Run> = [];
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { bin, ffmpeg } = yield* fakeFfmpegOnPath;
        const media = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ffmpeg-media-" });
        const clip = path.join(media, "clip.mp4");
        yield* fileSystem.writeFileString(clip, "mp4 bytes");
        const dryRun = yield* FfmpegDryRun.FfmpegDryRun;
        const checks = yield* dryRun
          .dryRun({
            commands: [
              "ffmpeg -i clip.mp4 -i title.png -filter_complex '[0:v][1:v]overlay' cut.mp4",
              "ffmpeg -i clip.mp4 -vf nope still.png",
              "ffmpeg -i /etc/hosts out.mp4",
              `ffmpeg -i ${clip} -af volume=2 out.m4a`,
            ],
            assetPaths: [clip],
            files: [{ name: "title.png", bytes: new TextEncoder().encode("png bytes") }],
            budget: "4 seconds",
          })
          .pipe(Effect.provideService(HostProcess.Environment, { PATH: bin }));

        expect(Option.getOrThrow(checks)).toEqual([
          { command: 1, status: "ok" },
          { command: 2, status: "failed", stderr: "[AVFilterGraph] No such filter: 'nope'" },
          {
            command: 3,
            status: "not-run",
            reason: "it names a path outside the workspace's assets (/etc/hosts)",
          },
          { command: 4, status: "not-run", reason: "it ran past the dry-run budget" },
        ]);
        assert.strictEqual(runs.length, 3);
        const [first] = runs;
        assert.strictEqual(first!.input.command, ffmpeg);
        assert.deepEqual(first!.input.args.slice(-3), ["-t", "0.5", "cut.mp4"]);
        assert.deepEqual(first!.files, [
          ["clip.mp4", "mp4 bytes"],
          ["title.png", "png bytes"],
        ]);
        assert.include(runs[2]!.input.args, clip);
        assert.isFalse(yield* fileSystem.exists(first!.input.cwd!));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          FfmpegDryRun.layerWithProcessRunner.pipe(
            Layer.provide(
              fakeRunner(runs, [
                {},
                {
                  code: ChildProcessSpawner.ExitCode(1),
                  stderr: "[AVFilterGraph] No such filter: 'nope'\n",
                },
                { code: null, timedOut: true },
              ]),
            ),
          ),
        ),
      );
    },
  );

  it.effect("finds no ffmpeg when none is on PATH, and never runs one", () => {
    const runs: Array<Run> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const empty = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ffmpeg-none-" });
      const dryRun = yield* FfmpegDryRun.FfmpegDryRun;
      const checks = yield* dryRun
        .dryRun({
          commands: ["ffmpeg -i a.wav b.m4a"],
          assetPaths: [],
          files: [],
          budget: "1 second",
        })
        .pipe(Effect.provideService(HostProcess.Environment, { PATH: empty }));
      assert.isTrue(Option.isNone(checks));
      assert.strictEqual(runs.length, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(FfmpegDryRun.layerWithProcessRunner.pipe(Layer.provide(fakeRunner(runs, [])))),
    );
  });
});

// Real-ffmpeg test; runs only when this is set and ffmpeg is on PATH.
const TEST_FFMPEG_ENV = "T3CODE_TEST_FFMPEG";

describe("FfmpegDryRun with the host's ffmpeg", () => {
  it.live(
    "passes a valid filter graph and returns ffmpeg's complaint about a broken one",
    (ctx) =>
      Effect.gen(function* () {
        if (!(yield* HostProcess.Environment)[TEST_FFMPEG_ENV]) {
          return ctx.skip(`Set ${TEST_FFMPEG_ENV} to run this test.`);
        }
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* ProcessRunner.ProcessRunner;
        const media = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ffmpeg-real-" });
        const tone = path.join(media, "tone.wav");
        yield* runner.run({
          command: "ffmpeg",
          args: [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=2",
            tone,
          ],
        });
        const dryRun = yield* FfmpegDryRun.FfmpegDryRun;
        const checks = yield* dryRun.dryRun({
          commands: [
            "ffmpeg -y -i 'tone.wav' -filter_complex '[0:a]atrim=start=0:end=1,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.2[out]' -map '[out]' -vn -c:a aac -b:a 192k 'tone-edit.m4a'",
            "ffmpeg -y -i 'tone.wav' -af 'notafilter=1' 'broken.m4a'",
          ],
          assetPaths: [tone],
          files: [],
          budget: "8 seconds",
        });
        const [ok, broken] = Option.getOrThrow(checks);
        expect(ok).toEqual({ command: 1, status: "ok" });
        expect(broken).toMatchObject({ command: 2, status: "failed" });
        expect(broken?.status === "failed" ? broken.stderr : "").toMatch(/notafilter/);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(FfmpegDryRun.layer, ProcessRunner.layer).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    20_000,
  );
});
