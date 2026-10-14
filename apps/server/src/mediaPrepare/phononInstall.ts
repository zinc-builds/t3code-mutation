import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import { FERMION_VERSION, MIN_PYTHON, type PhononRelease } from "./phononRelease.ts";

const PYTHON_FIX =
  "Install Python 3.12 or newer (macOS: `brew install python@3.12`; Debian or Ubuntu: `apt install python3.12 python3.12-venv`; Windows: the python.org installer), or set T3CODE_PYTHON to the path of one, then try again.";

/** A Python T3 looked at, for the error that says why none would do. */
interface PythonCandidate {
  readonly command: string;
  readonly version: string | null;
}

export class PhononPythonMissingError extends Schema.TaggedError<PhononPythonMissingError>()(
  "PhononPythonMissingError",
  {
    candidates: Schema.Array(
      Schema.Struct({ command: Schema.String, version: Schema.NullOr(Schema.String) }),
    ),
  },
) {
  override get message(): string {
    const found = this.candidates.filter((candidate) => candidate.version !== null);
    const seen =
      found.length === 0
        ? "none was found on PATH (looked for python3.12, python3.13, python3, and python)"
        : `only ${found.map((candidate) => `${candidate.command} (${candidate.version})`).join(", ")} was found`;
    return `Transcription runs in a Python environment T3 installs, which needs Python ${MIN_PYTHON.major}.${MIN_PYTHON.minor} or newer, and ${seen}. ${PYTHON_FIX}`;
  }
}

export class PhononPythonInvalidError extends Schema.TaggedError<PhononPythonInvalidError>()(
  "PhononPythonInvalidError",
  { path: Schema.String, version: Schema.NullOr(Schema.String) },
) {
  override get message(): string {
    return this.version === null
      ? `T3CODE_PYTHON is set to ${this.path}, which T3 could not run as Python. Point it at a Python ${MIN_PYTHON.major}.${MIN_PYTHON.minor} or newer, or unset it.`
      : `T3CODE_PYTHON is set to ${this.path}, which is Python ${this.version}; transcription needs ${MIN_PYTHON.major}.${MIN_PYTHON.minor} or newer. ${PYTHON_FIX}`;
  }
}

const INSTALL_STAGES = ["venv", "pip", "verify", "save"] as const;

export class PhononInstallError extends Schema.TaggedError<PhononInstallError>()(
  "PhononInstallError",
  {
    stage: Schema.Literals(INSTALL_STAGES),
    exitCode: Schema.optional(Schema.Number),
    /** The tail of the failing command's output, which says what went wrong. */
    output: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const output = this.output === undefined ? "" : ` Its output ended: ${this.output}`;
    switch (this.stage) {
      case "venv":
        return `T3 could not create its transcription environment with Python's venv module. On Debian or Ubuntu, install python3.12-venv.${output}`;
      case "pip":
        return `T3 could not install fermion-research ${FERMION_VERSION} and its dependencies with pip. Check this machine's network access to pypi.org and try again.${output}`;
      case "verify":
        return `The transcription environment installed, but fermion-research ${FERMION_VERSION} would not import.${output}`;
      case "save":
        return "T3 could not save its transcription environment in its home directory. Check free disk space there and try again.";
    }
  }
}

interface FoundPython {
  readonly executable: string;
  readonly major: number;
  readonly minor: number;
}

const VERSION_SCRIPT = "import sys; print('%d.%d.%d' % sys.version_info[:3])";

const parseVersion = (text: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match === null
    ? null
    : { text: match[0], major: Number(match[1]), minor: Number(match[2]) };
};

const meetsMinimum = (version: { readonly major: number; readonly minor: number }) =>
  version.major > MIN_PYTHON.major ||
  (version.major === MIN_PYTHON.major && version.minor >= MIN_PYTHON.minor);

/**
 * The Python the runtime's venv is built from: T3CODE_PYTHON when set (and
 * then only it), else the first of python3.12, python3.13, python3, python on
 * PATH that is 3.12 or newer. 3.12 comes first because the lock was verified
 * on it.
 */
export const findPython = Effect.fn("phononInstall.findPython")(function* () {
  const env = yield* HostProcess.Environment;
  const runner = yield* ProcessRunner.ProcessRunner;
  const versionOf = (executable: string) =>
    runner.run({ command: executable, args: ["-c", VERSION_SCRIPT], timeout: "20 seconds" }).pipe(
      Effect.map((result) => (result.code === 0 ? parseVersion(result.stdout) : null)),
      Effect.catchTags({
        ProcessSpawnError: () => Effect.succeed(null),
        ProcessTimeoutError: () => Effect.succeed(null),
        ProcessOutputLimitError: () => Effect.succeed(null),
        ProcessReadError: () => Effect.succeed(null),
        ProcessStdinError: () => Effect.succeed(null),
      }),
    );

  const explicit = env.T3CODE_PYTHON?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    const version = yield* versionOf(explicit);
    if (version === null || !meetsMinimum(version)) {
      return yield* new PhononPythonInvalidError({
        path: explicit,
        version: version?.text ?? null,
      });
    }
    return {
      executable: explicit,
      major: version.major,
      minor: version.minor,
    } satisfies FoundPython;
  }

  const candidates: Array<PythonCandidate> = [];
  for (const command of ["python3.12", "python3.13", "python3", "python"]) {
    const executable = yield* resolveCommandPath(command, { env });
    if (executable === null) continue;
    const version = yield* versionOf(executable);
    candidates.push({ command, version: version?.text ?? null });
    if (version !== null && meetsMinimum(version)) {
      return { executable, major: version.major, minor: version.minor } satisfies FoundPython;
    }
  }
  return yield* new PhononPythonMissingError({ candidates });
});

