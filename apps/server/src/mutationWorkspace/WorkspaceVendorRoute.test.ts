// @effect-diagnostics nodeBuiltinImport:off -- the browser test drives Chrome and an http server directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type KitVendor,
  makeWorkspaceKit,
  vendorScripts,
  WORKSPACE_VENDOR_ROUTE,
} from "@t3tools/workspace-kit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";
import * as WorkspaceVendorRoute from "./WorkspaceVendorRoute.ts";

// add(a, b) -> a + b
const ADD_WASM = "AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABags=";
const MODULE = 'import { two } from "./two.mjs";\nexport const add = (a) => a + two;\n';

const demo: KitVendor = {
  name: "demo",
  package: "@example/demo",
  version: "1.0.0-rc.1",
  license: "MIT",
  hash: "00112233aabbccdd",
  files: [
    { name: "classic.js", path: "classic.js", load: "script", content: "window.demoClassic = 41;" },
    { name: "demo.mjs", path: "esm/demo.mjs", load: "module", content: MODULE },
    { name: "two.mjs", path: "esm/two.mjs", load: "module", content: "export const two = 1;\n" },
    { name: "add.wasm", path: "wasm/add.wasm", load: "bytes", content: ADD_WASM },
  ],
  init: `t3kit.vendor.define("demo", async ({ exports, bytes }) => {
  const { instance } = await WebAssembly.instantiate(bytes("add.wasm"));
  return { classic: window.demoClassic, module: exports["demo.mjs"].add(1), wasm: instance.exports.add(40, 2) };
});`,
};

// The shipped registry, as the generator bakes it.
const RUNTIME = NodeFS.readFileSync(
  NodeURL.fileURLToPath(
    new URL("../kit/vendor/runtime.js", import.meta.resolve("@t3tools/workspace-kit")),
  ),
  "utf8",
);

const kit = makeWorkspaceKit({
  core: null,
  vendorRuntime: RUNTIME,
  vendor: [demo],
  primitives: [],
  templates: [],
});

const DIR = `${WORKSPACE_VENDOR_ROUTE}demo/1.0.0-rc.1/00112233aabbccdd/`;

/** The route behind the server's global CORS middleware, configured as in production or dev. */
const handlerFor = (devUrl?: URL) => {
  const config = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const base = yield* ServerConfig.ServerConfig;
      return ServerConfig.make(devUrl === undefined ? base : { ...base, devUrl });
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "vendor-route-test-" })));
  return HttpRouter.toWebHandler(
    Layer.merge(WorkspaceVendorRoute.layerWithKit(kit), ServerHttp.layerBrowserApiCors).pipe(
      Layer.provide(config),
      Layer.provide(NodeServices.layer),
    ),
    { disableLogger: true },
  );
};

// What an opaque-origin workspace page sends: no cookies, no credentials, `Origin: null`.
const fromPage = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://environment.example${path}`, { headers: { origin: "null", ...headers } });

