import { expect, it } from "@effect/vitest";

import { parseFfprobe } from "./mediaProbe.ts";

it("reads an iPhone clip as displayed: rotated dimensions, frame rate, codec, audio", () => {
  expect(
    parseFfprobe({
      format: { duration: "261.026667" },
      streams: [
        {
          codec_type: "video",
          codec_name: "hevc",
          width: 3840,
          height: 2160,
          avg_frame_rate: "469800/19577",
          side_data_list: [{ rotation: -90 }],
        },
        { codec_type: "audio", codec_name: "aac", avg_frame_rate: "0/0" },
        { codec_type: "data" },
      ],
    }),
  ).toEqual({
    duration: 261.027,
    width: 2160,
    height: 3840,
    fps: 23.998,
    codec: "hevc",
    hasAudio: true,
  });
});

it("treats cover art as no video and names the audio codec", () => {
  expect(
    parseFfprobe({
      format: { duration: "12.5" },
      streams: [
        { codec_type: "audio", codec_name: "mp3" },
        {
          codec_type: "video",
          codec_name: "mjpeg",
          width: 600,
          height: 600,
          disposition: { attached_pic: 1 },
        },
      ],
    }),
  ).toEqual({ duration: 12.5, codec: "mp3", hasAudio: true });
});

it("finds nothing to edit in a file without media streams or a duration", () => {
  expect(parseFfprobe({ format: { duration: "3" }, streams: [{ codec_type: "data" }] })).toBeNull();
  expect(
    parseFfprobe({ format: {}, streams: [{ codec_type: "video", codec_name: "png" }] }),
  ).toBeNull();
});
