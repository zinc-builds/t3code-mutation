import { expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Tool } from "effect/ai";

import { mediaPrepareAdvice } from "./handlers.ts";
import { MediaToolkit } from "./tools.ts";

const totals = {
  files: 3,
  done: 3,
  pending: 0,
  failed: 1,
  transcribed: 2,
  fromCache: 0,
  mediaSeconds: 30,
  words: 120,
  elapsedSeconds: 4,
};

it("gives media_prepare an object input schema with paths required", () => {
  const schema = Tool.getJsonSchema(MediaToolkit.tools.media_prepare);
  expect(schema.type).toBe("object");
  expect(schema.required).toEqual(["paths"]);
});

it("points a finished result at the original media and the transcripts", () => {
  const advice = mediaPrepareAdvice({ files: [], pending: [], totals, activity: Option.none() });
  expect(advice).toContain("1 failed; each says why in its error");
  expect(advice).toContain("workspace_mutate with template transcript-cut");
  expect(advice).toContain("each original media file (its source path, used where it lives)");
});

it("tells the agent to call again while files are pending", () => {
  const advice = mediaPrepareAdvice({
    files: [],
    pending: ["/media/a.mov", "/media/b.mov"],
    totals: { ...totals, done: 1, pending: 2, failed: 0 },
    activity: Option.some("installing the transcription runtime (one time, a few minutes)"),
  });
  expect(advice).toBe(
    "Prepared 1 of 3; 2 are still in progress and keep going without you. T3 is installing the transcription runtime (one time, a few minutes). Call media_prepare again with the same paths to collect them; finished files return instantly.",
  );
});
