import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Hex from "effect/encoding/Hex";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { expandMediaSources, type MediaSource } from "./mediaSources.ts";
import { decodeFfprobeJson, ffprobeArgs, MediaProbe, parseFfprobe } from "./mediaProbe.ts";
import { FERMION_VERSION, PHONON_MODEL_ID } from "./phononRelease.ts";
import * as PhononRuntime from "./PhononRuntime.ts";
import {
  decodeTranscriptFile,
  encodeTranscriptFile,
  makeTranscriptFile,
  TRANSCRIPT_FILE_VERSION,
} from "./transcriptFile.ts";

export const MEDIA_PREPARE_MAX_FILES = 500;
export const MEDIA_PREPARE_MAX_HOTWORDS = 25;

export class MediaPrepareToolMissingError extends Schema.TaggedError<MediaPrepareToolMissingError>()(
  "MediaPrepareToolMissingError",
  { tool: Schema.Literals(["ffmpeg", "ffprobe"]) },
) {
  override get message(): string {
    return `Preparing media needs ${this.tool}, which is not on this machine's PATH. Install FFmpeg (macOS: \`brew install ffmpeg\`; Debian or Ubuntu: \`apt install ffmpeg\`; Windows: \`winget install ffmpeg\`), then try again.`;
  }
}

export class MediaPrepareRelativePathError extends Schema.TaggedError<MediaPrepareRelativePathError>()(
  "MediaPrepareRelativePathError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Paths must be absolute; "${this.path}" is not.`;
  }
}

export class MediaPrepareTooManyFilesError extends Schema.TaggedError<MediaPrepareTooManyFilesError>()(
  "MediaPrepareTooManyFilesError",
  { count: Schema.Number, limit: Schema.Number },
) {
  override get message(): string {
    return `These paths hold ${this.count} media files, more than the ${this.limit} one call prepares. Pass fewer files or a subfolder.`;
  }
}

export class MediaPrepareSourcesError extends Schema.TaggedError<MediaPrepareSourcesError>()(
  "MediaPrepareSourcesError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "T3 could not list the given paths. Check that this server can read them.";
  }
}

export type MediaPrepareError =
  | MediaPrepareToolMissingError
  | MediaPrepareRelativePathError
  | MediaPrepareTooManyFilesError
  | MediaPrepareSourcesError;

/** One source's outcome. Probe fields are absent when probing failed; `error` then says why. */
export const PreparedFile = Schema.Struct({
  source: Schema.String,
  duration: Schema.optional(Schema.Number),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  fps: Schema.optional(Schema.Number),
  codec: Schema.optional(Schema.String),
  hasAudio: Schema.optional(Schema.Boolean),
  transcript: Schema.optional(Schema.String),
  words: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
});
export type PreparedFile = typeof PreparedFile.Type;

export const MediaPrepareTotals = Schema.Struct({
  files: Schema.Number,
  done: Schema.Number,
  pending: Schema.Number,
  failed: Schema.Number,
  transcribed: Schema.Number,
  fromCache: Schema.Number,
  mediaSeconds: Schema.Number,
  words: Schema.Number,
  elapsedSeconds: Schema.Number,
});

export interface MediaPrepareInput {
  readonly paths: ReadonlyArray<string>;
  readonly transcribe: boolean;
  readonly hotwords: ReadonlyArray<string>;
  /** How long the call waits; work still running continues and a later call collects it. */
  readonly wait?: Duration.Input;
}

export interface MediaPrepareResult {
  /** Finished sources and paths that yielded none, in the order given. */
  readonly files: ReadonlyArray<PreparedFile>;
  /** Sources still being prepared when the wait ran out. */
  readonly pending: ReadonlyArray<string>;
  readonly totals: typeof MediaPrepareTotals.Type;
  /** What is holding pending work up, such as the one-time runtime install. */
  readonly activity: Option.Option<string>;
}

