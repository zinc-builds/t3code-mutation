import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { findPython } from "./phononInstall.ts";
import * as PhononRuntime from "./PhononRuntime.ts";

// Speaks the worker protocol like phononWorkerScript.ts, answering by path.
const FAKE_WORKER = String.raw`
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
if (process.argv[2] === "fatal") {
  send({ type: "fatal", message: "ImportError: No module named 'mlx'" });
  process.exit(1);
}
send({ type: "ready", fermion: "0.2.11", loadSeconds: 0.1 });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.path.includes("crash")) {
    process.stderr.write("Fatal Python error: Segmentation fault\n");
    process.exit(139);
  }
  if (request.path.includes("bad")) {
    send({ type: "error", id: request.id, message: "RuntimeError: ffmpeg decoded no audio samples." });
    return;
  }
  send({
    type: "result",
    id: request.id,
    transcript: {
      text: "worker " + process.pid + " heard " + request.hotwords.join(","),
      segments: [],
      words: [{ start: 0, end: 0.25, text: "hi" }],
      audioSeconds: 1,
      decodeSeconds: 0.01,
      truncated: false,
    },
  });
});
`;

const tempDir = (prefix: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })));

const fakeWorkerRuntime = (mode: "serve" | "fatal") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* tempDir("t3-phonon-");
    const script = path.join(root, "fake-worker.cjs");
    yield* fs.writeFileString(script, FAKE_WORKER);
    return yield* PhononRuntime.makePhononRuntime({
      root,
      workerCommand: { command: process.execPath, args: [script, mode] },
    }).pipe(Effect.provide(ProcessRunner.layer));
  });

const request = (path: string, hotwords: ReadonlyArray<string> = []) => ({
  path,
  ffmpeg: "/usr/bin/ffmpeg",
  hotwords,
});

/** A PATH directory whose `name` prints `version` the way Python's version check does. */
const fakePython = (name: string, version: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = yield* tempDir("t3-python-bin-");
    const executable = path.join(bin, name);
    yield* fs.writeFileString(executable, `#!/bin/sh\necho ${version}\n`);
    yield* fs.chmod(executable, 0o755);
    return { bin, executable };
  });

describe("PhononRuntime", () => {
  it.live("keeps one worker for successive files and reports a file's own failure", () =>
    Effect.gen(function* () {
      const runtime = yield* fakeWorkerRuntime("serve");
      const first = yield* runtime.transcribe(request("/media/a.mov", ["Ada"]));
      const failed = yield* runtime.transcribe(request("/media/bad.mov")).pipe(Effect.flip);
      const second = yield* runtime.transcribe(request("/media/b.mov"));

      expect(first.text).toMatch(/^worker \d+ heard Ada$/);
      expect(first.words).toEqual([{ start: 0, end: 0.25, text: "hi" }]);
      expect(failed).toMatchObject({
        _tag: "PhononTranscribeError",
        message: "Transcription failed: RuntimeError: ffmpeg decoded no audio samples.",
      });
      expect(second.text.split(" ")[1]).toBe(first.text.split(" ")[1]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails the file a crash interrupts with its cause, then starts a new worker", () =>
    Effect.gen(function* () {
      const runtime = yield* fakeWorkerRuntime("serve");
      const before = yield* runtime.transcribe(request("/media/a.mov"));
      const crashed = yield* runtime.transcribe(request("/media/crash.mov")).pipe(Effect.flip);
      const after = yield* runtime.transcribe(request("/media/b.mov"));

      expect(crashed).toMatchObject({ _tag: "PhononWorkerCrashedError", exitCode: 139 });
      expect(crashed.message).toContain("Fatal Python error: Segmentation fault");
      expect(after.text.split(" ")[1]).not.toBe(before.text.split(" ")[1]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reports why the model would not load", () =>
    Effect.gen(function* () {
      const runtime = yield* fakeWorkerRuntime("fatal");
      const error = yield* runtime.transcribe(request("/media/a.mov")).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PhononWorkerStartError" });
      expect(error.message).toBe(
        "The transcription worker could not load Phonon-2: ImportError: No module named 'mlx'",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("says what to install when this machine has no usable Python", () =>
    Effect.gen(function* () {
      const empty = yield* tempDir("t3-no-python-");
      const runtime = yield* PhononRuntime.makePhononRuntime({ root: empty }).pipe(
        Effect.provide(ProcessRunner.layer),
      );
      const error = yield* runtime
        .transcribe(request("/media/a.mov"))
        .pipe(Effect.provideService(HostProcess.Environment, { PATH: empty }), Effect.flip);
      expect(error._tag).toBe("PhononPythonMissingError");
      expect(error.message).toContain("none was found on PATH");
      expect(error.message).toContain("`brew install python@3.12`");
      expect(error.message).toContain("T3CODE_PYTHON");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("findPython", () => {
  it.live("names the Python it found when it is too old", () =>
    Effect.gen(function* () {
      const { bin } = yield* fakePython("python3", "3.11.2");
      const error = yield* findPython().pipe(
        Effect.provideService(HostProcess.Environment, { PATH: bin }),
        Effect.flip,
      );
      expect(error._tag).toBe("PhononPythonMissingError");
      expect(error.message).toContain("only python3 (3.11.2) was found");
    }).pipe(Effect.provide(ProcessRunner.layer), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("uses T3CODE_PYTHON alone when it is set", () =>
    Effect.gen(function* () {
      const old = yield* fakePython("python-old", "3.10.14");
      const good = yield* fakePython("python3.12", "3.12.12");
      const refused = yield* findPython().pipe(
        Effect.provideService(HostProcess.Environment, {
          PATH: good.bin,
          T3CODE_PYTHON: old.executable,
        }),
        Effect.flip,
      );
      expect(refused).toMatchObject({ _tag: "PhononPythonInvalidError", version: "3.10.14" });

      const found = yield* findPython().pipe(
        Effect.provideService(HostProcess.Environment, { PATH: good.bin }),
      );
      expect(found).toEqual({ executable: good.executable, major: 3, minor: 12 });
    }).pipe(Effect.provide(ProcessRunner.layer), Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
