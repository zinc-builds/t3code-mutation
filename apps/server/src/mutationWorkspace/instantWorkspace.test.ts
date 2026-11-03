import { describe, expect, it } from "vite-plus/test";

import { instantChartsForRequest, matchInstantWorkspace } from "./instantWorkspace.ts";

const match = (text: string, imageAttachments = 0) =>
  matchInstantWorkspace({ text, imageAttachments });

describe("matchInstantWorkspace", () => {
  it.each([
    ["Open sunset.jpg in an editor so I can grade it myself.", "photo-develop", "sunset.jpg"],
    ["Let me cut clip.mp4 down myself, open it in an editor.", "video-edit", "clip.mp4"],
    ["Explore trips.csv with me interactively.", "data-explore", "trips.csv"],
    ["let me trim ./audio/talk.wav by hand", "audio-edit", "./audio/talk.wav"],
  ])("opens a workspace for %s", (text, templateId, file) => {
    expect(match(text)).toEqual({ templateId, file });
  });

  it("leaves a named file with an attached image to the agent", () => {
    expect(match("Open sunset.jpg in an editor so I can grade it myself.", 1)).toBeUndefined();
  });

  it("leaves several attached images to the agent", () => {
    expect(match("open the second one in an editor so I can grade it", 2)).toBeUndefined();
  });

  it("opens an attached image", () => {
    expect(match("open this in an editor so I can grade it", 1)).toEqual({
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
  const sample = "trip_id,distance_km,duration_min,city\n1,10.2,34.5,Leeds\n2,4.5,19.8,York\n3,1";
  const charts = (text: string, file = "trips.csv") =>
    instantChartsForRequest({ text, file, sample, truncated: true });

  it("charts the two number columns a request names", () => {
    expect(charts("how distance relates to duration")).toEqual([
      { type: "scatter", x: "distance_km", y: "duration_min" },
      { type: "histogram", x: "duration_min" },
    ]);
  });

  it.each([
    ["only one column", "show me the distance", "trips.csv"],
    ["a text column", "how distance varies by city", "trips.csv"],
    ["an id column", "each trip_id against distance", "trips.csv"],
    ["a word in the filename", "explore distance.csv against nothing", "distance.csv"],
  ])("keeps the template's charts for %s", (_, text, file) => {
    expect(charts(text, file)).toBeUndefined();
  });

  it("uses the last row of a whole file with no trailing newline", () => {
    expect(
      instantChartsForRequest({
        text: "distance against duration",
        file: "a.csv",
        sample: "distance_km,duration_min\n10,20",
        truncated: false,
      }),
    ).toHaveLength(2);
  });

  it("does not trust the last line of a cut-off sample", () => {
    expect(
      instantChartsForRequest({
        text: "distance against duration",
        file: "a.csv",
        sample: "distance_km,duration_min\n10,20",
        truncated: true,
      }),
    ).toBeUndefined();
  });

  it("skips a word that fits two columns", () => {
    const ambiguous = "time_start,time_end,cost\n1,2,3\n4,5,6\n";
    expect(
      instantChartsForRequest({
        text: "time against cost",
        file: "a.csv",
        sample: ambiguous,
        truncated: false,
      }),
    ).toBeUndefined();
  });
});