/**
 * Prepares media files where they live for an editing workspace: probes each
 * with ffprobe and transcribes its speech with Phonon-2. Nothing is written
 * beside the sources; probes and transcript files are cached under T3 home,
 * keyed by path, size, modification time and options, so a second call is
 * instant. Work belongs to the service, so a call that stops waiting leaves it
 * running and a later call with the same paths picks up the results.
 */
export class MediaPrepare extends Context.Service<
  MediaPrepare,
  {
    readonly prepare: (
      input: MediaPrepareInput,
    ) => Effect.Effect<MediaPrepareResult, MediaPrepareError>;
  }
>()("t3/mediaPrepare/MediaPrepare") {}

interface FileOutcome {
  readonly file: PreparedFile;
  readonly transcribed: boolean;
  readonly fromCache: boolean;
}

interface MediaPrepareOptions {
  /** Normally `<T3 home>/caches/media-prepare`. */
  readonly cacheDir: string;
  readonly wait?: Duration.Input;
}

const PROBE_CACHE_VERSION = 1;
const PROBE_CONCURRENCY = 4;
const STDERR_TAIL_CHARS = 600;

const encodeProbe = Schema.encodeEffect(Schema.fromJsonString(MediaProbe));
const decodeProbe = Schema.decodeUnknownEffect(Schema.fromJsonString(MediaProbe));
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const makeMediaPrepare = Effect.fn("MediaPrepare.make")(function* (
  options: MediaPrepareOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runner = yield* ProcessRunner.ProcessRunner;
  const phonon = yield* PhononRuntime.PhononRuntime;
  const serviceScope = yield* Effect.scope;
  const defaultWait = options.wait ?? "45 seconds";
  const probeGate = yield* Semaphore.make(PROBE_CONCURRENCY);
  // Work in progress by cache key, so overlapping calls share it.
  const inFlight = new Map<string, Deferred.Deferred<FileOutcome>>();

  const cacheKey = (parts: unknown) =>
    crypto.digest("SHA-256", new TextEncoder().encode(encodeKey(parts))).pipe(
      Effect.map((digest) => Hex.encode(digest).slice(0, 32)),
      Effect.orDie,
    );

  /** Writes beside the target and renames, so a reader never sees half a file. */
  const writeAtomically = (target: string, contents: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      const suffix = (yield* crypto.randomUUIDv4).slice(0, 8);
      const temporary = `${target}.${suffix}.tmp`;
      yield* fs.writeFileString(temporary, contents);
      yield* fs.rename(temporary, target);
    });

  /** A cache entry, or None on a miss. A damaged entry is logged and rebuilt. */
  const readCached = <A, E>(
    file: string,
    decode: (text: string) => Effect.Effect<A, E>,
  ): Effect.Effect<Option.Option<A>> => {
    const damaged = (cause: unknown) =>
      Effect.logWarning("Rebuilding an unreadable media-prepare cache entry.", {
        file,
        cause,
      }).pipe(Effect.as(Option.none<A>()));
    return fs.readFileString(file).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
      }),
      Effect.flatMap((text) =>
        text === null ? Effect.succeedNone : decode(text).pipe(Effect.asSome),
      ),
      Effect.catch(damaged),
    );
  };

  const probe = (source: MediaSource, ffprobe: string) =>
    Effect.gen(function* () {
      const key = yield* cacheKey({
        v: PROBE_CACHE_VERSION,
        path: source.path,
        size: source.size,
        mtimeMs: source.mtimeMs,
      });
      const file = path.join(options.cacheDir, "probe", `${key}.json`);
      const cached = yield* readCached(file, decodeProbe);
      if (Option.isSome(cached)) return { probe: cached.value, fromCache: true } as const;
      const result = yield* probeGate.withPermit(
        runner.run({
          command: ffprobe,
          args: ffprobeArgs(source.path),
          timeout: "60 seconds",
          maxOutputBytes: 4 * 1024 * 1024,
        }),
      );
      if (result.code !== 0) {
        return yield* Effect.fail(
          `ffprobe could not read this file: ${result.stderr.trim().slice(-STDERR_TAIL_CHARS)}`,
        );
      }
      const parsed = parseFfprobe(yield* decodeFfprobeJson(result.stdout));
      if (parsed === null) {
        return yield* Effect.fail("ffprobe found no video or audio stream with a duration here.");
      }
      yield* writeAtomically(file, yield* encodeProbe(parsed));
      return { probe: parsed, fromCache: false } as const;
    });

  const transcriptFor = (
    source: MediaSource,
    duration: number,
    ffmpeg: string,
    hotwords: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const key = yield* cacheKey({
        v: TRANSCRIPT_FILE_VERSION,
        path: source.path,
        size: source.size,
        mtimeMs: source.mtimeMs,
        model: PHONON_MODEL_ID,
        fermion: FERMION_VERSION,
        hotwords,
      });
      const stem = path.basename(source.path, path.extname(source.path));
      const file = path.join(options.cacheDir, "transcripts", key, `${stem}.transcript.json`);
      const cached = yield* readCached(file, decodeTranscriptFile);
      if (Option.isSome(cached)) {
        return { file, words: cached.value.words.length, fromCache: true } as const;
      }
      const transcript = yield* phonon.transcribe({ path: source.path, ffmpeg, hotwords });
      if (transcript.truncated) {
        yield* Effect.logWarning("Phonon ran out of token budget in part of a file.", {
          source: source.path,
        });
      }
      const contents = makeTranscriptFile({
        source: source.path,
        duration,
        model: PHONON_MODEL_ID,
        transcript,
      });
      yield* writeAtomically(file, yield* encodeTranscriptFile(contents));
      return { file, words: contents.words.length, fromCache: false } as const;
    });

  const describe = (error: unknown) =>
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : "Unknown failure.";

  const prepareFile = (
    source: MediaSource,
    tools: { readonly ffprobe: string; readonly ffmpeg: string | null },
    hotwords: ReadonlyArray<string>,
  ): Effect.Effect<FileOutcome> =>
    Effect.gen(function* () {
      const probed = yield* probe(source, tools.ffprobe).pipe(Effect.result);
      if (probed._tag === "Failure") {
        return {
          file: { source: source.path, error: describe(probed.failure) },
          transcribed: false,
          fromCache: false,
        };
      }
      const media = probed.success.probe;
      const file: PreparedFile = { source: source.path, ...media };
      if (tools.ffmpeg === null || !media.hasAudio) {
        return { file, transcribed: false, fromCache: probed.success.fromCache };
      }
      const transcribed = yield* transcriptFor(source, media.duration, tools.ffmpeg, hotwords).pipe(
        Effect.result,
      );
      if (transcribed._tag === "Failure") {
        return {
          file: { ...file, error: describe(transcribed.failure) },
          transcribed: false,
          fromCache: false,
        };
      }
      return {
        file: { ...file, transcript: transcribed.success.file, words: transcribed.success.words },
        transcribed: true,
        fromCache: probed.success.fromCache && transcribed.success.fromCache,
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Preparing a media file failed unexpectedly.", {
          source: source.path,
          cause,
        }).pipe(
          Effect.as({
            file: {
              source: source.path,
              error: "T3 failed unexpectedly while preparing this file.",
            },
            transcribed: false,
            fromCache: false,
          }),
        ),
      ),
    );

  /** Joins this source's work in progress, or starts it in the service's scope. */
  const task = (
    source: MediaSource,
    tools: { readonly ffprobe: string; readonly ffmpeg: string | null },
    hotwords: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const key = encodeKey({
        path: source.path,
        size: source.size,
        mtimeMs: source.mtimeMs,
        transcribe: tools.ffmpeg !== null,
        hotwords,
      });
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing;
      const done = yield* Deferred.make<FileOutcome>();
      inFlight.set(key, done);
      yield* prepareFile(source, tools, hotwords).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => inFlight.delete(key)).pipe(
            Effect.andThen(
              Exit.isSuccess(exit) ? Deferred.succeed(done, exit.value) : Deferred.interrupt(done),
            ),
          ),
        ),
        Effect.forkIn(serviceScope),
      );
      return done;
    });

  const resolveTool = (tool: "ffmpeg" | "ffprobe") =>
    resolveCommandPath(tool).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.flatMap((resolved) =>
        resolved === null
          ? Effect.fail(new MediaPrepareToolMissingError({ tool }))
          : Effect.succeed(resolved),
      ),
    );

  const prepare = Effect.fn("MediaPrepare.prepare")(function* (input: MediaPrepareInput) {
    const startedAt = yield* Clock.currentTimeMillis;
    const relative = input.paths.find((given) => !path.isAbsolute(given));
    if (relative !== undefined) {
      return yield* new MediaPrepareRelativePathError({ path: relative });
    }
    const tools = {
      ffprobe: yield* resolveTool("ffprobe"),
      ffmpeg: input.transcribe ? yield* resolveTool("ffmpeg") : null,
    };
    const { sources, problems } = yield* expandMediaSources(input.paths).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new MediaPrepareSourcesError({ cause })),
    );
    if (sources.length > MEDIA_PREPARE_MAX_FILES) {
      return yield* new MediaPrepareTooManyFilesError({
        count: sources.length,
        limit: MEDIA_PREPARE_MAX_FILES,
      });
    }
    yield* Effect.logInfo("Preparing media.", {
      sources: sources.length,
      transcribe: input.transcribe,
    });
    const tasks = yield* Effect.forEach(sources, (source) => task(source, tools, input.hotwords));
    const wait = input.wait ?? defaultWait;
    const outcomes = yield* Effect.forEach(
      tasks,
      (done) => Deferred.await(done).pipe(Effect.timeoutOption(wait), Effect.exit),
      { concurrency: "unbounded" },
    );

    const files: Array<PreparedFile> = problems.map((problem) => ({
      source: problem.path,
      error: problem.error,
    }));
    const pending: Array<string> = [];
    let transcribed = 0;
    let fromCache = 0;
    let mediaSeconds = 0;
    let words = 0;
    outcomes.forEach((outcome, index) => {
      const source = sources[index]!.path;
      if (Exit.isFailure(outcome) || Option.isNone(outcome.value)) {
        // Interrupted work (the server stopping) is pending like work still running.
        pending.push(source);
        return;
      }
      const { file, transcribed: wasTranscribed, fromCache: wasCached } = outcome.value.value;
      files.push(file);
      if (wasTranscribed) transcribed += 1;
      if (wasCached) fromCache += 1;
      mediaSeconds += file.duration ?? 0;
      words += file.words ?? 0;
    });
    const finishedAt = yield* Clock.currentTimeMillis;
    const failed = files.filter((file) => file.error !== undefined).length;
    const totals = {
      files: sources.length + problems.length,
      done: files.length,
      pending: pending.length,
      failed,
      transcribed,
      fromCache,
      mediaSeconds: Math.round(mediaSeconds * 10) / 10,
      words,
      elapsedSeconds: Math.round((finishedAt - startedAt) / 100) / 10,
    };
    yield* Effect.logInfo("Prepared media.", totals);
    return {
      files,
      pending,
      totals,
      activity: pending.length === 0 ? Option.none() : yield* phonon.activity,
    } satisfies MediaPrepareResult;
  });

  return MediaPrepare.of({ prepare });
});

export const layer = Layer.effect(
  MediaPrepare,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* makeMediaPrepare({
      cacheDir: path.join(config.baseDir, "caches", "media-prepare"),
    });
  }),
).pipe(Layer.provide(Layer.mergeAll(PhononRuntime.layer, ProcessRunner.layer)));
