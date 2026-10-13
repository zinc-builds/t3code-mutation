import { describe, expect, it } from "vite-plus/test";

import {
  latestWorkspaceEvent,
  resolveActiveWorkspace,
  resumableWorkspace,
  runningWorkspaceMutations,
  threadImagesFromTurnItems,
  type WorkspaceTurnItem,
} from "./activeWorkspace";

const workspace = (attachmentId: string, title = "Photo editor") => ({
  attachmentId,
  title,
  assets: [],
});

const mutate = (id: string, attachmentId: string, status = "completed") => ({
  item: {
    id,
    type: "dynamic_tool",
    status,
    toolName: "t3-code.workspace_mutate",
    output: { structuredContent: { mutationWorkspace: workspace(attachmentId) } },
  } satisfies WorkspaceTurnItem,
});

const restore = (id: string, output: unknown = { structuredContent: { restored: true } }) => ({
  item: {
    id,
    type: "dynamic_tool",
    status: "completed",
    toolName: "t3-code.workspace_restore",
    output,
  } satisfies WorkspaceTurnItem,
});

const message = (id: string) => ({
  item: { id, type: "assistant_message", status: "completed" } satisfies WorkspaceTurnItem,
});

describe("latestWorkspaceEvent", () => {
  it("reads the newest completed workspace call", () => {
    expect(latestWorkspaceEvent([mutate("a", "doc-1"), message("m")])).toEqual({
      kind: "mutate",
      itemId: "a",
      workspace: workspace("doc-1"),
    });
    expect(latestWorkspaceEvent([mutate("a", "doc-1"), restore("r")])).toEqual({
      kind: "restore",
      itemId: "r",
    });
    expect(latestWorkspaceEvent([restore("r"), mutate("b", "doc-2")])?.itemId).toBe("b");
  });

  it("ignores calls that are still running or failed", () => {
    expect(latestWorkspaceEvent([mutate("a", "doc-1"), mutate("b", "doc-2", "running")])).toEqual(
      expect.objectContaining({ itemId: "a" }),
    );
    expect(
      latestWorkspaceEvent([mutate("a", "doc-1"), restore("r", { isError: true, content: [] })]),
    ).toEqual(expect.objectContaining({ itemId: "a" }));
    expect(latestWorkspaceEvent([message("m")])).toBeNull();
  });
});

describe("resolveActiveWorkspace", () => {
  const mutated = latestWorkspaceEvent([mutate("a", "doc-1")]);
  const restored = latestWorkspaceEvent([mutate("a", "doc-1"), restore("r")]);
  const opened = { itemId: "a", workspace: workspace("doc-1") };

  it("follows the agent without a local choice", () => {
    expect(resolveActiveWorkspace(mutated, undefined)).toEqual(opened);
    expect(resolveActiveWorkspace(restored, undefined)).toBeNull();
    expect(resolveActiveWorkspace(null, undefined)).toBeNull();
  });

  it("lets the user leave and reopen until the agent acts again", () => {
    // Way out: back to chat while the agent's workspace is active.
    expect(resolveActiveWorkspace(mutated, { eventId: "a", open: null })).toBeNull();
    // Way back in: reopened from history after the agent restored.
    expect(resolveActiveWorkspace(restored, { eventId: "r", open: opened })).toEqual(opened);
  });

  it("drops the local choice once the agent mutates or restores again", () => {
    const remutated = latestWorkspaceEvent([
      mutate("a", "doc-1"),
      restore("r"),
      mutate("b", "doc-2"),
    ]);
    expect(resolveActiveWorkspace(remutated, { eventId: "r", open: null })).toEqual({
      itemId: "b",
      workspace: workspace("doc-2"),
    });
    const restoredAgain = latestWorkspaceEvent([mutate("a", "doc-1"), restore("r2")]);
    expect(resolveActiveWorkspace(restoredAgain, { eventId: "r", open: opened })).toBeNull();
  });
});

describe("resumableWorkspace", () => {
  it("offers the agent's workspace back only after the user left it", () => {
    const mutated = latestWorkspaceEvent([mutate("a", "doc-1")]);
    const opened = { itemId: "a", workspace: workspace("doc-1") };
    expect(resumableWorkspace(mutated, null)).toEqual(opened);
    expect(resumableWorkspace(mutated, opened)).toBeNull();
    expect(resumableWorkspace(latestWorkspaceEvent([restore("r")]), null)).toBeNull();
  });
});

describe("threadImagesFromTurnItems", () => {
  it("lists the user's image attachments oldest first, once each", () => {
    const image = (id: string) => ({
      type: "image",
      id,
      name: `${id}.png`,
      mimeType: "image/png",
      sizeBytes: 10,
    });
    const userMessage = (id: string, attachments: ReadonlyArray<ReturnType<typeof image>>) => ({
      item: {
        id,
        type: "user_message",
        status: "completed",
        attachments,
      } as WorkspaceTurnItem,
    });
    expect(
      threadImagesFromTurnItems([
        userMessage("u1", [image("one")]),
        message("m"),
        userMessage("u2", [image("two"), image("one")]),
      ]),
    ).toEqual([
      { attachmentId: "one", name: "one.png", mimeType: "image/png" },
      { attachmentId: "two", name: "two.png", mimeType: "image/png" },
    ]);
  });
});

describe("runningWorkspaceMutations", () => {
  const call = (
    id: string,
    status: string,
    input: unknown,
    toolName = "t3-code.workspace_mutate",
  ) => ({
    item: { id, type: "dynamic_tool", status, toolName, input } satisfies WorkspaceTurnItem,
  });
  const userMessage = (id: string) => ({
    item: { id, type: "user_message", status: "completed" } satisfies WorkspaceTurnItem,
  });

  it("lists the current turn's running calls with the asset paths their input names", () => {
    expect(
      runningWorkspaceMutations([
        call("old", "running", { assets: ["/m/old.mp4"] }),
        userMessage("ask"),
        call("done", "completed", { assets: ["/m/done.mp4"] }),
        call("other", "running", { assets: ["/m/x.mp4"] }, "t3-code.html_render"),
        call("first", "pending", { title: "Grade" }),
        call("second", "running", { assets: ["/m/clip.mp4", 3, ""] }),
        message("reply"),
      ]),
    ).toEqual([
      { itemId: "second", assetPaths: ["/m/clip.mp4"] },
      { itemId: "first", assetPaths: [] },
    ]);
  });
});
