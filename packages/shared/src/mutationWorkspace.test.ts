// @effect-diagnostics globalTimers:off - Drives the page-side bridge, which runs on browser timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { HOST_CONTEXT_CHANGED_METHOD } from "./htmlRender.ts";
import {
  injectWorkspaceBridge,
  readWorkspaceBridgeMessage,
  readWorkspaceReference,
  WORKSPACE_BRIDGE_METHODS,
  WORKSPACE_MAX_ASSETS,
  workspacePreviewOrigin,
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

describe("workspace previews", () => {
  it("grants an http(s) URL's origin and nothing else", () => {
    expect(workspacePreviewOrigin("http://localhost:5173/settings?tab=2")).toBe(
      "http://localhost:5173",
    );
    expect(workspacePreviewOrigin("https://staging.example.com")).toBe(
      "https://staging.example.com",
    );
    for (const url of ["localhost:5173", "file:///etc/hosts", "javascript:alert(1)", ""]) {
      expect(workspacePreviewOrigin(url)).toBeUndefined();
    }
  });

  it("keeps a declared preview on the reference and refuses a malformed one", () => {
    const preview = { url: "http://localhost:5173/" };
    expect(readWorkspaceReference({ ...reference, preview })).toEqual({ ...reference, preview });
    expect(readWorkspaceReference({ ...reference, preview: { url: "ftp://x" } })).toBeUndefined();
    expect(readWorkspaceReference({ ...reference, preview: "http://x" })).toBeUndefined();
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
    ).toEqual({ id: 2, method: WORKSPACE_BRIDGE_METHODS.send, text: "Warmer", files: [] });
    expect(
      readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.send, { text: "  " }, 2)),
    ).toBeUndefined();
  });

  it("reads files sent with a message, and refuses a send whose files are not Files", () => {
    const file = new File(["{}"], "edl.json", { type: "application/json" });
    expect(
      readWorkspaceBridgeMessage(
        rpc(WORKSPACE_BRIDGE_METHODS.send, { text: "Render this", files: [file] }, 3),
      ),
    ).toEqual({ id: 3, method: WORKSPACE_BRIDGE_METHODS.send, text: "Render this", files: [file] });
    expect(
      readWorkspaceBridgeMessage(
        rpc(WORKSPACE_BRIDGE_METHODS.send, { text: "Render this", files: [{ name: "x" }] }, 3),
      ),
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

  it("reads preview requests only with a valid action", () => {
    expect(readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.previewOpen, {}, "p1"))).toEqual(
      {
        id: "p1",
        method: WORKSPACE_BRIDGE_METHODS.previewOpen,
        url: undefined,
        viewport: undefined,
      },
    );
    expect(
      readWorkspaceBridgeMessage(
        rpc(
          WORKSPACE_BRIDGE_METHODS.previewOpen,
          { url: "http://localhost:5173/", viewport: { width: 390, height: 844 } },
          "p2",
        ),
      ),
    ).toMatchObject({ url: "http://localhost:5173/", viewport: { width: 390, height: 844 } });
    // A viewport out of range, or a URL that is not a string.
    expect(
      readWorkspaceBridgeMessage(
        rpc(WORKSPACE_BRIDGE_METHODS.previewOpen, { viewport: { width: 10, height: 844 } }, "p3"),
      ),
    ).toBeUndefined();
    expect(
      readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.previewOpen, { url: 5 }, "p4")),
    ).toBeUndefined();

    const action = { _tag: "elementsAt", x: 120, y: 640 };
    expect(
      readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.preview, { action }, 3)),
    ).toEqual({ id: 3, method: WORKSPACE_BRIDGE_METHODS.preview, action });
    for (const bad of [
      { _tag: "evaluate", script: "fetch('/admin')" },
      { _tag: "elementsAt", x: "120", y: 640 },
      { _tag: "highlight" },
      { _tag: "inspect", selector: "" },
    ]) {
      expect(
        readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.preview, { action: bad }, 4)),
      ).toBeUndefined();
    }
    expect(readWorkspaceBridgeMessage(rpc(WORKSPACE_BRIDGE_METHODS.preview, { action }))).toBe(
      undefined,
    );
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

