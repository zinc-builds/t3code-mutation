import { WORKSPACE_BRIDGE_METHODS } from "@t3tools/shared/mutationWorkspace";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  readWorkspaceWebViewMessage,
  workspaceInitializeScript,
  workspaceOuterDocument,
  workspaceReceiveScript,
} from "./workspaceWebViewBridge";

const SECRET = "secret-1";

const relayed = (message: unknown, active = true, secret = SECRET) =>
  JSON.stringify({ secret, active, message });

const wireFile = (name: string, type: string, base64 = "aGk=") => ({
  t3File: true,
  name,
  type,
  base64,
});

describe("readWorkspaceWebViewMessage", () => {
  it("drops anything the outer page did not relay", () => {
    const send = {
      jsonrpc: "2.0",
      id: "w1",
      method: WORKSPACE_BRIDGE_METHODS.send,
      params: { text: "hi" },
    };
    expect(readWorkspaceWebViewMessage(relayed(send, true, "other"), SECRET)).toBeUndefined();
    expect(readWorkspaceWebViewMessage(JSON.stringify(send), SECRET)).toBeUndefined();
    expect(readWorkspaceWebViewMessage("not json", SECRET)).toBeUndefined();
  });

  it("reads a send with the files the outer page encoded, and whether the user had touched the page", () => {
    const message = readWorkspaceWebViewMessage(
      relayed(
        {
          jsonrpc: "2.0",
          id: "w2",
          method: WORKSPACE_BRIDGE_METHODS.send,
          params: { text: "Apply these", files: [wireFile("  edit.json ", "application/json")] },
        },
        false,
      ),
      SECRET,
    );
    expect(message).toEqual({
      kind: "bridge",
      active: false,
      message: {
        id: "w2",
        method: WORKSPACE_BRIDGE_METHODS.send,
        text: "Apply these",
        files: [{ name: "edit.json", mimeType: "application/json", base64: "aGk=" }],
      },
    });
  });

  it("names a file the page left unnamed", () => {
    const message = readWorkspaceWebViewMessage(
      relayed({
        jsonrpc: "2.0",
        id: "w3",
        method: WORKSPACE_BRIDGE_METHODS.download,
        params: { file: wireFile(" ", "image/png") },
      }),
      SECRET,
    );
    expect(message?.kind === "bridge" && message.message).toEqual({
      id: "w3",
      method: WORKSPACE_BRIDGE_METHODS.download,
      file: { name: "export", mimeType: "image/png", base64: "aGk=" },
    });
  });

  it("refuses files that were not encoded", () => {
    expect(
      readWorkspaceWebViewMessage(
        relayed({
          jsonrpc: "2.0",
          id: "w4",
          method: WORKSPACE_BRIDGE_METHODS.attach,
          params: { files: [{ name: "x.png" }] },
        }),
        SECRET,
      ),
    ).toBeUndefined();
  });

  it("reads notifications, chrome requests, links, and the relay's own reports", () => {
    expect(
      readWorkspaceWebViewMessage(
        relayed({
          jsonrpc: "2.0",
          method: WORKSPACE_BRIDGE_METHODS.setState,
          params: { state: { v: 1 } },
        }),
        SECRET,
      ),
    ).toEqual({
      kind: "bridge",
      active: true,
      message: { method: WORKSPACE_BRIDGE_METHODS.setState, state: { v: 1 } },
    });
    expect(
      readWorkspaceWebViewMessage(
        relayed({
          jsonrpc: "2.0",
          id: "c1",
          method: WORKSPACE_BRIDGE_METHODS.setChrome,
          params: { patch: {} },
        }),
        SECRET,
      ),
    ).toEqual({ kind: "set-chrome", id: "c1" });
    expect(
      readWorkspaceWebViewMessage(
        relayed({
          jsonrpc: "2.0",
          id: "t3-link-1",
          method: "ui/open-link",
          params: { url: "https://t3.codes" },
        }),
        SECRET,
      ),
    ).toEqual({ kind: "open-link", id: "t3-link-1", url: "https://t3.codes", active: true });
    expect(readWorkspaceWebViewMessage(relayed({ t3: "navigated" }, false), SECRET)).toEqual({
      kind: "navigated",
    });
    expect(
      readWorkspaceWebViewMessage(
        relayed({ t3: "assets-failed", message: "photo.png could not be loaded (HTTP 404)." }),
        SECRET,
      ),
    ).toEqual({ kind: "assets-failed", message: "photo.png could not be loaded (HTTP 404)." });
  });
});

