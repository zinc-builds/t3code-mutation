import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  findPython,
  installRuntime,
  PhononInstallError,
  type PhononPythonInvalidError,
  type PhononPythonMissingError,
  venvPython,
} from "./phononInstall.ts";
import { PHONON_MODEL, phononRelease } from "./phononRelease.ts";
import { PHONON_WORKER_SCRIPT } from "./phononWorkerScript.ts";
import { WorkerTranscript } from "./transcriptFile.ts";

export class PhononWorkerStartError extends Schema.TaggedError<PhononWorkerStartError>()(
  "PhononWorkerStartError",
  {
    /** What the worker reported, or the tail of its stderr when it died first. */
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The transcription worker could not load Phonon-2: ${this.reason}`;
  }
}

export class PhononWorkerCrashedError extends Schema.TaggedError<PhononWorkerCrashedError>()(
  "PhononWorkerCrashedError",
  { exitCode: Schema.NullOr(Schema.Number), stderr: Schema.String },
) {
  override get message(): string {
    const code = this.exitCode === null ? "" : ` with code ${this.exitCode}`;
    const stderr = this.stderr.length === 0 ? "" : ` Its last output: ${this.stderr}`;
    return `The transcription worker exited${code} during this file. The next file starts a new one.${stderr}`;
  }
}

export class PhononTranscribeError extends Schema.TaggedError<PhononTranscribeError>()(
  "PhononTranscribeError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Transcription failed: ${this.reason}`;
  }
}

type PhononRuntimeError =
  | PhononPythonMissingError
  | PhononPythonInvalidError
  | PhononInstallError
  | PhononWorkerStartError
  | PhononWorkerCrashedError
  | PhononTranscribeError;

export interface TranscribeRequest {
  /** The source, read in place: the worker decodes its audio into memory. */
  readonly path: string;
  readonly ffmpeg: string;
  readonly hotwords: ReadonlyArray<string>;
}

/**
 * Phonon-2 speech recognition on this host, in a Python environment T3
 * installs under its home on first use. One long-lived worker loads the model
 * once and transcribes one file at a time; it exits after a few idle minutes
 * and when the server stops.
 */
export class PhononRuntime extends Context.Service<
  PhononRuntime,
  {
    readonly transcribe: (
      request: TranscribeRequest,
    ) => Effect.Effect<WorkerTranscript, PhononRuntimeError>;
    /** What the runtime is busy with, for progress messages; None when it is idle or ready. */
    readonly activity: Effect.Effect<Option.Option<string>>;
  }
>()("t3/mediaPrepare/PhononRuntime") {}

const WorkerMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ready"),
    fermion: Schema.String,
    loadSeconds: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("fatal"), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("result"),
    id: Schema.Number,
    transcript: WorkerTranscript,
  }),
  Schema.Struct({ type: Schema.Literal("error"), id: Schema.Number, message: Schema.String }),
]);
type WorkerMessage = typeof WorkerMessage.Type;
const decodeWorkerMessage = Schema.decodeUnknownEffect(WorkerMessage);
const encodeRequest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      path: Schema.String,
      ffmpeg: Schema.String,
      hotwords: Schema.Array(Schema.String),
    }),
  ),
);

interface RunningWorker {
  readonly scope: Scope.Closeable;
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
  readonly messages: Queue.Queue<WorkerMessage>;
  /** Completes when the process has exited and its stderr drained, with its code. */
  readonly exited: Deferred.Deferred<number | null>;
  readonly stderrTail: () => string;
}

interface PhononRuntimeOptions {
  /** The install root, normally `<T3 home>/tools/phonon`. */
  readonly root: string;
  /** How long the worker stays loaded with nothing to do. */
  readonly idleTimeout?: Duration.Input;
  /** Runs the worker with this command instead of installing one; tests use it. */
  readonly workerCommand?: { readonly command: string; readonly args: ReadonlyArray<string> };
}

const STDERR_TAIL_LINES = 12;
// The first start downloads the 164 MB model and, on Apple Silicon, compiles shaders.
const READY_TIMEOUT = "15 minutes";