/**
 * Runs the injected bridge against a stand-in window whose parent records what
 * the page posts, so its behavior can be driven the way the host drives it.
 */
function loadBridge(
  fetch: (url: string) => Promise<Response> = () => Promise.reject(new Error("offline")),
) {
  const script = /<script>([\s\S]*)<\/script>/.exec(injectWorkspaceBridge(""))![1]!;
  const posted: Array<{ id?: string; method: string; params: Record<string, unknown> }> = [];
  const windowListeners = new Map<string, Array<(event: unknown) => void>>();
  const listen =
    (listeners: Map<string, Array<(event: unknown) => void>>) =>
    (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    };
  const parent = { postMessage: (message: (typeof posted)[number]) => posted.push(message) };
  const page: { parent: typeof parent; addEventListener: unknown; t3?: { workspace?: unknown } } = {
    parent,
    addEventListener: listen(windowListeners),
  };
  const document = { addEventListener: listen(new Map()), querySelector: () => null };
  // Runs the bridge source as the page would, with stand-ins for the page's globals.
  new Function("window", "document", "URL", "requestAnimationFrame", "fetch", script)(
    page,
    document,
    { createObjectURL: (file: File) => `blob:${file.name}` },
    (callback: () => void) => setTimeout(callback, 16),
    fetch,
  );
  const workspace = page.t3!.workspace as {
    ready: () => Promise<{ state: unknown; assets: ReadonlyArray<Record<string, unknown>> }>;
    setState: (state: unknown) => void;
    assetFile: (name: string) => Promise<File>;
    send: (text: string, options?: { files: unknown }) => Promise<unknown>;
    restore: () => void;
    preview: {
      open: (url?: string, options?: { viewport: unknown }) => Promise<unknown>;
      elementsAt: (x: number, y: number) => Promise<unknown>;
      highlight: (selector: string | null) => Promise<unknown>;
    };
    on: (event: string, callback: (value: unknown) => void) => () => void;
  };
  const fromHost = (data: unknown) => {
    for (const listener of windowListeners.get("message") ?? []) listener({ source: parent, data });
  };
  const leavePage = () => {
    for (const listener of windowListeners.get("pagehide") ?? []) listener({});
  };
  return { workspace, posted, fromHost, leavePage };
}

