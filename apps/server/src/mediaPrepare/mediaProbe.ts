import * as Schema from "effect/Schema";

/**
 * What ffprobe says a source holds. Width and height are as displayed, after
 * rotation; codec is the video codec, or the audio codec of an audio file.
 */
export const MediaProbe = Schema.Struct({
  duration: Schema.Number,
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  fps: Schema.optional(Schema.Number),
  codec: Schema.optional(Schema.String),
  hasAudio: Schema.Boolean,
});
export type MediaProbe = typeof MediaProbe.Type;

/** ffprobe's arguments for the JSON `parseFfprobe` reads. */
export const ffprobeArgs = (source: string) => [
  "-v",
  "error",
  "-print_format",
  "json",
  "-show_format",
  "-show_streams",
  source,
];

const FfprobeStream = Schema.Struct({
  codec_type: Schema.optional(Schema.String),
  codec_name: Schema.optional(Schema.String),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  avg_frame_rate: Schema.optional(Schema.String),
  r_frame_rate: Schema.optional(Schema.String),
  duration: Schema.optional(Schema.String),
  disposition: Schema.optional(Schema.Struct({ attached_pic: Schema.optional(Schema.Number) })),
  tags: Schema.optional(Schema.Struct({ rotate: Schema.optional(Schema.String) })),
  side_data_list: Schema.optional(
    Schema.Array(Schema.Struct({ rotation: Schema.optional(Schema.Number) })),
  ),
});

const FfprobeOutput = Schema.Struct({
  format: Schema.optional(Schema.Struct({ duration: Schema.optional(Schema.String) })),
  streams: Schema.optional(Schema.Array(FfprobeStream)),
});

export const decodeFfprobeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(FfprobeOutput));

const round = (value: number, places: number) => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

const positive = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;

/** "30000/1001" as a number; ffprobe writes "0/0" when it does not know. */
const frameRate = (rate: string | undefined) => {
  if (rate === undefined) return undefined;
  const [numerator, denominator] = rate.split("/").map(Number);
  return numerator === undefined || denominator === undefined || denominator === 0
    ? undefined
    : positive(numerator / denominator);
};

/**
 * Reads ffprobe's JSON. Null when the file holds neither a video nor an audio
 * stream, or no duration, which is what a workspace cannot edit.
 */
export const parseFfprobe = (output: typeof FfprobeOutput.Type): MediaProbe | null => {
  const streams = output.streams ?? [];
  // Cover art in an audio file is a video stream marked attached_pic.
  const video = streams.find(
    (stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1,
  );
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const hasAudio = audio !== undefined;
  if (video === undefined && !hasAudio) return null;
  const duration =
    positive(Number(output.format?.duration)) ??
    positive(Math.max(...streams.map((stream) => Number(stream.duration ?? 0))));
  if (duration === undefined) return null;
  const rotation = Math.abs(
    video?.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ??
      Number(video?.tags?.rotate ?? 0),
  );
  const quarterTurn = rotation % 180 === 90;
  const fps = frameRate(video?.avg_frame_rate) ?? frameRate(video?.r_frame_rate);
  // The video's codec, or the audio's for an audio file.
  const codec = (video ?? audio)?.codec_name;
  return {
    duration: round(duration, 3),
    ...(video?.width === undefined || video.height === undefined
      ? {}
      : quarterTurn
        ? { width: video.height, height: video.width }
        : { width: video.width, height: video.height }),
    ...(fps === undefined ? {} : { fps: round(fps, 3) }),
    ...(codec === undefined ? {} : { codec }),
    hasAudio,
  };
};
