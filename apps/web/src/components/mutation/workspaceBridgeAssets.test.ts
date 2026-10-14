import { planWorkspaceAssets } from "@t3tools/client-runtime/state/mutation-workspace-assets";
import { workspaceAssetSources } from "@t3tools/client-runtime/state/mutation-workspace-host";
import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { loadWorkspaceBridgeAssets } from "./workspaceBridgeAssets";

const sources = workspaceAssetSources(
  "thread-1" as ThreadId,
  {
    attachmentId: "doc-1",
    title: "Cut",
    assets: [
      { path: "/Volumes/X10/IMG_0151.MOV", name: "IMG_0151.MOV" },
      { path: "/work/sales.csv", name: "sales.csv" },
    ],
  },
  [],
);

describe("loadWorkspaceBridgeAssets", () => {
  it("never reads a streamed asset's bytes, and hands every other asset over as a File", async () => {
    const planned = await planWorkspaceAssets(sources, async (resource) =>
      resource._tag === "workspace-asset" && resource.path.endsWith(".MOV")
        ? {
            url: "https://env/api/assets/t/IMG_0151.MOV",
            file: { size: 643_000_000, contentType: "video/quicktime" },
          }
        : { url: "https://env/api/assets/t/sales.csv", file: { size: 9, contentType: "text/csv" } },
    );
    const read: Array<string> = [];
    const assets = await loadWorkspaceBridgeAssets(planned, async (asset) => {
      read.push(asset.url);
      return new Blob(["region,total"]);
    });
    expect(read).toEqual(["https://env/api/assets/t/sales.csv"]);
    expect(assets[0]).toEqual({
      name: "IMG_0151.MOV",
      mimeType: "video/quicktime",
      source: "file",
      path: "/Volumes/X10/IMG_0151.MOV",
      url: "https://env/api/assets/t/IMG_0151.MOV",
      size: 643_000_000,
    });
    const csv = assets[1]!;
    if (!("file" in csv)) throw new Error("Expected the table as a File");
    expect([csv.file.name, csv.file.type, await csv.file.text()]).toEqual([
      "sales.csv",
      "text/csv",
      "region,total",
    ]);
  });
});
