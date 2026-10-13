import { describe, expect, it } from "vite-plus/test";

import {
  injectWorkspaceBridge,
  readWorkspaceBridgeMessage,
  readWorkspaceReference,
  WORKSPACE_BRIDGE_METHODS,
  WORKSPACE_MAX_ASSETS,
} from "./mutationWorkspace.ts";
import { isWorkspaceRestoreToolItem, workspaceFromToolItem } from "./toolOutput.ts";

const reference = {
  attachmentId: "thread-abc-123-html",
  title: "Photo editor",
  assets: [{ path: "/Users/me/shots/raw.png", name: "raw.png" }],
};

describe("readWorkspaceReference", () => {
  it("reads a well-formed reference and trims its title", () => {
    expect(readWorkspaceReference({ ...reference, title: "  Photo editor  " })).toEqual(reference);
    expect(readWorkspaceReference({ ...reference, title: "   " })?.title).toBe("Workspace");
  });

  it("rejects a reference with any malformed part rather than dropping it", () => {
    expect(readWorkspaceReference(null)).toBeUndefined();
    expect(readWorkspaceReference({ ...reference, attachmentId: "" })).toBeUndefined();
    expect(readWorkspaceReference({ ...reference, assets: "raw.png" })).toBeUndefined();
    expect(
      readWorkspaceReference({
        ...reference,
        assets: [...reference.assets, { path: "", name: "x" }],
      }),
    ).toBeUndefined();
    const tooMany = Array.from({ length: WORKSPACE_MAX_ASSETS + 1 }, (_, index) => ({
      path: `/tmp/${index}.png`,
      name: `${index}.png`,
    }));
    expect(readWorkspaceReference({ ...reference, assets: tooMany })).toBeUndefined();
  });
});

describe("readWorkspaceBridgeMessage", () => {
  const rpc = (method: string, params?: unknown, id?: string | number) => ({
    jsonrpc: "2.0",
    method,
    ...(params === undefined ? {} : { params }),
    ...(id === undefined ? {} : { id }),
  });

  it("reads requests only when they carry an id and valid params", () => {
    expect(readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.initialize, {}, "w1"))).toEqual({
      id: "w1",
      method: WORKSPACE_BRIDGE_METHODS.initialize,
    });
    expect(readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.initialize))).toBeUndefined();
    expect(
      readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.send, { text: "Warmer" }, 2)),
    ).toEqual({ id: 2, method: WORKSPACE_BRIDGE_METHODS.send, text: "Warmer" });
    expect(
      readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.send, { text: "  " }, 2)),
    ).toBeUndefined();
  });

  it("accepts only real Files for attach and download", () => {
    const file = new File(["x"], "export.png", { type: "image/png" });
    expect(
      readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.attach, { files: [file] }, "a")),
    ).toEqual({ id: "a", method: WORKSPACE_BRIDGE_METHODS.attach, files: [file] });
    expect(
      readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.attach, { files: [] }, "a")),
    ).toBeUndefined();
    expect(
      readWorkspaceBridgeMessage(
        rpc(WORKSPACE_BRIDGE_METHODS.download, { file: { name: "fake.png" } }, "d"),
      ),
    ).toBeUndefined();
  });

  it("reads notifications and validates the composer slot rect", () => {
    expect(
      readWorkspaceBridgeMessage(
        rpc(WORKSPACE_BRIDGE_METHODS.setState, { state: { exposure: 1 } }),
      ),
    ).toEqual({ method: WORKSPACE_BRIDGE_METHODS.setState, state: { exposure: 1 } });
    expect(readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.restore))).toEqual({
      method: WORKSPACE_BRIDGE_METHODS.restore,
    });
    const rect = { x: 10, y: 20, width: 320, height: 96 };
    expect(
      readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.composerSlot, { rect })),
    ).toEqual({
      method: WORKSPACE_BRIDGE_METHODS.composerSlot,
      rect,
    });
    expect(
      readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.composerSlot, { rect: null })),
    ).toEqual({ method: WORKSPACE_BRIDGE_METHODS.composerSlot, rect: null });
    expect(
      readWorkspaceBridgeMessage(
        rpc(WORKSPACE_BRIDGE_METHODS.composerSlot, { rect: { ...rect, width: Number.NaN } }),
      ),
    ).toBeUndefined();
  });

  it("ignores host notifications, other protocols, and unknown methods", () => {
    expect(
      readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.composerSize, { height: 80 })),
    ).toBe(undefined);
    expect(readWorkspaceBridgeMessage(rpc("ui/notifications/size-changed", { height: 80 }))).toBe(
      undefined,
    );
    expect(
      readWorkspaceBridgeMessage({ method: WORKSPACE_BRIDGE_METHODS.restore }),
    ).toBeUndefined();
    expect(readWorkspaceBridgeMessage("t3/workspace/restore")).toBeUndefined();
  });
});

describe("injectWorkspaceBridge", () => {
  it("runs the bridge before the page's own head scripts", () => {
    const html =
      "<!doctype html><html><head><script>window.t3.workspace.ready()</script></head><body></body></html>";
    const injected = injectWorkspaceBridge(html);
    const bridgeAt = injected.indexOf("window.t3.workspace={");
    expect(bridgeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(bridgeAt).toBeLessThan(injected.indexOf("window.t3.workspace.ready()"));
  });

  it("gives a headless fragment a head to run in", () => {
    const injected = injectWorkspaceBridge("<main data-t3-composer></main>");
    expect(injected.startsWith("<!doctype html><head><script>")).toBe(true);
    expect(injected.endsWith("<main data-t3-composer></main>")).toBe(true);
  });
});

describe("workspaceFromToolItem", () => {
  const result = { mutationWorkspace: reference, message: "The thread now shows this workspace." };

  it("reads the reference from each provider's result envelope", () => {
    for (const [toolName, output] of [
      ["mcp__t3-code__workspace_mutate", [{ type: "text", text: JSON.stringify(result) }]],
      ["t3-code.workspace_mutate", { structuredContent: result, content: [] }],
      ["workspace_mutate", result],
    ] as const) {
      expect(workspaceFromToolItem({ toolName, output })).toEqual(reference);
    }
  });

  it("ignores other tools, other servers, and failed calls", () => {
    expect(workspaceFromToolItem({ toolName: "mcp__t3-code__html_render", output: result })).toBe(
      undefined,
    );
    expect(
      workspaceFromToolItem({ toolName: "mcp__other__workspace_mutate", output: result }),
    ).toBe(undefined);
    expect(
      workspaceFromToolItem({
        toolName: "mcp__t3-code__workspace_mutate",
        output: { ...result, isError: true },
      }),
    ).toBeUndefined();
  });
});

describe("isWorkspaceRestoreToolItem", () => {
  it("is true only for a completed workspace_restore call", () => {
    const output = { restored: true, message: "The thread is back in its chat interface." };
    expect(
      isWorkspaceRestoreToolItem({ toolName: "mcp__t3-code__workspace_restore", output }),
    ).toBe(true);
    expect(
      isWorkspaceRestoreToolItem({
        toolName: "mcp__t3-code__workspace_restore",
        output: { isError: true, content: "No thread scope." },
      }),
    ).toBe(false);
    expect(isWorkspaceRestoreToolItem({ toolName: "mcp__t3-code__workspace_mutate", output })).toBe(
      false,
    );
  });
});
