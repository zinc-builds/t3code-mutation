import { describe, expect, it } from "vite-plus/test";

import { injectWorkspaceBridge, readWorkspaceReference } from "./mutationWorkspace.ts";
import {
  applyWorkspaceChromePatch,
  matchWorkspaceShortcut,
  readWorkspaceChrome,
  readWorkspaceChromeBridgeMessage,
  readWorkspaceStateEnvelope,
  resolveWorkspaceChromeValues,
  WORKSPACE_CHROME_BRIDGE_METHODS,
  WORKSPACE_CHROME_MAX_BYTES,
  workspaceChromeShortcutCommand,
  workspacePageState,
  workspaceShortcutLabel,
  type WorkspaceChrome,
} from "./mutationWorkspaceChrome.ts";
import { workspaceFromToolItem } from "./toolOutput.ts";

const manifest = {
  toolbar: [
    {
      type: "segmented",
      id: "tool",
      label: "Tool",
      options: [
        { value: "move", label: "Move", icon: "move", shortcut: "v" },
        { value: "crop", label: "Crop", icon: "crop", shortcut: "c" },
      ],
    },
    { type: "toggle", id: "before", label: "Before/after", icon: "split", shortcut: "\\" },
    { type: "separator" },
    { type: "button", id: "export", label: "Export", icon: "download", shortcut: "mod+e" },
    { type: "menu", id: "more", label: "More", items: [{ id: "reset", label: "Reset all" }] },
  ],
  sidebar: [
    {
      id: "history",
      title: "History",
      items: [
        { id: "open", label: "Opened" },
        { id: "exp", label: "Exposure", detail: "+0.4" },
      ],
    },
  ],
  inspector: [
    {
      title: "Light",
      controls: [
        { type: "slider", id: "exposure", label: "Exposure", min: -5, max: 5, step: 0.05 },
        { type: "select", id: "look", label: "Look", options: ["natural", "film"], value: "film" },
        { type: "toggle", id: "auto", label: "Auto tone" },
        { type: "color", id: "tint", label: "Tint", value: "#F80" },
        { type: "button", id: "apply", label: "Apply to original" },
      ],
    },
  ],
};

function chromeOf(value: unknown): WorkspaceChrome {
  const result = readWorkspaceChrome(value);
  if (!result.ok) throw new Error(result.error);
  return result.chrome;
}

const errorOf = (value: unknown) => {
  const result = readWorkspaceChrome(value);
  return result.ok ? undefined : result.error;
};

describe("readWorkspaceChrome", () => {
  it("normalizes defaults: first option, slider min, false toggles, first sidebar item, full hex", () => {
    const chrome = chromeOf(manifest);
    expect(chrome.toolbar?.[0]).toMatchObject({ type: "segmented", value: "move" });
    expect(chrome.toolbar?.[1]).toMatchObject({ type: "toggle", value: false });
    expect(chrome.sidebar?.[0]?.value).toBe("open");
    const [exposure, look, auto, tint] = chrome.inspector?.[0]?.controls ?? [];
    expect(exposure).toMatchObject({ value: -5, step: 0.05 });
    expect(look).toMatchObject({
      value: "film",
      options: [
        { value: "natural", label: "natural" },
        { value: "film", label: "film" },
      ],
    });
    expect(auto).toMatchObject({ value: false });
    expect(tint).toMatchObject({ value: "#ff8800" });
  });

  it("reads its own output back unchanged", () => {
    const chrome = chromeOf(manifest);
    expect(chromeOf(chrome)).toEqual(chrome);
  });

  it("names the path of what is wrong", () => {
    expect(errorOf({ toolbar: [{ type: "knob", id: "a", label: "A" }] })).toMatch(
      /^chrome\.toolbar\[0\]\.type:/,
    );
    expect(
      errorOf({
        inspector: [
          { title: "A", controls: [{ type: "slider", id: "s", label: "S", min: 1, max: 1 }] },
        ],
      }),
    ).toBe("chrome.inspector[0].controls[0]: min must be less than max");
    expect(errorOf({ toolbar: [{ type: "button", id: "has space", label: "A" }] })).toMatch(
      /toolbar\[0\]\.id/,
    );
    expect(errorOf({ toolbar: [{ type: "button", id: "a", label: "A", icon: "Crop" }] })).toMatch(
      /lucide icon name/,
    );
    expect(
      errorOf({ toolbar: [{ type: "button", id: "a", label: "A", shortcut: "hyper+x" }] }),
    ).toMatch(/shortcut/);
  });

  it("rejects ids reused across regions, since values and commands share them", () => {
    expect(
      errorOf({
        toolbar: [{ type: "toggle", id: "grid", label: "Grid" }],
        inspector: [{ title: "View", controls: [{ type: "toggle", id: "grid", label: "Grid" }] }],
      }),
    ).toMatch(/"grid" is used twice/);
  });

  it("bounds the manifest size", () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      id: `item-${index}`,
      label: `${"Layer ".repeat(7)}${index}`,
    }));
    expect(errorOf({ sidebar: [{ id: "bin", title: "Bin", items }] })).toMatch(
      new RegExp(`at most ${WORKSPACE_CHROME_MAX_BYTES} bytes`),
    );
  });

  it("accepts thumbnails only as small data:image URLs", () => {
    const section = (thumbnail: string) => ({
      sidebar: [{ id: "layers", title: "Layers", items: [{ id: "a", label: "A", thumbnail }] }],
    });
    expect(errorOf(section("data:image/png;base64,iVBORw0KGgo="))).toBeUndefined();
    expect(errorOf(section("https://example.com/a.png"))).toMatch(/thumbnail/);
  });
});

