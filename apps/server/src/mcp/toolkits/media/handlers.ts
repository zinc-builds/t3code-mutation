import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { WORKSPACE_MUTATE_TOOL_NAME } from "@t3tools/shared/mutationWorkspace";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as MediaPrepare from "../../../mediaPrepare/MediaPrepare.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MEDIA_PREPARE_TOOL_NAME, MediaToolkit } from "./tools.ts";

const INVALID_REQUEST_ERRORS = new Set([
  "MediaPrepareRelativePathError",
  "MediaPrepareTooManyFilesError",
  "MediaPrepareToolMissingError",
]);

// Every media-prepare error message is built on the server and names the fix.
const toFailure = (error: MediaPrepare.MediaPrepareError) =>
  new OrchestratorMcpFailure({
    code: INVALID_REQUEST_ERRORS.has(error._tag) ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

/** What the agent does next with a result. */
export const mediaPrepareAdvice = (result: MediaPrepare.MediaPrepareResult) => {
  const { totals } = result;
  const failures =
    totals.failed === 0
      ? ""
      : ` ${totals.failed} failed; each says why in its error, and the rest are unaffected.`;
  if (result.pending.length > 0) {
    const activity = Option.match(result.activity, {
      onNone: () => "",
      onSome: (activity) => ` T3 is ${activity}.`,
    });
    return `Prepared ${totals.done} of ${totals.files}; ${totals.pending} are still in progress and keep going without you.${activity}${failures} Call ${MEDIA_PREPARE_TOOL_NAME} again with the same paths to collect them; finished files return instantly.`;
  }
  const transcribed =
    totals.transcribed === 0
      ? ""
      : ` Read the transcript files to choose what to keep. To edit, call ${WORKSPACE_MUTATE_TOOL_NAME} with template transcript-cut and pass as assets each original media file (its source path, used where it lives) and its transcript file.`;
  return `Prepared ${totals.files} (${totals.transcribed} transcribed, ${totals.words} words, ${totals.fromCache} from cache).${failures}${transcribed}`;
};

const handlers = {
  // It runs ffmpeg and a speech model over files on the host, so only agents
  // T3 launched, which already work on this machine, get it.
  media_prepare: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const media = yield* MediaPrepare.MediaPrepare;
      const result = yield* media
        .prepare({
          paths: input.paths,
          transcribe: input.transcribe ?? true,
          hotwords: input.hotwords ?? [],
        })
        .pipe(Effect.mapError(toFailure));
      return {
        files: result.files,
        pending: result.pending,
        totals: result.totals,
        message: mediaPrepareAdvice(result),
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof MediaToolkit.tools>;

export const layer = McpToolAccess.toLayer(MediaToolkit, handlers);
