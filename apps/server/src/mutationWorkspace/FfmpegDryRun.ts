import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { planFfmpegDryRun, stderrTail } from "./ffmpegCommand.ts";

/** A file the export produced, which a command may read by its name. */
export interface ExportedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface FfmpegDryRunInput {
  /** The export's ffmpeg commands, as shell text. */
  readonly commands: ReadonlyArray<string>;
  /** The workspace's assets; commands name them by absolute path or by file name. */
  readonly assetPaths: ReadonlyArray<string>;
  readonly files: ReadonlyArray<ExportedFile>;
  /** For every command together; commands past it are not run. */
  readonly budget: Duration.Input;
}

/** What one command's dry run found. `command` counts from 1, in export order. */
export type FfmpegCommandCheck =
  | { readonly command: number; readonly status: "ok" }
  | { readonly command: number; readonly status: "failed"; readonly stderr: string }
  | { readonly command: number; readonly status: "not-run"; readonly reason: string };

/**
 * Dry-runs a workspace export's ffmpeg commands with the host's ffmpeg, so a
 * filter graph that ffmpeg rejects shows up before the user renders it.
 */
export class FfmpegDryRun extends Context.Service<
  FfmpegDryRun,
  {
    /**
     * Runs each command for a fraction of a second against the real assets in
     * a scratch folder that is removed afterwards. None when ffmpeg is not on
     * PATH: this never installs it.
     */
    readonly dryRun: (
      input: FfmpegDryRunInput,
    ) => Effect.Effect<Option.Option<ReadonlyArray<FfmpegCommandCheck>>>;
  }
>()("t3/mutationWorkspace/FfmpegDryRun") {}

const MAX_STDERR_BYTES = 64 * 1024;

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;

  const dryRun = Effect.fn("FfmpegDryRun.dryRun")(function* (input: FfmpegDryRunInput) {
    const ffmpeg = yield* resolveCommandPath("ffmpeg");
    if (ffmpeg === null) return Option.none();
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ffmpeg-dry-run-" });
    // Assets by file name, then the export's own files (an overlay PNG, say) over them.
    for (const assetPath of input.assetPaths) {
      yield* fileSystem.symlink(assetPath, path.join(directory, path.basename(assetPath)));
    }
    for (const file of input.files) {
      yield* fileSystem.writeFile(path.join(directory, path.basename(file.name)), file.bytes);
    }
    const allowed = new Set(input.assetPaths);
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(input.budget);
    const checks: Array<FfmpegCommandCheck> = [];
    for (const [index, command] of input.commands.entries()) {
      const number = index + 1;
      const plan = planFfmpegDryRun(command, allowed);
      if (!plan.ok) {
        checks.push({ command: number, status: "not-run", reason: plan.reason });
        continue;
      }
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) {
        checks.push({ command: number, status: "not-run", reason: "the dry-run budget ran out" });
        continue;
      }
      const result = yield* runner.run({
        command: ffmpeg,
        args: plan.args,
        cwd: directory,
        timeout: Duration.millis(remaining),
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: MAX_STDERR_BYTES,
        outputMode: "truncate",
      });
      checks.push(
        result.timedOut
          ? { command: number, status: "not-run", reason: "it ran past the dry-run budget" }
          : result.code === 0
            ? { command: number, status: "ok" }
            : { command: number, status: "failed", stderr: stderrTail(result.stderr) },
      );
    }
    return Option.some(checks);
  }, Effect.scoped);

  return FfmpegDryRun.of({
    dryRun: (input) =>
      dryRun(input).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catch((cause) =>
          Effect.logWarning("Could not dry-run a workspace export's ffmpeg commands.", {
            cause,
          }).pipe(
            Effect.as(
              Option.some(
                input.commands.map((_, index): FfmpegCommandCheck => ({
                  command: index + 1,
                  status: "not-run",
                  reason: `the dry run could not start (${cause.message})`,
                })),
              ),
            ),
          ),
        ),
      ),
  });
});

/** Runs ffmpeg through the given process runner; tests pass a fake one. */
export const layerWithProcessRunner = Layer.effect(FfmpegDryRun, make);

export const layer = layerWithProcessRunner.pipe(Layer.provide(ProcessRunner.layer));
