// @effect-diagnostics globalTimers:off - The refresher runs on the host's timers, faked here.
import { ThreadId } from "@t3tools/contracts";
import { WORKSPACE_BRIDGE_METHODS } from "@t3tools/shared/mutationWorkspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  planWorkspaceAssets,
  startWorkspaceAssetUrlRefresher,
  streamedWorkspaceAssets,
  workspaceBridgeAssetIdentity,
  type MintedWorkspaceAsset,
} from "./mutationWorkspaceAssets.ts";
import { workspaceAssetSources, type WorkspaceAssetResource } from "./mutationWorkspaceHost.ts";

const threadId = ThreadId.make("thread-1");

const sources = workspaceAssetSources(
  threadId,
  {
    attachmentId: "doc-1",
    title: "Cut",
    assets: [
      { path: "/Volumes/X10/IMG_0151.MOV", name: "IMG_0151.MOV" },
      { path: "/work/voice.m4a", name: "voice.m4a" },
      { path: "/work/sales.csv", name: "sales.csv" },
    ],
  },
  [{ attachmentId: "img-1", name: "photo.png", mimeType: "image/png" }],
);

const minted: Record<string, MintedWorkspaceAsset> = {
  "img-1": { url: "https://env/api/assets/a/photo.png" },
  "/Volumes/X10/IMG_0151.MOV": {
    url: "https://env/api/assets/b/IMG_0151.MOV",
    file: { size: 643_000_000, contentType: "video/quicktime" },
  },
  "/work/voice.m4a": {
    url: "https://env/api/assets/c/voice.m4a",
    file: { size: 40_000_000, contentType: "audio/mp4" },
  },
  "/work/sales.csv": {
    url: "https://env/api/assets/d/sales.csv",
    file: { size: 120, contentType: "text/csv" },
  },
};

const keyOf = (resource: WorkspaceAssetResource) =>
  resource._tag === "attachment" ? resource.attachmentId : resource.path;

describe("planWorkspaceAssets", () => {
  it("streams video and audio by URL and size, and hands every other type over as bytes", async () => {
    const planned = await planWorkspaceAssets(
      sources,
      async (resource) => minted[keyOf(resource)]!,
    );
    expect(planned.map(({ mimeType, streams, size }) => ({ mimeType, streams, size }))).toEqual([
      { mimeType: "image/png", streams: false, size: null },
      { mimeType: "video/quicktime", streams: true, size: 643_000_000 },
      { mimeType: "audio/mp4", streams: true, size: 40_000_000 },
      { mimeType: "text/csv", streams: false, size: 120 },
    ]);
    expect(planned.map(workspaceBridgeAssetIdentity)).toEqual([
      { name: "photo.png", mimeType: "image/png", source: "attachment", attachmentId: "img-1" },
      {
        name: "IMG_0151.MOV",
        mimeType: "video/quicktime",
        source: "file",
        path: "/Volumes/X10/IMG_0151.MOV",
      },
      { name: "voice.m4a", mimeType: "audio/mp4", source: "file", path: "/work/voice.m4a" },
      { name: "sales.csv", mimeType: "text/csv", source: "file", path: "/work/sales.csv" },
    ]);
    expect(streamedWorkspaceAssets(planned).map(({ index, name }) => [index, name])).toEqual([
      [1, "IMG_0151.MOV"],
      [2, "voice.m4a"],
    ]);
  });

  it("fails instead of guessing when the environment does not say a file's type or size", async () => {
    await expect(
      planWorkspaceAssets(sources, async (resource) => ({ url: `https://env/${keyOf(resource)}` })),
    ).rejects.toThrow("did not say what kind of file IMG_0151.MOV is");
  });
});

describe("startWorkspaceAssetUrlRefresher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const clip = sources[1]!;
  const voice = sources[2]!;
  const assets = [
    { index: 1, name: clip.name, resource: clip.resource },
    { index: 2, name: voice.name, resource: voice.resource },
  ];

  it("re-mints each streamed URL before it expires and tells the page, until disposed", async () => {
    let round = 0;
    const notified: Array<unknown> = [];
    const refresher = startWorkspaceAssetUrlRefresher({
      assets,
      mint: async (resource) => `https://env/api/assets/r${round}/${keyOf(resource)}`,
      notify: (message) => notified.push(message),
      onError: (error) => {
        throw error;
      },
      refreshMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(notified).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(notified).toEqual([
      {
        jsonrpc: "2.0",
        method: WORKSPACE_BRIDGE_METHODS.assetUrl,
        params: {
          index: 1,
          name: "IMG_0151.MOV",
          url: "https://env/api/assets/r0//Volumes/X10/IMG_0151.MOV",
        },
      },
      {
        jsonrpc: "2.0",
        method: WORKSPACE_BRIDGE_METHODS.assetUrl,
        params: { index: 2, name: "voice.m4a", url: "https://env/api/assets/r0//work/voice.m4a" },
      },
    ]);
    round = 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notified).toHaveLength(4);
    refresher.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(notified).toHaveLength(4);
  });

  it("reports a failed renewal and retries only what it missed", async () => {
    let online = false;
    const errors: Array<unknown> = [];
    const renewed: Array<string> = [];
    const refresher = startWorkspaceAssetUrlRefresher({
      assets,
      mint: async (resource) => {
        if (!online && resource === clip.resource)
          throw new Error("Reconnect to this environment.");
        return `https://env/${keyOf(resource)}`;
      },
      notify: (message) => renewed.push(message.params.name),
      onError: (error) => errors.push(error),
      refreshMs: 10_000,
      retryMs: 100,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renewed).toEqual(["voice.m4a"]);
    expect(errors.map((error) => (error as Error).message)).toEqual([
      "Reconnect to this environment.",
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toHaveLength(2);
    online = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(renewed).toEqual(["voice.m4a", "IMG_0151.MOV"]);
    // Nothing more until the next refresh.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renewed).toHaveLength(2);
    refresher.dispose();
  });

  it("drops a renewal that lands after the page is gone", async () => {
    let release = () => undefined as void;
    const notified: Array<unknown> = [];
    const refresher = startWorkspaceAssetUrlRefresher({
      assets: assets.slice(0, 1),
      mint: () =>
        new Promise((resolve) => {
          release = () => resolve("https://env/late");
        }),
      notify: (message) => notified.push(message),
      onError: (error) => {
        throw error;
      },
      refreshMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    refresher.dispose();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(notified).toEqual([]);
  });
});
