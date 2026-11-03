import { describe, expect, it } from "vite-plus/test";

import { instantChartsForRequest, matchInstantWorkspace } from "./instantWorkspace.ts";

const match = (text: string, hasImageAttachment = false) =>
  matchInstantWorkspace({ text, hasImageAttachment });

describe("matchInstantWorkspace", () => {
  it.each([
    ["Open sunset.jpg in an editor so I can grade it myself.", "photo-develop", "sunset.jpg"],
    ["Let me cut clip.mp4 down myself, open it in an editor.", "video-edit", "clip.mp4"],
    ["Explore trips.csv with me interactively.", "data-explore", "trips.csv"],
    ["let me trim ./audio/talk.wav by hand", "audio-edit", "./audio/talk.wav"],
  ])("opens a workspace for %s", (text, templateId, file) => {
    expect(match(text)).toEqual({ templateId, file });
  });

  it("opens an attached image", () => {
    expect(match("open this in an editor so I can grade it", true)).toEqual({
      templateId: "photo-develop",
      file: undefined,
    });
  });

  it.each([
    "Make sunset.jpg black and white and save it as sunset-bw.jpg.",
    "How many rows does trips.csv have?",
    "Let me know how many rows trips.csv has.",
    "Edit sunset.jpg to be warmer.",
    "Explore trips.csv and tell me the top city.",
    "Open sunset.jpg in gimp so I can edit it myself.",
    "Let me cut clip.mp4 and other.mp4 myself.",
    "/goal let me cut clip.mp4 myself",
    "Let me edit notes.txt myself.",
    "Let me edit this myself.",
  ])("leaves %s to the agent", (text) => {
    expect(match(text)).toBeUndefined();
  });
});

describe("instantChartsForRequest", () => {
  const header = "trip_id,distance_km,duration_min,city";

  it("charts the two columns a request names", () => {
    expect(instantChartsForRequest("how distance relates to duration", header)).toEqual([
      { type: "scatter", x: "distance_km", y: "duration_min" },
      { type: "histogram", x: "duration_min" },
    ]);
  });

  it("leaves the template's own charts without two named columns", () => {
    expect(instantChartsForRequest("show me the distance", header)).toBeUndefined();
  });
});