describe("workspace scripts", () => {
  it("cannot be closed early by the content they carry", () => {
    const hostile = "</script><script>alert(1)</script>";
    for (const script of [
      workspaceReceiveScript({ text: hostile }),
      workspaceInitializeScript("w1", { note: hostile }, []),
      workspaceOuterDocument(`https://host/a#${hostile}`, hostile),
    ]) {
      expect(script).not.toContain("</script><script>alert");
    }
  });

  it("answers initialize with null for a page that stored nothing", () => {
    expect(workspaceInitializeScript("w1", undefined, [])).toContain('("w1",null,[])');
  });
});

/** Runs the outer page's relay with stand-ins for the WebView and the page frame. */
function loadOuterPage(fetch: (url: string) => Promise<Response>) {
  const html = workspaceOuterDocument("https://env/api/assets/page/doc.html", SECRET);
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
  const toPage: Array<unknown> = [];
  const frame = {
    addEventListener: () => undefined,
    contentWindow: { postMessage: (message: unknown) => toPage.push(message) },
    src: "",
  };
  const window: Record<string, unknown> = {
    addEventListener: () => undefined,
    ReactNativeWebView: { postMessage: () => undefined },
  };
  new Function("window", "document", "fetch", "navigator", script)(
    window,
    { getElementById: () => frame },
    fetch,
    {},
  );
  const initialize = window.__t3WorkspaceInitialize as (
    id: string,
    state: unknown,
    assets: ReadonlyArray<unknown>,
  ) => void;
  return { initialize, toPage };
}

describe("outer page initialize", () => {
  it("hands video and audio over by URL without fetching them, and fetches everything else", async () => {
    const fetched: Array<string> = [];
    const { initialize, toPage } = loadOuterPage(async (url) => {
      fetched.push(url);
      return new Response("region,total");
    });
    initialize("w1", null, [
      {
        name: "IMG_0151.MOV",
        mimeType: "video/quicktime",
        source: "file",
        path: "/Volumes/X10/IMG_0151.MOV",
        url: "https://env/api/assets/a/IMG_0151.MOV",
        stream: true,
        size: 643_000_000,
      },
      {
        name: "sales.csv",
        mimeType: "text/csv",
        source: "file",
        path: "/work/sales.csv",
        url: "https://env/api/assets/b/sales.csv",
        stream: false,
      },
    ]);
    await vi.waitFor(() => expect(toPage).toHaveLength(1));
    expect(fetched).toEqual(["https://env/api/assets/b/sales.csv"]);
    const answer = toPage[0] as {
      id: string;
      result: { assets: Array<Record<string, unknown>> };
    };
    expect(answer.id).toBe("w1");
    expect(answer.result.assets[0]).toEqual({
      name: "IMG_0151.MOV",
      mimeType: "video/quicktime",
      source: "file",
      attachmentId: undefined,
      path: "/Volumes/X10/IMG_0151.MOV",
      url: "https://env/api/assets/a/IMG_0151.MOV",
      size: 643_000_000,
    });
    const csv = answer.result.assets[1]!.file as File;
    expect([csv.name, csv.type, await csv.text()]).toEqual([
      "sales.csv",
      "text/csv",
      "region,total",
    ]);
  });
});
