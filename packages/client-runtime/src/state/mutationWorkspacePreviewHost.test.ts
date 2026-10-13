import type {
  WorkspacePreviewAction,
  WorkspacePreviewActResult,
  WorkspacePreviewEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createWorkspacePreviewHost,
  type WorkspacePreviewChange,
} from "./mutationWorkspacePreviewHost.ts";

/** A host over a stand-in server that records what the page made it do. */
function setup(options: { readonly declaredUrl?: string } = {}) {
  const opened: Array<string> = [];
  const closed: Array<string> = [];
  const acted: Array<[string, WorkspacePreviewAction]> = [];
  const followers = new Map<string, (event: WorkspacePreviewEvent) => void>();
  const changes: Array<WorkspacePreviewChange> = [];
  let next = 0;
  let result: WorkspacePreviewActResult = { _tag: "done" };
  const host = createWorkspacePreviewHost({
    declaredUrl: () => options.declaredUrl,
    open: async ({ url }) => {
      opened.push(url);
      next += 1;
      return { sessionId: `s${next}`, url, title: "App", viewport: { width: 1280, height: 800 } };
    },
    act: async (sessionId, action) => {
      acted.push([sessionId, action]);
      return result;
    },
    close: (sessionId) => closed.push(sessionId),
    follow: (sessionId, onEvent) => {
      followers.set(sessionId, onEvent);
      return () => followers.delete(sessionId);
    },
    notify: (change) => changes.push(change),
    toFile: (base64, mimeType) => ({ base64, mimeType }),
  });
  return {
    host,
    opened,
    closed,
    acted,
    followers,
    changes,
    answer: (next: WorkspacePreviewActResult) => {
      result = next;
    },
  };
}

describe("createWorkspacePreviewHost", () => {
  it("opens the declared preview by default and needs one to act", async () => {
    const { host, opened } = setup();
    await expect(host.open(undefined, undefined)).rejects.toThrow("no preview URL");
    await expect(host.act({ _tag: "reload" })).rejects.toThrow("No preview is open");

    const declared = setup({ declaredUrl: "http://localhost:5173/" });
    await declared.host.open(undefined, undefined);
    expect(declared.opened).toEqual(["http://localhost:5173/"]);
    expect(opened).toEqual([]);
  });

  it("keeps one session per page, closing the one it replaces", async () => {
    const { host, closed, acted, followers, changes } = setup();
    await host.open("http://localhost:5173/", undefined);
    await host.open("http://localhost:5173/settings", undefined);
    expect(closed).toEqual(["s1"]);
    expect([...followers.keys()]).toEqual(["s2"]);

    await host.act({ _tag: "reload" });
    expect(acted).toEqual([["s2", { _tag: "reload" }]]);

    // Changes reach the page; once the server closes the session, acting needs a new open.
    followers.get("s2")!({
      _tag: "changed",
      sessionId: "s2",
      reason: "mutated",
      url: "http://localhost:5173/settings",
      title: "Settings",
    });
    followers.get("s2")!({ _tag: "closed", sessionId: "s2", reason: "expired" });
    expect(changes.map((change) => change.reason)).toEqual(["mutated", "closed"]);
    expect(followers.size).toBe(0);
    await expect(host.act({ _tag: "reload" })).rejects.toThrow("No preview is open");
  });

  it("hands the page a screenshot as a file, and unwraps each result", async () => {
    const { host, answer } = setup();
    await host.open("http://localhost:5173/", undefined);
    answer({
      _tag: "screenshot",
      mimeType: "image/png",
      data: "iVBORw==",
      width: 1280,
      height: 800,
      scrollY: 320,
      fullPage: false,
    });
    expect(await host.act({ _tag: "screenshot" })).toEqual({
      file: { base64: "iVBORw==", mimeType: "image/png" },
      width: 1280,
      height: 800,
      scrollY: 320,
      fullPage: false,
    });
    answer({ _tag: "scrolled", scrollY: 0 });
    expect(await host.act({ _tag: "scroll", y: -5 })).toEqual({ scrollY: 0 });
  });

  it("closes its session when the page goes, and one that opens after", async () => {
    const { host, closed, followers } = setup();
    await host.open("http://localhost:5173/", undefined);
    const late = host.open("http://localhost:5173/late", undefined);
    host.dispose();
    await expect(late).rejects.toThrow("The workspace closed.");
    expect(closed).toEqual(["s1", "s2"]);
    expect(followers.size).toBe(0);
  });
});
