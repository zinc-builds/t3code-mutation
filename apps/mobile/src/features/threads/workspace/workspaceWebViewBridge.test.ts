import { WORKSPACE_BRIDGE_METHODS } from "@t3tools/shared/mutationWorkspace";
import { describe, expect, it } from "vite-plus/test";

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
