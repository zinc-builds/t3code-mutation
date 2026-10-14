import { assert, describe, it } from "@effect/vitest";

import { planFfmpegDryRun, stderrTail } from "./ffmpegCommand.ts";

const assets = new Set(["/Users/me/clips/a b.mp4"]);

const argsOf = (command: string) => {
  const plan = planFfmpegDryRun(command, assets);
  if (!plan.ok) throw new Error(plan.reason);
  return plan.args;
};

const reasonOf = (command: string) => {
  const plan = planFfmpegDryRun(command, assets);
  return plan.ok ? assert.fail(`planned ${plan.args.join(" ")}`) : plan.reason;
};

describe("planFfmpegDryRun", () => {
  it("splits a template's multi-line command and limits its output to half a second", () => {
    const command = [
      "ffmpeg -y \\",
      "  -i 'a b.mp4' \\",
      "  -filter_complex '[0:v]trim=start=0:end=2,setpts=(PTS-STARTPTS)/1.5[v0];[v0]concat=n=1[outv]' \\",
      '  -map "[outv]" -c:v libx264 -movflags +faststart \\',
      "  'cut.mp4'",
    ].join("\n");
    assert.deepEqual(argsOf(command), [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-y",
      "-i",
      "a b.mp4",
      "-filter_complex",
      "[0:v]trim=start=0:end=2,setpts=(PTS-STARTPTS)/1.5[v0];[v0]concat=n=1[outv]",
      "-map",
      "[outv]",
      "-c:v",
      "libx264",
      "-movflags",
      "+faststart",
      "-t",
      "0.5",
      "cut.mp4",
    ]);
  });

  it("lets a command read an asset by its absolute path", () => {
    assert.include(
      argsOf("ffmpeg -i '/Users/me/clips/a b.mp4' -af volume=2 out.m4a"),
      "/Users/me/clips/a b.mp4",
    );
  });

  it("refuses shell syntax, other programs, and commands without an output", () => {
    assert.include(reasonOf("ffmpeg -i a.mp4 out.mp4; echo hi"), "shell syntax (;)");
    assert.include(reasonOf("ffmpeg -i a.mp4 -map [out] *.mp4"), "an unquoted *");
    assert.include(reasonOf("ffmpeg -i a.mp4 out.mp4 # done"), "shell syntax (#)");
    assert.include(reasonOf("sox a.wav b.wav"), "not an ffmpeg command");
    assert.include(reasonOf("ffmpeg -i a.mp4 -y"), "not an output file");
  });

  it("refuses paths outside the assets and scratch folder, URLs, and file-writing options", () => {
    assert.include(reasonOf("ffmpeg -i /etc/hosts out.mp4"), "outside the workspace's assets");
    assert.include(reasonOf("ffmpeg -i ../a.mp4 out.mp4"), "outside the workspace's assets");
    assert.include(reasonOf("ffmpeg -i a.mp4 ~/out.mp4"), "outside the workspace's assets");
    assert.include(
      reasonOf("ffmpeg -i a.mp4 -vf 'signature=filename=/tmp/sig' out.mp4"),
      "outside the workspace's assets",
    );
    assert.include(reasonOf("ffmpeg -i https://example.com/a.mp4 out.mp4"), "names a URL");
    assert.include(reasonOf("ffmpeg -i a.mp4 -vstats_file stats.txt out.mp4"), "-vstats_file");
    assert.include(reasonOf("ffmpeg -i a.mp4 -/filter graph.txt out.mp4"), "-/filter");
    assert.include(
      reasonOf("ffmpeg -i a.mp4 '/Users/me/clips/a b.mp4'"),
      "writes over one of its own assets",
    );
  });
});

describe("stderrTail", () => {
  it("keeps the end, where ffmpeg names what failed", () => {
    assert.strictEqual(stderrTail("  short \n"), "short");
    assert.strictEqual(stderrTail(`${"x".repeat(50)}No such filter`, 14), "…No such filter");
  });
});
