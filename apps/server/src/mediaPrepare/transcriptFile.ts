import * as Schema from "effect/Schema";

/** One timed stretch of speech, in seconds from the start of the source. */
const TimedText = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  text: Schema.String,
});
type TimedText = typeof TimedText.Type;

/** What the Phonon worker returns for one source. */
export const WorkerTranscript = Schema.Struct({
  text: Schema.String,
  segments: Schema.Array(TimedText),
  words: Schema.Array(TimedText),
  audioSeconds: Schema.Number,
  decodeSeconds: Schema.Number,
  truncated: Schema.Boolean,
});
export type WorkerTranscript = typeof WorkerTranscript.Type;

/**
 * The transcript file `media_prepare` writes, one per source. Workspace
 * templates such as transcript-cut read this exact shape, so a change to it
 * bumps `v`.
 */
export const TranscriptFile = Schema.Struct({
  v: Schema.Literal(1),
  source: Schema.String,
  duration: Schema.Number,
  model: Schema.String,
  text: Schema.String,
  segments: Schema.Array(TimedText),
  words: Schema.Array(TimedText),
});
export type TranscriptFile = typeof TranscriptFile.Type;

export const TRANSCRIPT_FILE_VERSION = 1;

const millis = (seconds: number) => Math.round(seconds * 1000) / 1000;
const timed = (entry: TimedText): TimedText => ({
  start: millis(entry.start),
  end: millis(entry.end),
  text: entry.text,
});

export const makeTranscriptFile = (input: {
  readonly source: string;
  readonly duration: number;
  readonly model: string;
  readonly transcript: WorkerTranscript;
}): TranscriptFile => ({
  v: TRANSCRIPT_FILE_VERSION,
  source: input.source,
  duration: input.duration,
  model: input.model,
  text: input.transcript.text,
  segments: input.transcript.segments.map(timed),
  words: input.transcript.words.map(timed),
});

export const encodeTranscriptFile = Schema.encodeEffect(Schema.fromJsonString(TranscriptFile));
export const decodeTranscriptFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(TranscriptFile),
);
