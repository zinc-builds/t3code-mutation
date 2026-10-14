// @effect-diagnostics nodeBuiltinImport:off -- the generator is a plain Node script, so its fixtures are plain files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, assert, describe, it } from "@effect/vitest";

import {
  primitiveGlobal,
  readKit,
  readSummary,
  renderKitModule,
  vendorModuleEpilogue,
} from "../scripts/generate.mjs";
import { GENERATED_KIT } from "./generated.ts";

const primitive = (name: string, header: string) =>
  `/**\n * t3kit.${name}: ${header}\n *\n * create(container) -> instance\n */\n(function () {\n  const t3kit = (window.t3kit = window.t3kit || {});\n  t3kit.${name} = { create() {} };\n})();\n`;

const boltOn = {
  summary: "options.customScript runs once.",
  api: ["addPanel(title) -> HTMLElement"],
  reservedShortcuts: ["e"],
  example: "t3template.addPanel('Extra');",
  note: "kept verbatim",
};

const dirs: Array<string> = [];
const kitDir = (files: Record<string, string>) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-workspace-kit-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.join(dir, path, ".."), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, path), text);
  }
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("the committed kit", () => {
  it("documents every primitive and registers it under its own name", () => {
    assert.isAbove(GENERATED_KIT.primitives.length, 0);
    for (const p of GENERATED_KIT.primitives) {
      assert.match(p.name, /^[a-z][a-z0-9-]*$/);
      assert.include(p.source, `t3kit.${primitiveGlobal(p.name)}`);
      assert.isFalse(p.docs.startsWith("/**"), `${p.name} docs keep comment markers`);
      assert.isAtMost(p.docs.split("\n").length, 40, `${p.name} docs header is too long`);
      assert.isAtMost(p.summary.length, 90, `${p.name} summary is too long`);
      assert.notInclude(p.summary, "\n");
    }
  });

  it("loads links after the primitives it wires", () => {
    assert.strictEqual(GENERATED_KIT.primitives.at(-1)?.name, "links");
  });

  it("is generated from the current kit sources and pinned packages", () => {
    const committed = NodeFS.readFileSync(new URL("./generated.ts", import.meta.url), "utf8");
    const kit = readKit(NodeURL.fileURLToPath(new URL("../kit", import.meta.url)));
    assert.isTrue(
      committed === renderKitModule(kit),
      "src/generated.ts is stale: run node packages/workspace-kit/scripts/generate.mjs",
    );
  });
});

