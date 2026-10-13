import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  loadWorkspaceAsset,
  prefetchWorkspaceAsset,
  setWorkspaceAssetScope,
  workspaceAssetKey,
} from "./workspaceAssetCache";

const environmentId = "env-1" as EnvironmentId;
const threadId = "thread-1" as ThreadId;
const photo = workspaceAssetKey(environmentId, {
  _tag: "attachment",
  attachmentId: "photo",
  fileName: "photo.jpg",
  mimeType: "image/jpeg",
});
const clip = workspaceAssetKey(environmentId, {
  _tag: "workspace-asset",
  threadId,
  path: "/m/clip.mp4",
});

/** A loader that counts its calls and resolves to a blob naming the call. */
const counting = () => {
  let calls = 0;
  const load = () => {
    calls += 1;
    return Promise.resolve(new Blob([`load ${calls}`]));
  };
  return { load, calls: () => calls };
};

const text = (loaded: { readonly blob: Promise<Blob> }) => loaded.blob.then((blob) => blob.text());

let scope = 0;
beforeEach(() => setWorkspaceAssetScope(`thread-${(scope += 1)}`));

describe("workspace asset cache", () => {
  it("answers a page from its prefetch, sharing attachments with later pages", async () => {
    const loader = counting();
    prefetchWorkspaceAsset(photo, true, loader.load);
    prefetchWorkspaceAsset(photo, true, loader.load);
    const first = loadWorkspaceAsset(photo, true, loader.load);
    const second = loadWorkspaceAsset(photo, true, loader.load);
    expect([first.prefetched, second.prefetched]).toEqual([true, true]);
    expect([await text(first), await text(second)]).toEqual(["load 1", "load 1"]);
    expect(loader.calls()).toBe(1);
  });

  it("hands a prefetched file to one page only, and only while it is fresh", async () => {
    const loader = counting();
    prefetchWorkspaceAsset(clip, false, loader.load, 0);
    const first = loadWorkspaceAsset(clip, false, loader.load, 1_000);
    const second = loadWorkspaceAsset(clip, false, loader.load, 2_000);
    expect([first.prefetched, second.prefetched]).toEqual([true, false]);
    expect(await text(second)).toBe("load 2");

    prefetchWorkspaceAsset(clip, false, loader.load, 10_000);
    const stale = loadWorkspaceAsset(clip, false, loader.load, 80_000);
    expect(stale.prefetched).toBe(false);
    expect(await text(stale)).toBe("load 4");
  });

  it("forgets a failed load, so the page's own request tries again", async () => {
    prefetchWorkspaceAsset(photo, true, () => Promise.reject(new Error("offline")));
    await Promise.resolve();
    const retried = loadWorkspaceAsset(photo, true, () => Promise.resolve(new Blob(["ok"])));
    expect(retried.prefetched).toBe(false);
    expect(await text(retried)).toBe("ok");
  });

  it("starts over when the thread changes", () => {
    const loader = counting();
    prefetchWorkspaceAsset(photo, true, loader.load);
    setWorkspaceAssetScope("another-thread");
    expect(loadWorkspaceAsset(photo, true, loader.load).prefetched).toBe(false);
    expect(loader.calls()).toBe(2);
  });

  it("keeps a bounded number of assets, dropping the least recently used", () => {
    const loader = counting();
    const keys = Array.from({ length: 13 }, (_, index) =>
      workspaceAssetKey(environmentId, {
        _tag: "attachment",
        attachmentId: `image-${index}`,
        fileName: "x.png",
        mimeType: "image/png",
      }),
    );
    prefetchWorkspaceAsset(keys[0]!, true, loader.load);
    prefetchWorkspaceAsset(keys[1]!, true, loader.load);
    // Using the first makes the second the oldest.
    loadWorkspaceAsset(keys[0]!, true, loader.load);
    for (const key of keys.slice(2)) prefetchWorkspaceAsset(key, true, loader.load);
    expect(loadWorkspaceAsset(keys[0]!, true, loader.load).prefetched).toBe(true);
    expect(loadWorkspaceAsset(keys[1]!, true, loader.load).prefetched).toBe(false);
  });
});
