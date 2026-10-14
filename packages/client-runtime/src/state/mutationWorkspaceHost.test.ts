import { ThreadId } from "@t3tools/contracts";
import {
  WORKSPACE_BRIDGE_METHODS,
  type WorkspaceReference,
} from "@t3tools/shared/mutationWorkspace";
import { describe, expect, it } from "vite-plus/test";

import {
  workspaceAssetSources,
  workspaceControlsNotification,
  workspaceFileName,
  workspaceInitialPageState,
  workspaceStateWithPage,
} from "./mutationWorkspaceHost.ts";

const threadId = ThreadId.make("thread-1");

const bare: WorkspaceReference = {
  attachmentId: "doc-1",
  title: "Photo editor",
  assets: [{ path: "/work/clip.mp4", name: "clip.mp4" }],
};

const withChrome: WorkspaceReference = {
  ...bare,
  chrome: {
    inspector: [
      {
        title: "Light",
        controls: [
          {
            type: "slider",
            id: "exposure",
            label: "Exposure",
            min: -5,
            max: 5,
            step: 0.1,
            value: 0,
          },
        ],
      },
    ],
  },
};

describe("workspaceAssetSources", () => {
  it("lists the thread's images, then the agent's files, each named as the agent knows it", () => {
    const sources = workspaceAssetSources(threadId, bare, [
      { attachmentId: "img-1", name: "photo.png", mimeType: "image/png" },
    ]);
    expect(sources).toEqual([
      {
        resource: {
          _tag: "attachment",
          attachmentId: "img-1",
          fileName: "photo.png",
          mimeType: "image/png",
        },
        name: "photo.png",
        mimeType: "image/png",
        source: "attachment",
        attachmentId: "img-1",
      },
      {
        resource: { _tag: "workspace-asset", threadId, path: "/work/clip.mp4" },
        name: "clip.mp4",
        mimeType: null,
        source: "file",
        path: "/work/clip.mp4",
      },
    ]);
  });
});

describe("workspaceFileName", () => {
  it("takes the last segment of either separator", () => {
    expect(workspaceFileName("/a/b/c.png")).toBe("c.png");
    expect(workspaceFileName("C:\\a\\d.mov")).toBe("d.mov");
  });
});

describe("workspaceInitialPageState", () => {
  it("is undefined before the page stored anything", () => {
    expect(workspaceInitialPageState(null)).toBeUndefined();
  });

  it("is the page's own part of a chrome envelope", () => {
    expect(workspaceInitialPageState({ controls: { exposure: 1 }, page: { zoom: 2 } })).toEqual({
      zoom: 2,
    });
    expect(workspaceInitialPageState({ zoom: 3 })).toEqual({ zoom: 3 });
  });
});

describe("workspaceStateWithPage", () => {
  it("stores the page's state as is without chrome", () => {
    expect(workspaceStateWithPage(bare, { zoom: 1 }, { zoom: 2 })).toEqual({ zoom: 2 });
    expect(workspaceStateWithPage(bare, null, undefined)).toBeNull();
  });

  it("keeps the stored control values beside the page's state", () => {
    expect(
      workspaceStateWithPage(
        withChrome,
        { controls: { exposure: 2 }, page: { zoom: 1 } },
        {
          zoom: 4,
        },
      ),
    ).toEqual({ controls: { exposure: 2 }, page: { zoom: 4 } });
  });

  it("starts the control values from the manifest before any were stored", () => {
    expect(workspaceStateWithPage(withChrome, null, { zoom: 4 })).toEqual({
      controls: { exposure: 0 },
      page: { zoom: 4 },
    });
  });
});

describe("workspaceControlsNotification", () => {
  it("tells a page with chrome its values", () => {
    expect(workspaceControlsNotification(withChrome, { controls: { exposure: 2 } })).toEqual({
      jsonrpc: "2.0",
      method: WORKSPACE_BRIDGE_METHODS.controls,
      params: { values: { exposure: 2 } },
    });
    expect(workspaceControlsNotification(withChrome, null)?.params).toEqual({
      values: { exposure: 0 },
    });
  });

  it("is null without chrome", () => {
    expect(workspaceControlsNotification(bare, null)).toBeNull();
  });
});