describe("generate.mjs", () => {
  it("reads primitives, core, and templates, keeping template.json verbatim", () => {
    const markers = {
      type: "array",
      items: {
        type: "object",
        properties: { time: { type: "number" }, label: { type: "string" } },
        required: ["time"],
      },
      default: [],
    } as const;
    const dir = kitDir({
      "primitives/develop.js": primitive("develop", "WebGL2 photo develop."),
      "primitives/links.js": primitive("links", "wire kit primitives together."),
      "primitives/viewer.js": primitive("viewer", "image viewport."),
      "primitives/_core.js": "window.t3kit = {};",
      "templates/photo-develop/template.html": "<!doctype html><head></head><body></body>",
      "templates/photo-develop/template.json": JSON.stringify({
        id: "photo-develop",
        title: "Photo Develop",
        summary: "Grade one photo.",
        kit: ["develop"],
        options: {
          strength: { type: "number", minimum: 0, maximum: 1, default: 0.5, label: "x" },
          markers,
        },
        examples: [{ strength: 1, markers: [{ time: 2, label: "Beat" }] }],
        boltOn,
      }),
    });
    const kit = readKit(dir);
    assert.deepEqual(
      kit.primitives.map((p) => p.name),
      ["develop", "viewer", "links"],
    );
    assert.strictEqual(kit.core, "window.t3kit = {};");
    assert.deepEqual(kit.templates[0]?.options, {
      strength: { type: "number", minimum: 0, maximum: 1, default: 0.5, label: "x" },
      markers,
    });
    assert.deepEqual(kit.templates[0]?.boltOn, boltOn);
    const module = renderKitModule(kit);
    assert.include(module, "export const GENERATED_KIT: KitSource = {");
    assert.include(module, '"html": "<!doctype html><head></head><body></body>"');
  });

  const template = (manifest: Record<string, unknown>) =>
    kitDir({
      "primitives/viewer.js": primitive("viewer", "image viewport."),
      "templates/cut/template.html": "<p></p>",
      "templates/cut/template.json": JSON.stringify({
        id: "cut",
        title: "Cut",
        summary: "Cut video.",
        boltOn,
        ...manifest,
      }),
    });

  it("fails on option specs T3 would misread", () => {
    assert.throws(
      () => readKit(template({ options: { in: { type: "number", min: 0 } } })),
      /options\.in\.min is not JSON Schema; write minimum/,
    );
    assert.throws(
      () =>
        readKit(
          template({
            options: { markers: { type: "array", items: { type: "object", required: ["time"] } } },
          }),
        ),
      /options\.markers\.items\.required names "time", which is not in its properties/,
    );
  });

  it("fails on an example its own options reject", () => {
    assert.throws(
      () =>
        readKit(
          template({
            options: {
              markers: {
                type: "array",
                items: { type: "object", properties: { time: { type: "number" } } },
              },
            },
            examples: [{ markers: [{ time: "3" }] }],
          }),
        ),
      /examples\[0\]\.markers\[0\]\.time: expected a number/,
    );
  });

  it("handles a kit without templates", () => {
    const dir = kitDir({ "primitives/viewer.js": primitive("viewer", "image viewport.") });
    assert.deepEqual(readKit(dir).templates, []);
  });

  it("fails on a template that names an unknown primitive", () => {
    const dir = kitDir({
      "primitives/viewer.js": primitive("viewer", "image viewport."),
      "templates/cut/template.html": "<p></p>",
      "templates/cut/template.json": JSON.stringify({
        id: "cut",
        title: "Cut",
        summary: "Cut video.",
        kit: ["timeline"],
      }),
    });
    assert.throws(() => readKit(dir), /kit names unknown "timeline"/);
  });

  it("fails on a primitive that registers under another name", () => {
    const dir = kitDir({
      "primitives/viewer.js": primitive("view", "image viewport.").replace("t3kit.view:", "x:"),
    });
    assert.throws(() => readKit(dir), /must register itself as t3kit.viewer/);
  });

  it("registers a hyphenated primitive under its camelCased name", () => {
    const source = primitive("templateRuntime", "the bolt-on runtime. Templates use it.");
    const dir = kitDir({ "primitives/template-runtime.js": source });
    const [runtime] = readKit(dir).primitives;
    assert.strictEqual(runtime?.name, "template-runtime");
    assert.strictEqual(runtime?.summary, "the bolt-on runtime. Templates use it.");
    const wrong = kitDir({
      "primitives/template-runtime.js": source.replace("t3kit.templateRuntime =", "x ="),
    });
    assert.throws(() => readKit(wrong), /must register itself as t3kit.templateRuntime/);
  });

  it("keeps a template's chrome flag or manifest and fails on anything else", () => {
    const chrome = { toolbar: [{ type: "button", id: "export", label: "Export" }] };
    assert.deepEqual(readKit(template({ chrome })).templates[0]?.chrome, chrome);
    assert.isTrue(readKit(template({ chrome: true })).templates[0]?.chrome);
    assert.isFalse(readKit(template({ chrome: false })).templates[0]?.chrome);
    for (const wrong of [[chrome], null, "yes"]) {
      assert.throws(
        () => readKit(template({ chrome: wrong })),
        /chrome must be true, false or a chrome manifest object/,
      );
    }
  });

  it("fails on a template without complete bolt-on docs", () => {
    assert.throws(() => readKit(template({ boltOn: undefined })), /needs a boltOn object/);
    assert.throws(
      () => readKit(template({ boltOn: { ...boltOn, api: [] } })),
      /boltOn.api must be a non-empty array/,
    );
    assert.throws(
      () => readKit(template({ boltOn: { ...boltOn, example: "" } })),
      /boltOn.example must be a non-empty string/,
    );
    assert.throws(
      () => readKit(template({ boltOn: { ...boltOn, reservedShortcuts: "e" } })),
      /boltOn.reservedShortcuts must be an array/,
    );
  });

  it("summarizes from the opening sentence, adding the next after a bare noun phrase", () => {
    assert.strictEqual(
      readSummary("t3kit.curves: tone curve editor. RGB master + R/G/B curves.\nmore", "curves"),
      "tone curve editor. RGB master + R/G/B curves.",
    );
    const long = readSummary(`layers: ${"word ".repeat(40)}end.`, "layers");
    assert.isAtMost(long.length, 90);
    assert.isTrue(long.endsWith("…"));
  });

  const vendorRuntime =
    "/**\n * t3kit.vendor: registry.\n */\n(function () { window.t3kit.vendor = {}; })();\n";
  const sqlModule =
    "/* SQL */\nconst open = () => 1;\nconst version$1 = '1';\nexport { open as default, version$1 as version };\n";
  const vendored = (
    overrides: { pin?: string; installed?: string; module?: string; files?: unknown } = {},
  ) =>
    NodePath.join(
      kitDir({
        "package.json": JSON.stringify({
          name: "@t3tools/workspace-kit",
          devDependencies: { "@example/sql": overrides.pin ?? "1.2.3" },
        }),
        "node_modules/@example/sql/package.json": JSON.stringify({
          version: overrides.installed ?? "1.2.3",
        }),
        "node_modules/@example/sql/dist/sql.mjs": overrides.module ?? sqlModule,
        "node_modules/@example/sql/dist/sql.wasm": "\0asm",
        "kit/primitives/viewer.js": primitive("viewer", "image viewport."),
        "kit/vendor/runtime.js": vendorRuntime,
        "kit/vendor/sql/vendor.json": JSON.stringify({
          package: "@example/sql",
          version: "1.2.3",
          license: "MIT",
          files: overrides.files ?? [
            { path: "dist/sql.mjs", load: "module" },
            { path: "dist/sql.wasm", load: "bytes" },
          ],
        }),
        "kit/vendor/sql/init.js":
          '/**\n * sql: init.\n */\nt3kit.vendor.define("sql", ({ exports }) => exports["sql.mjs"].default());\n',
        "kit/templates/query/template.html": "<p></p>",
        "kit/templates/query/template.json": JSON.stringify({
          id: "query",
          title: "Query",
          summary: "Query data.",
          vendor: ["sql"],
          boltOn,
        }),
      }),
      "kit",
    );

  it("vendors a pinned package's files, with module exports handed to t3kit.vendor", () => {
    const kit = readKit(vendored());
    assert.strictEqual(kit.vendorRuntime, vendorRuntime);
    assert.deepEqual(kit.templates[0]?.vendor, ["sql"]);
    assert.deepEqual(
      kit.templates.map((t) => t.kit),
      [[]],
    );
    const [sql] = kit.vendor;
    assert.deepEqual(
      { ...sql, files: undefined },
      {
        name: "sql",
        package: "@example/sql",
        version: "1.2.3",
        license: "MIT",
        files: undefined,
        init: '/**\n * sql: init.\n */\nt3kit.vendor.define("sql", ({ exports }) => exports["sql.mjs"].default());\n',
      },
    );
    assert.deepEqual(sql?.files, [
      {
        name: "sql.mjs",
        load: "module",
        content: `${sqlModule}\n;t3kit.vendor.ran("sql", "sql.mjs", { "default": open, "version": version$1 });\n`,
      },
      { name: "sql.wasm", load: "bytes", content: Buffer.from("\0asm").toString("base64") },
    ]);
    assert.include(renderKitModule(kit), '"vendorRuntime": ');
  });

  it("refuses a package the kit's package does not pin to exactly that version", () => {
    assert.throws(() => readKit(vendored({ pin: "^1.2.3" })), /pins @example\/sql to "\^1.2.3"/);
    assert.throws(() => readKit(vendored({ installed: "1.2.4" })), /but 1.2.4 is installed/);
    assert.throws(
      () => readKit(vendored({ files: [{ path: "../../../package.json", load: "script" }] })),
      /has no file/,
    );
    assert.throws(
      () => readKit(vendored({ files: [{ path: "dist/sql.mjs", load: "eval" }] })),
      /must be \{ path, load: script \| module \| bytes \}/,
    );
  });

  it("refuses a module that imports others or does not end in one export list", () => {
    assert.throws(
      () => vendorModuleEpilogue('import { x } from "./x.js";\nexport { x };', "sql", "a.mjs"),
      /imports other modules/,
    );
    assert.throws(
      () => vendorModuleEpilogue("export default 1;\nexport { a };", "sql", "a.mjs"),
      /one "export \{ \.\.\. \}" list/,
    );
    assert.throws(
      () => readKit(vendored({ module: "const a = '<!-- x';\nexport { a };" })),
      /contains "<!--"/,
    );
    // Words like "important" or "importDb(" in comments and code are not imports.
    assert.strictEqual(
      vendorModuleEpilogue("// important\nimportDb(1);\nexport { a };", "sql", "a.mjs"),
      '\n;t3kit.vendor.ran("sql", "a.mjs", { "a": a });\n',
    );
  });

  it("fails on a template that vendors an unknown library", () => {
    const dir = template({ vendor: ["sql"] });
    assert.throws(() => readKit(dir), /vendor names unknown "sql"/);
  });
});