export const makePhononRuntime = Effect.fn("PhononRuntime.make")(function* (
  options: PhononRuntimeOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const env = yield* HostProcess.Environment;
  const serviceScope = yield* Effect.scope;
  const release = phononRelease(platform, arch);
  const idleTimeout = options.idleTimeout ?? "5 minutes";
  const installServices = Context.make(ProcessRunner.ProcessRunner, runner).pipe(
    Context.add(FileSystem.FileSystem, fs),
    Context.add(Path.Path, path),
  );

  // One request at a time: the worker runs one decode, and its protocol has no interleaving.
  const gate = yield* Semaphore.make(1);
  let worker: RunningWorker | undefined;
  let idleFiber: Fiber.Fiber<void> | undefined;
  let nextId = 1;
  let activity: string | undefined;
  // A failed start fails the requests that were already waiting for it, so a
  // batch reports a missing Python once per file instead of retrying the
  // install for each; a request made after the failure tries again.
  let startAttempts = 0;
  let startFailure:
    | { readonly attempt: number; readonly error: Effect.Error<typeof startWorker> }
    | undefined;

  const stopWorker = Effect.suspend(() => {
    const current = worker;
    worker = undefined;
    return current === undefined ? Effect.void : Scope.close(current.scope, Exit.void);
  });
  yield* Effect.addFinalizer(() => stopWorker);

  /** The installed runtime's interpreter, installing it first when this host has none. */
  const ensureInstalled = Effect.gen(function* () {
    const python = yield* findPython();
    const directoryName = `${release.id}-py${python.major}.${python.minor}`;
    const installed = venvPython(path, path.join(options.root, directoryName), platform);
    // The rename that publishes an install moves a complete venv, so its interpreter is the marker.
    const exists = yield* fs
      .exists(installed)
      .pipe(Effect.mapError((cause) => new PhononInstallError({ stage: "save", cause })));
    if (exists) return installed;
    activity = "installing the transcription runtime (one time, a few minutes)";
    return yield* installRuntime({ root: options.root, directoryName, release, python });
  }).pipe(Effect.provide(installServices));

  const workerCommand = Effect.gen(function* () {
    if (options.workerCommand !== undefined) return options.workerCommand;
    const python = yield* ensureInstalled;
    const script = path.join(options.root, "worker.py");
    yield* fs
      .writeFileString(script, PHONON_WORKER_SCRIPT)
      .pipe(Effect.mapError((cause) => new PhononInstallError({ stage: "save", cause })));
    return { command: python, args: ["-I", script, PHONON_MODEL] };
  });

  const startWorker = Effect.gen(function* () {
    const { command, args } = yield* workerCommand;
    activity = "loading the Phonon-2 speech model (the first run downloads 164 MB)";
    const scope = yield* Scope.make();
    const started = Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(command, args, {
            stdin: { stream: "pipe", endOnDone: false },
            stdout: "pipe",
            stderr: "pipe",
            env: { ...env, PYTHONUNBUFFERED: "1" },
            killSignal: "SIGTERM",
            forceKillAfter: Duration.seconds(3),
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new PhononWorkerStartError({ reason: "the worker process did not start.", cause }),
          ),
        );
      yield* Scope.addFinalizer(scope, handle.kill().pipe(Effect.ignore));
      const messages = yield* Queue.unbounded<WorkerMessage>();
      const exited = yield* Deferred.make<number | null>();
      const stderrClosed = yield* Deferred.make<void>();
      const tail: Array<string> = [];
      yield* handle.stdout.pipe(
        Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
        Stream.mapEffect((value) => decodeWorkerMessage(value)),
        Stream.runForEach((message) => Queue.offer(messages, message)),
        // A request waits on this stream, so output it cannot read ends the worker, which fails it.
        Effect.catch((cause) =>
          Effect.logWarning("Unreadable transcription worker output; stopping the worker.", {
            cause,
          }).pipe(Effect.andThen(handle.kill().pipe(Effect.ignore))),
        ),
        Effect.forkIn(scope),
      );
      // Fermion reports model downloads and shader compiles on stderr.
      yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.map((line) => line.split("\r").at(-1)?.trim() ?? ""),
        Stream.filter((line) => line.length > 0),
        Stream.runForEach((line) =>
          Effect.sync(() => {
            tail.push(line);
            if (tail.length > STDERR_TAIL_LINES) tail.shift();
          }).pipe(Effect.andThen(Effect.logInfo(`Transcription worker: ${line}`))),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Unreadable transcription worker stderr.", { cause }),
        ),
        Effect.ensuring(Deferred.succeed(stderrClosed, undefined)),
        Effect.forkIn(scope),
      );
      yield* handle.exitCode.pipe(
        Effect.map(Number),
        Effect.catch((cause) =>
          Effect.logWarning("Could not read the transcription worker's exit code.", {
            cause,
          }).pipe(Effect.as(null)),
        ),
        // Exit is reported once stderr has drained, so errors carry the worker's last words.
        // A grandchild holding the pipe open must not hold that up for long.
        Effect.tap(() => Deferred.await(stderrClosed).pipe(Effect.timeoutOption("2 seconds"))),
        Effect.flatMap((code) => Deferred.succeed(exited, code)),
        Effect.forkIn(scope),
      );
      return { scope, handle, messages, exited, stderrTail: () => tail.join(" | ") };
    }).pipe(Effect.provideService(Scope.Scope, scope));
    const running = yield* started.pipe(
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    );
    const first = yield* Effect.raceFirst(
      Queue.take(running.messages),
      Deferred.await(running.exited).pipe(
        Effect.flatMap((code) =>
          Effect.fail(
            new PhononWorkerStartError({
              reason: `the worker exited${code === null ? "" : ` with code ${code}`} before it was ready. ${running.stderrTail()}`,
            }),
          ),
        ),
      ),
    ).pipe(
      Effect.timeoutOrElse({
        duration: READY_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new PhononWorkerStartError({
              reason: `it was not ready after ${READY_TIMEOUT}. ${running.stderrTail()}`,
            }),
          ),
      }),
      Effect.flatMap((message) =>
        message.type === "ready"
          ? Effect.succeed(message)
          : Effect.fail(
              new PhononWorkerStartError({
                reason:
                  message.type === "fatal"
                    ? message.message
                    : `it answered "${message.type}" before it was ready.`,
              }),
            ),
      ),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    );
    yield* Effect.logInfo("Transcription worker ready.", {
      fermion: first.fermion,
      loadSeconds: Math.round(first.loadSeconds * 10) / 10,
    });
    return running;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        activity = undefined;
      }),
    ),
  );

  const request = (running: RunningWorker, input: TranscribeRequest) =>
    Effect.gen(function* () {
      const id = nextId++;
      const line = yield* encodeRequest({
        id,
        path: input.path,
        ffmpeg: input.ffmpeg,
        hotwords: [...input.hotwords],
      }).pipe(Effect.orDie);
      const crashed = Deferred.await(running.exited).pipe(
        Effect.flatMap((exitCode) =>
          Effect.fail(new PhononWorkerCrashedError({ exitCode, stderr: running.stderrTail() })),
        ),
      );
      // A closed stdin means the worker is gone; its exit says why.
      yield* Stream.run(Stream.encodeText(Stream.make(`${line}\n`)), running.handle.stdin).pipe(
        Effect.catch(() =>
          crashed.pipe(
            Effect.timeoutOrElse({
              duration: "3 seconds",
              orElse: () =>
                Effect.fail(
                  new PhononWorkerCrashedError({
                    exitCode: null,
                    stderr: `T3 could not write to the worker. ${running.stderrTail()}`,
                  }),
                ),
            }),
          ),
        ),
      );
      const message = yield* Effect.raceFirst(Queue.take(running.messages), crashed);
      if (message.type === "result" && message.id === id) return message.transcript;
      if (message.type === "error" && message.id === id) {
        return yield* new PhononTranscribeError({ reason: message.message });
      }
      return yield* new PhononWorkerCrashedError({
        exitCode: null,
        stderr: `the worker answered out of turn (${message.type}).`,
      });
    });

  const scheduleIdleStop = Effect.gen(function* () {
    idleFiber = yield* Effect.sleep(idleTimeout).pipe(
      Effect.andThen(
        gate.withPermit(
          Effect.logInfo("Transcription worker idle; stopping it.").pipe(
            Effect.andThen(stopWorker),
          ),
        ),
      ),
      Effect.forkIn(serviceScope),
    );
  });

  const start = Effect.suspend(() => {
    const attempt = ++startAttempts;
    return startWorker.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          startFailure = { attempt, error };
        }),
      ),
    );
  });

  const transcribe = (input: TranscribeRequest) =>
    Effect.suspend(() => {
      const queuedAfter = startAttempts;
      return gate.withPermit(
        Effect.gen(function* () {
          if (idleFiber !== undefined) {
            yield* Fiber.interrupt(idleFiber);
            idleFiber = undefined;
          }
          if (
            worker === undefined &&
            startFailure !== undefined &&
            startFailure.attempt > queuedAfter
          ) {
            return yield* startFailure.error;
          }
          const running = worker ?? (yield* start);
          worker = running;
          return yield* request(running, input).pipe(
            Effect.tapError((error) =>
              error._tag === "PhononWorkerCrashedError" ? stopWorker : Effect.void,
            ),
            // An interrupted request leaves an answer in flight, so its worker cannot serve the next.
            Effect.onInterrupt(() => stopWorker),
          );
        }).pipe(Effect.ensuring(scheduleIdleStop)),
      );
    });

  return PhononRuntime.of({
    transcribe,
    activity: Effect.sync(() => Option.fromNullishOr(activity)),
  });
});

export const layer = Layer.effect(
  PhononRuntime,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* makePhononRuntime({ root: path.join(config.baseDir, "tools", "phonon") });
  }),
).pipe(Layer.provide(ProcessRunner.layer));