describe("workspace references with chrome", () => {
  const reference = { attachmentId: "thread-abc-123-html", title: "Photo editor", assets: [] };

  it("carries a valid manifest and drops an invalid one without losing the page", () => {
    const chrome = chromeOf(manifest);
    expect(readWorkspaceReference({ ...reference, chrome })?.chrome).toEqual(chrome);
    const broken = readWorkspaceReference({ ...reference, chrome: { toolbar: "nope" } });
    expect(broken).toEqual(reference);
  });

  it("survives the compact tool output clients read", () => {
    const chrome = chromeOf(manifest);
    const output = {
      content: [
        { type: "text", text: JSON.stringify({ mutationWorkspace: { ...reference, chrome } }) },
      ],
    };
    expect(
      workspaceFromToolItem({ toolName: "mcp__t3-code__workspace_mutate", output })?.chrome,
    ).toEqual(chrome);
  });
});

describe("resolveWorkspaceChromeValues", () => {
  const chrome = chromeOf(manifest);

  it("starts from the manifest's defaults", () => {
    expect(resolveWorkspaceChromeValues(chrome)).toEqual({
      tool: "move",
      before: false,
      history: "open",
      exposure: -5,
      look: "film",
      auto: false,
      tint: "#ff8800",
    });
  });

  it("keeps stored values that still fit and drops the rest", () => {
    const values = resolveWorkspaceChromeValues(chrome, {
      tool: "crop",
      exposure: 12,
      look: "vhs",
      auto: "yes",
      history: "exp",
      gone: 3,
    });
    expect(values).toMatchObject({
      tool: "crop",
      exposure: 5,
      look: "film",
      auto: false,
      history: "exp",
    });
    expect(values).not.toHaveProperty("gone");
  });
});