describe("workspace bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores the last state before handing the thread back or leaving the page", () => {
    const { workspace, posted, leavePage } = loadBridge();
    workspace.setState({ v: 1, exposure: 0.4 });
    workspace.setState({ v: 1, exposure: 0.6 });
    workspace.restore();
    expect(posted.map((message) => message.method)).toEqual([
      WORKSPACE_BRIDGE_METHODS.setState,
      WORKSPACE_BRIDGE_METHODS.restore,
    ]);
    expect(posted[0]!.params).toEqual({ state: { v: 1, exposure: 0.6 } });

    workspace.setState({ v: 1, exposure: 0.8 });
    leavePage();
    expect(posted.at(-1)).toMatchObject({
      method: WORKSPACE_BRIDGE_METHODS.setState,
      params: { state: { v: 1, exposure: 0.8 } },
    });
    // Flushed once: the debounce no longer fires a second copy.
    vi.runAllTimers();
    expect(posted).toHaveLength(3);
  });

  it("retries initialize after a failed load and names each asset's origin", async () => {
    const { workspace, posted, fromHost } = loadBridge();
    const failed = workspace.ready();
    fromHost({ jsonrpc: "2.0", id: posted[0]!.id, error: { message: "Reconnect first." } });
    await expect(failed).rejects.toThrow("Reconnect first.");

    const retried = workspace.ready();
    expect(posted).toHaveLength(2);
    const clip = new File(["x"], "clip.mp4", { type: "video/mp4" });
    const photo = new File(["x"], "photo.png", { type: "image/png" });
    fromHost({
      jsonrpc: "2.0",
      id: posted[1]!.id,
      result: {
        state: { v: 2 },
        assets: [
          {
            name: "photo.png",
            mimeType: "image/png",
            source: "attachment",
            attachmentId: "a-1",
            file: photo,
          },
          {
            name: "clip.mp4",
            mimeType: "video/mp4",
            source: "file",
            path: "/media/clip.mp4",
            file: clip,
          },
        ],
      },
    });
    const { state, assets } = await retried;
    expect(state).toEqual({ v: 2 });
    expect(assets).toMatchObject([
      { source: "attachment", attachmentId: "a-1", url: "blob:photo.png", size: 1 },
      { source: "file", path: "/media/clip.mp4", url: "blob:clip.mp4", size: 1 },
    ]);
  });

  /** Answers the page's initialize with a photo's bytes and a clip streamed from `url`. */
  const initializeWithClip = async (bridge: ReturnType<typeof loadBridge>) => {
    const ready = bridge.workspace.ready();
    bridge.fromHost({
      jsonrpc: "2.0",
      id: bridge.posted[0]!.id,
      result: {
        state: undefined,
        assets: [
          {
            name: "photo.png",
            mimeType: "image/png",
            source: "file",
            path: "/media/photo.png",
            file: new File(["png"], "photo.png", { type: "image/png" }),
          },
          {
            name: "clip.mov",
            mimeType: "video/quicktime",
            source: "file",
            path: "/Volumes/X10/clip.mov",
            url: "https://host.example/api/assets/t1/clip.mov",
            size: 3_300_000_000,
          },
        ],
      },
    });
    return (await ready).assets;
  };

  it("hands a streamed asset its URL and size with no bytes, and other assets their File", async () => {
    const assets = await initializeWithClip(loadBridge());
    expect(assets[0]).toMatchObject({ url: "blob:photo.png", size: 3 });
    expect(assets[0]!.file).toBeInstanceOf(File);
    expect(assets[1]).toEqual({
      name: "clip.mov",
      mimeType: "video/quicktime",
      source: "file",
      path: "/Volumes/X10/clip.mov",
      attachmentId: undefined,
      url: "https://host.example/api/assets/t1/clip.mov",
      size: 3_300_000_000,
    });
  });

  it("swaps in a renewed URL and tells the page, for the streamed asset it names only", async () => {
    const bridge = loadBridge();
    const assets = await initializeWithClip(bridge);
    const renewed: Array<unknown> = [];
    bridge.workspace.on("asset-url", (change) => renewed.push(change));
    const url = "https://host.example/api/assets/t2/clip.mov";
    // A stale index, or one naming the photo (whose blob: URL never expires), changes nothing.
    bridge.fromHost({
      jsonrpc: "2.0",
      method: WORKSPACE_BRIDGE_METHODS.assetUrl,
      params: { index: 0, name: "photo.png", url },
    });
    bridge.fromHost({
      jsonrpc: "2.0",
      method: WORKSPACE_BRIDGE_METHODS.assetUrl,
      params: { index: 1, name: "other.mov", url },
    });
    expect(renewed).toEqual([]);
    bridge.fromHost({
      jsonrpc: "2.0",
      method: WORKSPACE_BRIDGE_METHODS.assetUrl,
      params: { index: 1, name: "clip.mov", url },
    });
    expect(renewed).toEqual([{ name: "clip.mov", url }]);
    expect(assets[1]!.url).toBe(url);
    expect(assets[0]!.url).toBe("blob:photo.png");
  });

  it("loads an asset's bytes on demand: a File as it is, a streamed one from its current URL", async () => {
    const fetched: Array<string> = [];
    const bridge = loadBridge(async (url) => {
      fetched.push(url);
      return url.includes("/t9/")
        ? new Response("nope", { status: 404 })
        : new Response(new Blob(["frames"], { type: "video/quicktime" }));
    });
    const assets = await initializeWithClip(bridge);
    expect(await bridge.workspace.assetFile("photo.png")).toBe(assets[0]!.file);
    const clip = await bridge.workspace.assetFile("clip.mov");
    expect([clip.name, clip.type, await clip.text()]).toEqual([
      "clip.mov",
      "video/quicktime",
      "frames",
    ]);
    expect(fetched).toEqual(["https://host.example/api/assets/t1/clip.mov"]);

    bridge.fromHost({
      jsonrpc: "2.0",
      method: WORKSPACE_BRIDGE_METHODS.assetUrl,
      params: { index: 1, name: "clip.mov", url: "https://host.example/api/assets/t9/clip.mov" },
    });
    await expect(bridge.workspace.assetFile("clip.mov")).rejects.toThrow(
      "clip.mov could not be loaded (HTTP 404).",
    );
    await expect(bridge.workspace.assetFile("missing.wav")).rejects.toThrow(
      'No workspace asset is named "missing.wav".',
    );
  });

  it("sends files in the same message the host reads", () => {
    const { workspace, posted } = loadBridge();
    void workspace.send("Render the cut", {
      files: new Blob(['{"clips":[]}'], { type: "application/json" }),
    });
    const message = readWorkspaceBridgeMessage({ jsonrpc: "2.0", ...posted[0] });
    expect(message).toMatchObject({
      method: WORKSPACE_BRIDGE_METHODS.send,
      text: "Render the cut",
    });
    const files = message !== undefined && "files" in message ? message.files : [];
    expect(files.map((file) => [file.name, file.type])).toEqual([["export", "application/json"]]);
  });

  it("tells the page about theme changes after the variables apply, and about failed saves", () => {
    const { workspace, fromHost } = loadBridge();
    const themes: unknown[] = [];
    const errors: unknown[] = [];
    workspace.on("theme", (theme) => themes.push(theme));
    workspace.on("state-error", (error) => errors.push(error));

    fromHost({
      jsonrpc: "2.0",
      method: HOST_CONTEXT_CHANGED_METHOD,
      params: { theme: "light", styles: { variables: { "--background": "#fff" } } },
    });
    // The theme bootstrap handles the same message after the bridge does.
    expect(themes).toEqual([]);
    vi.runAllTimers();
    expect(themes).toEqual([{ appearance: "light" }]);

    fromHost({
      jsonrpc: "2.0",
      method: WORKSPACE_BRIDGE_METHODS.stateError,
      params: { message: "Workspace state is over 64KB." },
    });
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("Workspace state is over 64KB.");
  });

  it("drives the live preview through requests the host reads, and hears its changes", async () => {
    const { workspace, posted, fromHost } = loadBridge();
    const changes: unknown[] = [];
    workspace.on("preview-changed", (change) => changes.push(change));

    const opened = workspace.preview.open(undefined, { viewport: { width: 390, height: 844 } });
    expect(readWorkspaceBridgeMessage({ jsonrpc: "2.0", ...posted[0] })).toMatchObject({
      method: WORKSPACE_BRIDGE_METHODS.previewOpen,
      url: undefined,
      viewport: { width: 390, height: 844 },
    });
    const session = { sessionId: "s1", url: "http://localhost:5173/", title: "App" };
    fromHost({ jsonrpc: "2.0", id: posted[0]!.id, result: session });
    await expect(opened).resolves.toEqual(session);

    // Results arrive wrapped, and the page gets the part it asked for.
    const under = workspace.preview.elementsAt(120, 640);
    expect(readWorkspaceBridgeMessage({ jsonrpc: "2.0", ...posted[1] })).toMatchObject({
      action: { _tag: "elementsAt", x: 120, y: 640 },
    });
    fromHost({ jsonrpc: "2.0", id: posted[1]!.id, result: { elements: [{ selector: "#hero" }] } });
    await expect(under).resolves.toEqual([{ selector: "#hero" }]);

    void workspace.preview.highlight(null);
    expect(readWorkspaceBridgeMessage({ jsonrpc: "2.0", ...posted[2] })).toMatchObject({
      action: { _tag: "highlight", selector: null },
    });

    const change = { sessionId: "s1", reason: "mutated", url: session.url, title: "App" };
    fromHost({ jsonrpc: "2.0", method: WORKSPACE_BRIDGE_METHODS.previewChanged, params: change });
    expect(changes).toEqual([change]);
  });
});
