// @effect-diagnostics nodeBuiltinImport:off -- the generator is a plain Node script, so its fixtures are plain files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";

import { readKit, readSummary, renderKitModule } from "../scripts/generate.mjs";
import { GENERATED_KIT } from "./generated.ts";

const primitive = (name: string, header: string) =>
  `/**\n * t3kit.${name}: ${header}\n *\n * create(container) -> instance\n */\n(function () {\n  const t3kit = (window.t3kit = window.t3kit || {});\n  t3kit.${name} = { create() {} };\n})();\n`;

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
      assert.include(p.source, `t3kit.${p.name}`);
      assert.isFalse(p.docs.startsWith("/**"), `${p.name} docs keep comment markers`);
      assert.isAtMost(p.docs.split("\n").length, 40, `${p.name} docs header is too long`);
      assert.isAtMost(p.summary.length, 90, `${p.name} summary is too long`);
      assert.notInclude(p.summary, "\n");
    }
  });

  it("loads links after the primitives it wires", () => {
    assert.strictEqual(GENERATED_KIT.primitives.at(-1)?.name, "links");
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
        boltOn: { addPanel: "addPanel(title) -> HTMLElement" },
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
    assert.deepEqual(kit.templates[0]?.boltOn, { addPanel: "addPanel(title) -> HTMLElement" });
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

  it("summarizes from the opening sentence, adding the next after a bare noun phrase", () => {
    assert.strictEqual(
      readSummary("t3kit.curves: tone curve editor. RGB master + R/G/B curves.\nmore", "curves"),
      "tone curve editor. RGB master + R/G/B curves.",
    );
    const long = readSummary(`layers: ${"word ".repeat(40)}end.`, "layers");
    assert.isAtMost(long.length, 90);
    assert.isTrue(long.endsWith("…"));
  });
});