describe("applyWorkspaceChromePatch", () => {
  const chrome = chromeOf(manifest);
  const values = { ...resolveWorkspaceChromeValues(chrome), exposure: 1.5 };

  it("replaces a region, keeps surviving values, and merges explicit ones", () => {
    const result = applyWorkspaceChromePatch(chrome, values, {
      sidebar: [
        {
          id: "history",
          title: "History",
          items: [
            { id: "open", label: "Opened" },
            { id: "crop1", label: "Crop" },
          ],
          value: "crop1",
        },
      ],
      values: { tool: "crop" },
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.chrome.sidebar?.[0]?.items).toHaveLength(2);
    expect(result.chrome.toolbar).toEqual(chrome.toolbar);
    expect(result.values).toMatchObject({ exposure: 1.5, tool: "crop", history: "open" });
  });

  it("removes a region given as an empty array", () => {
    const result = applyWorkspaceChromePatch(chrome, values, { inspector: [] });
    if ("error" in result) throw new Error(result.error);
    expect(result.chrome.inspector).toBeUndefined();
    expect(result.values).not.toHaveProperty("exposure");
  });

  it("explains a bad patch", () => {
    expect(applyWorkspaceChromePatch(chrome, values, { panels: [] })).toEqual({
      error: expect.stringContaining('unknown key "panels"'),
    });
    expect(
      applyWorkspaceChromePatch(chrome, values, { toolbar: [{ type: "button", id: "x" }] }),
    ).toEqual({ error: expect.stringContaining("chrome.toolbar[0].label") });
  });
});

describe("workspace state envelope", () => {
  it("splits controls from the page's own state", () => {
    const stored = { controls: { exposure: 1 }, page: { zoom: 2 } };
    expect(readWorkspaceStateEnvelope(stored)).toEqual({
      controls: { exposure: 1 },
      page: { zoom: 2 },
    });
    expect(workspacePageState(stored)).toEqual({ zoom: 2 });
  });

  it("treats anything else as page state, so bare workspaces read theirs unchanged", () => {
    for (const stored of [
      { zoom: 2 },
      { controls: { a: 1 }, other: true },
      { controls: 3 },
      [1, 2],
      null,
      undefined,
    ]) {
      expect(readWorkspaceStateEnvelope(stored)).toEqual({ controls: undefined, page: stored });
    }
  });
});

describe("shortcuts", () => {
  const key = (input: Partial<Parameters<typeof matchWorkspaceShortcut>[1]>) => ({
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...input,
  });

  it("maps mod to Cmd on macOS and Ctrl elsewhere", () => {
    expect(matchWorkspaceShortcut("mod+e", key({ key: "e", metaKey: true }), true)).toBe(true);
    expect(matchWorkspaceShortcut("mod+e", key({ key: "e", ctrlKey: true }), true)).toBe(false);
    expect(matchWorkspaceShortcut("mod+e", key({ key: "e", ctrlKey: true }), false)).toBe(true);
  });

  it("requires exact modifiers for letters, and reads the physical key under Alt", () => {
    expect(matchWorkspaceShortcut("v", key({ key: "v" }), true)).toBe(true);
    expect(matchWorkspaceShortcut("v", key({ key: "V", shiftKey: true }), true)).toBe(false);
    expect(matchWorkspaceShortcut("shift+r", key({ key: "R", shiftKey: true }), true)).toBe(true);
    expect(
      matchWorkspaceShortcut("alt+e", key({ key: "´", code: "KeyE", altKey: true }), true),
    ).toBe(true);
    expect(matchWorkspaceShortcut("?", key({ key: "?", shiftKey: true }), true)).toBe(true);
  });

  it("labels shortcuts per platform", () => {
    expect(workspaceShortcutLabel("mod+shift+e", true)).toBe("⇧⌘E");
    expect(workspaceShortcutLabel("mod+shift+e", false)).toBe("Ctrl+Shift+E");
    expect(workspaceShortcutLabel("space", false)).toBe("Space");
  });

  it("turns a key press into the toolbar command it triggers", () => {
    const chrome = chromeOf(manifest);
    const values = resolveWorkspaceChromeValues(chrome);
    expect(workspaceChromeShortcutCommand(chrome, values, key({ key: "c" }), true)).toEqual({
      id: "tool",
      value: "crop",
    });
    expect(workspaceChromeShortcutCommand(chrome, values, key({ key: "\\" }), true)).toEqual({
      id: "before",
      value: true,
    });
    expect(
      workspaceChromeShortcutCommand(chrome, values, key({ key: "e", metaKey: true }), true),
    ).toEqual({ id: "export" });
    expect(workspaceChromeShortcutCommand(chrome, values, key({ key: "x" }), true)).toBeUndefined();
  });
});

describe("chrome bridge", () => {
  it("reads setChrome requests and forwarded keys", () => {
    expect(
      readWorkspaceChromeBridgeMessage({
        jsonrpc: "2.0",
        id: "c1",
        method: WORKSPACE_CHROME_BRIDGE_METHODS.setChrome,
        params: { patch: { values: { a: 1 } } },
      }),
    ).toEqual({
      id: "c1",
      method: WORKSPACE_CHROME_BRIDGE_METHODS.setChrome,
      patch: { values: { a: 1 } },
    });
    expect(
      readWorkspaceChromeBridgeMessage({
        jsonrpc: "2.0",
        method: WORKSPACE_CHROME_BRIDGE_METHODS.key,
        params: { key: "e", code: "KeyE", meta: true },
      }),
    ).toEqual({
      method: WORKSPACE_CHROME_BRIDGE_METHODS.key,
      event: {
        key: "e",
        code: "KeyE",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      },
    });
    // setChrome needs an id to answer.
    expect(
      readWorkspaceChromeBridgeMessage({
        jsonrpc: "2.0",
        method: WORKSPACE_CHROME_BRIDGE_METHODS.setChrome,
        params: {},
      }),
    ).toBeUndefined();
  });

  it("ships the chrome API in the injected bridge script", () => {
    const html = injectWorkspaceBridge("<html><head></head><body></body></html>");
    expect(html).toContain(WORKSPACE_CHROME_BRIDGE_METHODS.setChrome);
    expect(html).toContain("w.setChrome=");
  });
});
