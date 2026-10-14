import { describe, expect, it } from "vite-plus/test";

import { MAX_SERVED_FILE_FULL_BYTES, servedFileSpan } from "./headlessChrome.ts";

describe("servedFileSpan", () => {
  const MIB = 1024 * 1024;

  it("serves the range a media element asks for, at most a few MB per response", () => {
    expect(servedFileSpan("bytes=0-", 3 * 1024 * MIB)).toEqual({
      offset: 0,
      length: 4 * MIB,
      partial: true,
    });
    expect(servedFileSpan("bytes=10-19", 100)).toEqual({ offset: 10, length: 10, partial: true });
    expect(servedFileSpan("bytes=90-500", 100)).toEqual({ offset: 90, length: 10, partial: true });
    // A suffix range: the last 30 bytes, where a QuickTime file often keeps its index.
    expect(servedFileSpan("bytes=-30", 100)).toEqual({ offset: 70, length: 30, partial: true });
  });

  it("serves a whole file only up to the limit, and refuses ranges it cannot satisfy", () => {
    expect(servedFileSpan(undefined, 100)).toEqual({ offset: 0, length: 100, partial: false });
    expect(servedFileSpan(undefined, MAX_SERVED_FILE_FULL_BYTES + 1)).toBeNull();
    for (const header of ["bytes=100-", "bytes=5-2", "bytes=0-1,4-5", "items=0-1", "bytes=-"]) {
      expect(servedFileSpan(header, 100)).toBeNull();
    }
  });
});