describe("workspace vendor route", () => {
  const { handler, dispose } = handlerFor();
  afterAll(() => dispose());

  it("serves each file to an opaque-origin page with no credentials, cacheable for good", async () => {
    for (const [path, type, body] of [
      ["esm/demo.mjs", "text/javascript; charset=utf-8", MODULE],
      ["classic.js", "text/javascript; charset=utf-8", "window.demoClassic = 41;"],
      ["init.js", "text/javascript; charset=utf-8", demo.init],
    ] as const) {
      const response = await handler(fromPage(`${DIR}${path}`));
      expect(response.status, path).toBe(200);
      expect(Object.fromEntries(response.headers), path).toMatchObject({
        "content-type": type,
        "cache-control": "public, max-age=31536000, immutable",
        etag: '"00112233aabbccdd"',
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
      });
      expect(await response.text(), path).toBe(body);
    }
    const wasm = await handler(fromPage(`${DIR}wasm/add.wasm`));
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect(Buffer.from(await wasm.arrayBuffer()).toString("base64")).toBe(ADD_WASM);
  });

  it("revalidates by ETag and answers HEAD without a body", async () => {
    for (const etag of [
      '"00112233aabbccdd"',
      'W/"00112233aabbccdd"',
      '"other", "00112233aabbccdd"',
    ]) {
      const response = await handler(fromPage(`${DIR}esm/demo.mjs`, { "if-none-match": etag }));
      expect(response.status, etag).toBe(304);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    }
    expect((await handler(fromPage(`${DIR}esm/demo.mjs`, { "if-none-match": '"x"' }))).status).toBe(
      200,
    );
    const head = await handler(
      new Request(`https://environment.example${DIR}wasm/add.wasm`, { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/wasm");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("answers 404, uncached and readable by the page, for anything the kit does not ship", async () => {
    for (const path of [
      "nope/1.0.0-rc.1/00112233aabbccdd/esm/demo.mjs",
      "demo/1.0.0/00112233aabbccdd/esm/demo.mjs",
      "demo/1.0.0-rc.1/ffffffffffffffff/esm/demo.mjs",
      "demo/1.0.0-rc.1/00112233aabbccdd/esm/missing.mjs",
      "demo/1.0.0-rc.1/00112233aabbccdd/demo.mjs",
    ]) {
      const response = await handler(fromPage(`${WORKSPACE_VENDOR_ROUTE}${path}`));
      expect(response.status, path).toBe(404);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(response.headers.get("access-control-allow-origin"), path).toBe("*");
    }
  });

  it("keeps allowing any origin when dev CORS allows only the app's origins", async () => {
    const dev = handlerFor(new URL("http://localhost:5733"));
    try {
      const response = await dev.handler(fromPage(`${DIR}esm/demo.mjs`));
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      await dev.dispose();
    }
  });
});

// Real-browser test; runs only when this names a chrome-headless-shell (or Chrome).
const browser = process.env.T3CODE_TEST_HEADLESS_SHELL;

/** A page, as the asset route serves a workspace: sandboxed by its own CSP too. */
const workspacePage = `<!doctype html><html><head>${vendorScripts(RUNTIME, [demo], WORKSPACE_VENDOR_ROUTE)}</head><body><script>
Promise.all([
  t3kit.vendor.load("demo"),
  t3kit.vendor.file("demo", "wasm/add.wasm"),
  t3kit.vendor.file("demo", "esm/demo.mjs").then((blob) => blob.text()),
  t3kit.vendor.load("nope").then(() => "loaded", (error) => error.message),
  t3kit.vendor.file("demo", "add.wasm").then(() => "loaded", (error) => error.message),
]).then(
  ([api, wasm, moduleText, missing, unknownFile]) =>
    parent.postMessage({ origin: self.origin, api, wasm: { type: wasm.type, size: wasm.size }, moduleText, missing, unknownFile }, "*"),
  (error) => parent.postMessage({ error: String(error && error.message) }, "*"),
);
</script></body></html>`;

/**
 * Serves the route, the workspace page and an outer page that frames it from
 * another origin. Dev CORS, which allows only the app's origins, is the case
 * where the route's own header is all that lets the page in.
 */
const startServer = async () => {
  const { handler, dispose } = handlerFor(new URL("http://localhost:5733"));
  const server = NodeHttp.createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/outer.html" || path === "/api/assets/t0ken/page.html") {
      const outer = path === "/outer.html";
      const port = (server.address() as NodeNet.AddressInfo).port;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        ...(outer ? {} : { "content-security-policy": "sandbox allow-scripts allow-forms" }),
      });
      response.end(
        outer
          ? `<!doctype html><iframe sandbox="allow-scripts allow-forms" src="http://localhost:${port}/api/assets/t0ken/page.html"></iframe><script>addEventListener("message", (event) => console.log("RESULT " + JSON.stringify(event.data)));</script>`
          : workspacePage,
      );
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    void handler(
      new Request(`http://${request.headers.host}${path}`, {
        method: request.method ?? "GET",
        headers,
      }),
    ).then(
      async (routed) => {
        response.writeHead(routed.status, Object.fromEntries(routed.headers));
        response.end(Buffer.from(await routed.arrayBuffer()));
      },
      (error: unknown) => {
        response.writeHead(500).end(String(error));
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await dispose();
    },
  };
};

/** Opens `url` in a fresh headless browser and resolves to the first console line starting with `prefix`. */
const firstConsoleLine = (executable: string, url: string, prefix: string) => {
  const profile = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-vendor-browser-"));
  const chrome = NodeChildProcess.spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const toBrowser = chrome.stdio[3] as NodeNet.Socket;
  const fromBrowser = chrome.stdio[4] as NodeNet.Socket;
  let nextId = 0;
  const send = (method: string, params: object, sessionId?: string) => {
    const id = ++nextId;
    toBrowser.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    return id;
  };
  const closed = new Promise((resolve) => chrome.once("exit", resolve));
  const line = new Promise<string>((resolve, reject) => {
    chrome.once("error", reject);
    let buffered = "";
    let created: number | undefined;
    let attached: number | undefined;
    fromBrowser.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let end: number;
      while ((end = buffered.indexOf("\0")) !== -1) {
        const message = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        if (message.id === created) {
          attached = send("Target.attachToTarget", {
            targetId: message.result.targetId,
            flatten: true,
          });
        } else if (message.id === attached) {
          const sessionId = message.result.sessionId;
          send("Runtime.enable", {}, sessionId);
          send("Page.navigate", { url }, sessionId);
        } else if (message.method === "Runtime.consoleAPICalled") {
          const text = String(message.params.args[0]?.value ?? "");
          if (text.startsWith(prefix)) resolve(text.slice(prefix.length));
        } else if (message.method === "Runtime.exceptionThrown") {
          reject(new Error(message.params.exceptionDetails.text));
        }
      }
    });
    created = send("Target.createTarget", { url: "about:blank" });
  });
  return line.finally(async () => {
    chrome.kill();
    await closed;
    NodeFS.rmSync(profile, { recursive: true, force: true });
  });
};

describe.skipIf(browser === undefined)("workspace vendor route in a browser", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.close());

  it("loads a classic script, modules and wasm bytes into a sandboxed opaque-origin frame", async () => {
    const result = JSON.parse(
      await firstConsoleLine(browser!, `${server.origin}/outer.html`, "RESULT "),
    );
    expect(result).toEqual({
      origin: "null",
      api: { classic: 41, module: 2, wasm: 42 },
      wasm: { type: "application/wasm", size: 41 },
      moduleText: MODULE,
      missing: 't3kit.vendor: "nope" is not vendored into this page (vendored: demo)',
      unknownFile:
        't3kit.vendor: demo has no file "add.wasm" (files: classic.js, esm/demo.mjs, esm/two.mjs, wasm/add.wasm)',
    });
  }, 30_000);
});