const OUTPUT_TAIL_CHARS = 1_500;
const outputTail = (result: ProcessRunner.ProcessRunOutput) =>
  `${result.stdout}\n${result.stderr}`.trim().slice(-OUTPUT_TAIL_CHARS);

/** Where a venv keeps its interpreter. */
export const venvPython = (path: Path.Path, venv: string, platform: NodeJS.Platform) =>
  platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python");

// Longer than any staging directory lives: pip's own timeout ends an install first.
const STAGING_STALE_AFTER_MS = 60 * 60_000;
const PIP_TIMEOUT = "30 minutes";

/**
 * Builds the venv in a staging directory beside its destination and moves it
 * there in one rename, so a venv under the install root is always a complete
 * install: the venv directory is the install. Each pip output line is logged, which is how a long
 * install shows progress. Older installs are removed afterwards.
 */
export const installRuntime = Effect.fn("phononInstall.installRuntime")(function* (input: {
  readonly root: string;
  readonly directoryName: string;
  readonly release: PhononRelease;
  readonly python: FoundPython;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const destination = path.join(input.root, input.directoryName);

  const saveError = (cause: unknown) => new PhononInstallError({ stage: "save", cause });
  // pip's output arrives in a callback, so lines go through a queue to the log.
  const logged = yield* Queue.unbounded<string>();
  yield* Queue.take(logged).pipe(
    Effect.flatMap((line) => Effect.logInfo(`Transcription runtime install: ${line}`)),
    Effect.forever,
    Effect.forkScoped,
  );
  const run = (
    stage: (typeof INSTALL_STAGES)[number],
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly timeout: Duration.Input; readonly logLines?: boolean },
  ) => {
    let pending = "";
    const decoder = new TextDecoder();
    return runner
      .run({
        command,
        args,
        timeout: options.timeout,
        maxOutputBytes: 256 * 1024,
        outputMode: "truncate",
        ...(options.logLines === true
          ? {
              onStdoutChunk: (chunk: Uint8Array) => {
                pending += decoder.decode(chunk, { stream: true });
                const lines = pending.split("\n");
                pending = lines.pop() ?? "";
                for (const line of lines) {
                  if (line.trim().length > 0) Queue.offerUnsafe(logged, line.trim());
                }
              },
            }
          : {}),
      })
      .pipe(
        Effect.mapError((cause) => new PhononInstallError({ stage, cause })),
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result)
            : Effect.fail(
                new PhononInstallError({
                  stage,
                  exitCode: Number(result.code),
                  output: outputTail(result),
                }),
              ),
        ),
      );
  };

  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(input.root, { recursive: true }).pipe(Effect.mapError(saveError));
    const staging = yield* fs
      .makeTempDirectoryScoped({ directory: input.root, prefix: ".install-" })
      .pipe(Effect.mapError(saveError));
    const venv = path.join(staging, "venv");
    const python = venvPython(path, venv, platform);
    const requirements = path.join(staging, "requirements.txt");
    yield* fs
      .writeFileString(requirements, `${input.release.requirements.join("\n")}\n`)
      .pipe(Effect.mapError(saveError));

    yield* Effect.logInfo("Transcription runtime install: creating the Python environment.", {
      python: input.python.executable,
    });
    yield* run("venv", input.python.executable, ["-m", "venv", venv], { timeout: "5 minutes" });
    yield* Effect.logInfo(
      `Transcription runtime install: installing fermion-research ${FERMION_VERSION} (${input.release.requirements.length} packages).`,
    );
    yield* run(
      "pip",
      python,
      [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--progress-bar",
        "off",
        "-r",
        requirements,
      ],
      { timeout: PIP_TIMEOUT, logLines: true },
    );
    const verified = yield* run(
      "verify",
      python,
      ["-I", "-c", "import fermion; print(fermion.VERSION)"],
      { timeout: "2 minutes" },
    );
    if (verified.stdout.trim() !== FERMION_VERSION) {
      return yield* new PhononInstallError({ stage: "verify", output: outputTail(verified) });
    }
    // A directory left by an install that died after its rename would block this one.
    yield* fs
      .remove(destination, { recursive: true, force: true })
      .pipe(Effect.mapError(saveError));
    yield* fs.rename(venv, destination).pipe(Effect.mapError(saveError));
  }).pipe(Effect.scoped);

  // Older installs and abandoned staging directories. Two servers can share a
  // home, so a staging directory touched within the last hour may be another
  // server's install in progress and stays.
  const entries = yield* fs.readDirectory(input.root).pipe(Effect.mapError(saveError));
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.forEach(
    entries.filter((name) => name !== input.directoryName && name !== "worker.py"),
    (name) =>
      Effect.gen(function* () {
        const target = path.join(input.root, name);
        if (name.startsWith(".install-")) {
          const info = yield* fs.stat(target);
          const modifiedAt = Option.match(info.mtime, {
            onNone: () => now,
            onSome: (date) => date.getTime(),
          });
          if (now - modifiedAt < STAGING_STALE_AFTER_MS) return;
        }
        yield* fs.remove(target, { recursive: true, force: true });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not remove an old transcription runtime.", { name, cause }),
        ),
      ),
    { discard: true },
  );
  yield* Effect.logInfo("Transcription runtime install: done.", { destination });
  return venvPython(path, destination, platform);
}, Effect.scoped);
