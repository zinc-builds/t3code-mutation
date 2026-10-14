import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { WORKSPACE_MUTATE_TOOL_NAME } from "@t3tools/shared/mutationWorkspace";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as MediaPrepare from "../../../mediaPrepare/MediaPrepare.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const MEDIA_PREPARE_TOOL_NAME = "media_prepare";

const MediaPrepareTool = Tool.make(MEDIA_PREPARE_TOOL_NAME, {
  description: `Prepare video and audio files on this machine for editing by what is said in them: probe each (duration, size, frame rate, codec, audio) and transcribe its speech with word timestamps (Phonon-2, English). Call it before building a cut-by-content editor with ${WORKSPACE_MUTATE_TOOL_NAME}, for requests like "edit the most insightful moments of these clips". Pass files or folders; folders expand to their video and audio files. The media stays where it is; the only new files are transcripts in T3's cache, and repeat calls are instant. Each transcript file is JSON {v, source, duration, model, text, segments: [{start, end, text}], words: [{start, end, text}]}, times in seconds of its source; read them to choose what to keep. The first transcription on a machine installs T3's speech runtime (a few minutes); a call returns after about 45 s with what is done and lists the rest as pending, which keep going: call again with the same paths to collect them.`,
  parameters: Schema.Struct({
    paths: Schema.Array(Schema.String.check(Schema.isMinLength(1)))
      .check(Schema.isMinLength(1), Schema.isMaxLength(MediaPrepare.MEDIA_PREPARE_MAX_FILES))
      .annotate({ description: "Absolute paths of media files or folders on this machine." }),
    transcribe: Schema.optional(Schema.Boolean).annotate({
      description: "Transcribe speech. Default true; false only probes.",
    }),
    hotwords: Schema.optional(
      Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))).check(
        Schema.isMaxLength(MediaPrepare.MEDIA_PREPARE_MAX_HOTWORDS),
      ),
    ).annotate({
      description: `Up to ${MediaPrepare.MEDIA_PREPARE_MAX_HOTWORDS} names and terms the transcription should get right (people, products, jargon). Words not said stay out.`,
    }),
  }),
  success: Schema.Struct({
    files: Schema.Array(MediaPrepare.PreparedFile).annotate({
      description:
        "One entry per finished source: source is its absolute path, transcript the absolute path of its transcript file and words its word count. error says why a file or path failed.",
    }),
    pending: Schema.Array(Schema.String).annotate({
      description: "Sources still being prepared; call again with the same paths to collect them.",
    }),
    totals: MediaPrepare.MediaPrepareTotals,
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    MediaPrepare.MediaPrepare,
  ],
})
  .annotate(Tool.Title, "Prepare media")
  // It writes only T3's own cache and runtime, never the user's files.
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const MediaToolkit = Toolkit.make(MediaPrepareTool);
