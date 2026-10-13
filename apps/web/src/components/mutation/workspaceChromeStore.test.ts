import { readWorkspaceChrome } from "@t3tools/shared/mutationWorkspaceChrome";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  closeWorkspaceChromeSession,
  loadWorkspaceChromeState,
  openWorkspaceChromeSession,
  patchWorkspaceChrome,
  performWorkspaceChromeCommand,
  setWorkspaceChromePageState,
  setWorkspaceChromeValue,
  subscribeWorkspaceChromeEvents,
  useWorkspaceChromeStore,
  type WorkspaceChromeEvent,
} from "./workspaceChromeStore";

const read = readWorkspaceChrome({
  toolbar: [{ type: "toggle", id: "grid", label: "Grid", shortcut: "g" }],
  inspector: [
    {
      title: "Light",
      controls: [{ type: "slider", id: "exposure", label: "Exposure", min: -5, max: 5, value: 0 }],
    },
  ],
});
if (!read.ok) throw new Error(read.error);
const chrome = read.chrome;

function session() {
  const current = useWorkspaceChromeStore.getState().session;
  if (current === null) throw new Error("No session");
  return current;
}

function recordEvents() {
  const events: WorkspaceChromeEvent[] = [];
  const stop = subscribeWorkspaceChromeEvents((event) => events.push(event));
  return { events, stop };
}

afterEach(() => closeWorkspaceChromeSession("ws-1"));

describe("workspace chrome sessions", () => {
  it("starts from the manifest and adopts stored controls and page state", () => {
    openWorkspaceChromeSession("ws-1", chrome);
    expect(session()).toMatchObject({ values: { grid: false, exposure: 0 }, loaded: false });
    const { events, stop } = recordEvents();
    loadWorkspaceChromeState("ws-1", {
      state: { controls: { exposure: 2, grid: "no" }, page: { zoom: 3 } },
    });
    stop();
    expect(session()).toMatchObject({
      values: { grid: false, exposure: 2 },
      pageState: { zoom: 3 },
      loaded: true,
      revision: 0,
    });
    expect(events).toEqual([
      { kind: "controls", attachmentId: "ws-1", values: { grid: false, exposure: 2 } },
    ]);
  });

  it("still adopts stored controls when only the page state changed first", () => {
    openWorkspaceChromeSession("ws-1", chrome);
    setWorkspaceChromePageState("ws-1", { zoom: 2 });
    loadWorkspaceChromeState("ws-1", { state: { controls: { exposure: 4 }, page: null } });
    expect(session()).toMatchObject({ values: { exposure: 4 }, pageState: { zoom: 2 } });
  });

  it("reads a bare page's state as page state", () => {
    openWorkspaceChromeSession("ws-1", chrome);
    loadWorkspaceChromeState("ws-1", { state: { zoom: 3 } });
    expect(session()).toMatchObject({ values: { exposure: 0 }, pageState: { zoom: 3 } });
  });

  it("keeps what the user set before the stored state arrived", () => {
    openWorkspaceChromeSession("ws-1", chrome);
    setWorkspaceChromeValue("exposure", 1);
    loadWorkspaceChromeState("ws-1", { state: { controls: { exposure: 4 }, page: null } });
    expect(session().values.exposure).toBe(1);
    expect(session().revision).toBe(1);
  });

  it("tells the page about user changes, clamped, and ignores no-ops", () => {
    openWorkspaceChromeSession("ws-1", chrome);
    const { events, stop } = recordEvents();
    setWorkspaceChromeValue("exposure", 9);
    setWorkspaceChromeValue("exposure", 5);
    setWorkspaceChromeValue("missing", 1);
    performWorkspaceChromeCommand({ id: "export" });
    stop();
    expect(events).toEqual([
      { kind: "command", attachmentId: "ws-1", command: { id: "exposure", value: 5 } },
      { kind: "controls", attachmentId: "ws-1", values: { grid: false, exposure: 5 } },
      { kind: "command", attachmentId: "ws-1", command: { id: "export" } },
    ]);
    expect(session().revision).toBe(1);
  });

  it("applies page patches without echoing them, storing only value changes", () => {
    openWorkspaceChromeSession("ws-1", chrome);
    const { events, stop } = recordEvents();
    expect(
      patchWorkspaceChrome("ws-1", {
        sidebar: [{ id: "history", title: "History", items: [{ id: "a", label: "Opened" }] }],
      }),
    ).toBeUndefined();
    // A new section brings a new value to store.
    expect(session().revision).toBe(1);
    expect(
      patchWorkspaceChrome("ws-1", {
        sidebar: [
          { id: "history", title: "History", items: [{ id: "a", label: "Opened", detail: "1" }] },
        ],
      }),
    ).toBeUndefined();
    expect(session().revision).toBe(1);
    expect(patchWorkspaceChrome("ws-1", { values: { exposure: -1 } })).toBeUndefined();
    stop();
    expect(events).toEqual([]);
    expect(session()).toMatchObject({ values: { exposure: -1, history: "a" }, revision: 2 });
    expect(session().chrome.sidebar).toHaveLength(1);
    expect(patchWorkspaceChrome("ws-1", { toolbar: "nope" })).toMatch(/chrome\.toolbar/);
  });

  it("routes page state only for the open workspace", () => {
    expect(setWorkspaceChromePageState("ws-1", { zoom: 1 })).toBe(false);
    openWorkspaceChromeSession("ws-1", chrome);
    expect(setWorkspaceChromePageState("ws-2", { zoom: 1 })).toBe(false);
    expect(setWorkspaceChromePageState("ws-1", { zoom: 1 })).toBe(true);
    expect(session()).toMatchObject({ pageState: { zoom: 1 }, revision: 1 });
    expect(patchWorkspaceChrome("ws-2", {})).toMatch(/no native chrome/);
  });
});
