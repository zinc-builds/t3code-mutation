#!/usr/bin/env node
// Bakes the workspace kit (primitives and templates) into src/generated.ts.
// The server is bundled, so it cannot read these files from disk at runtime.
//
//   node packages/workspace-kit/scripts/generate.mjs <kitDir>
//
// <kitDir> holds primitives/<name>.js (and optionally primitives/_core.js)
// and templates/<id>/{template.html,template.json}. Anything malformed fails
// the run; nothing is skipped.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const outFile = NodePath.resolve(here, "../src/generated.ts");

// Primitives that wire other primitives together must load after them.
const LOAD_LAST = new Set(["links"]);
const OPTION_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
const NAME = /^[a-z][a-z0-9-]*$/;

const fail = (message) => {
  throw new Error(`workspace-kit generate: ${message}`);
};

/** The leading JSDoc block, without comment markers. */
export function readDocsHeader(source, file) {
  const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source);
  if (!match) fail(`${file} must start with a /** docs header */.`);
  const lines = match[1].split("\n").map((line) => line.replace(/^\s*\* ?/, "").trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (lines.length === 0) fail(`${file} has an empty docs header.`);
  return lines.join("\n");
}

const SUMMARY_MAX = 90;

/**
 * The catalog line: the header's opening sentence (two when the first is a
 * bare noun phrase), without the `t3kit.<name>:` lead, cut to SUMMARY_MAX.
 */
export function readSummary(docs, name) {
  const paragraph = docs.split("\n\n")[0].split("\n").join(" ").replace(/\s+/g, " ");
  const lead = paragraph.replace(new RegExp(`^(?:t3kit\\.)?${name}:\\s*`), "");
  const sentences = lead.match(/.+?\.(?=\s|$)/g) ?? [lead];
  let summary = sentences[0].trim();
  if (summary.length < 60 && sentences[1]) summary = `${summary} ${sentences[1].trim()}`;
  if (summary.length <= SUMMARY_MAX) return summary;
  const cut = summary.slice(0, SUMMARY_MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[\s,;:(]+$/, "")}…`;
}

function readPrimitives(kitDir) {
  const dir = NodePath.join(kitDir, "primitives");
  if (!NodeFS.existsSync(dir)) fail(`${dir} does not exist.`);
  const files = NodeFS.readdirSync(dir)
    .filter((file) => file.endsWith(".js") && !file.startsWith("_"))
    .toSorted();
  if (files.length === 0) fail(`${dir} has no primitives.`);
  const primitives = files.map((file) => {
    const name = file.slice(0, -3);
    if (!NAME.test(name)) fail(`primitive file name ${file} must be lowercase letters and digits.`);
    const source = NodeFS.readFileSync(NodePath.join(dir, file), "utf8");
    if (!new RegExp(`t3kit\\.${name}\\s*=`).test(source)) {
      fail(`${file} must register itself as t3kit.${name}.`);
    }
    const docs = readDocsHeader(source, file);
    return { name, summary: readSummary(docs, name), docs, source };
  });
  primitives.sort((a, b) => Number(LOAD_LAST.has(a.name)) - Number(LOAD_LAST.has(b.name)));
  const corePath = NodePath.join(dir, "_core.js");
  const core = NodeFS.existsSync(corePath) ? NodeFS.readFileSync(corePath, "utf8") : null;
  return { primitives, core };
}

const SPEC_KEYS = new Set([
  "type",
  "enum",
  "items",
  "minimum",
  "maximum",
  "default",
  "description",
]);
const SPEC_ALIASES = { min: "minimum", max: "maximum" };
const warnings = [];

/** One option's spec, reduced to the keys T3 checks (see TemplateOptionSpec). */
function readOptionSpec(spec, where) {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    fail(`${where} must be an object.`);
  }
  const out = {};
  for (const [rawKey, value] of Object.entries(spec)) {
    const key = SPEC_ALIASES[rawKey] ?? rawKey;
    if (SPEC_KEYS.has(key)) out[key] = value;
    else warnings.push(`${where}.${rawKey} is not checked by T3 and was left out.`);
  }
  if (out.type !== undefined && !OPTION_TYPES.has(out.type)) {
    fail(`${where}.type must be one of ${[...OPTION_TYPES].join(", ")}.`);
  }
  if (out.enum !== undefined && !Array.isArray(out.enum)) fail(`${where}.enum must be an array.`);
  for (const key of ["minimum", "maximum"]) {
    if (out[key] !== undefined && typeof out[key] !== "number")
      fail(`${where}.${key} must be a number.`);
  }
  if (out.items !== undefined) out.items = readOptionSpec(out.items, `${where}.items`);
  return out;
}

function readTemplates(kitDir, primitiveNames) {
  const dir = NodePath.join(kitDir, "templates");
  if (!NodeFS.existsSync(dir)) return [];
  return NodeFS.readdirSync(dir)
    .filter((entry) => NodeFS.statSync(NodePath.join(dir, entry)).isDirectory())
    .toSorted()
    .map((id) => {
      const where = `templates/${id}`;
      const htmlPath = NodePath.join(dir, id, "template.html");
      const jsonPath = NodePath.join(dir, id, "template.json");
      if (!NodeFS.existsSync(htmlPath) || !NodeFS.existsSync(jsonPath)) {
        fail(`${where} needs both template.html and template.json.`);
      }
      const manifest = JSON.parse(NodeFS.readFileSync(jsonPath, "utf8"));
      if (manifest.id !== id) fail(`${where}/template.json id must be "${id}".`);
      for (const key of ["title", "summary"]) {
        if (typeof manifest[key] !== "string" || manifest[key].trim() === "") {
          fail(`${where}/template.json needs a ${key}.`);
        }
      }
      const kit = manifest.kit ?? [];
      if (!Array.isArray(kit)) fail(`${where}/template.json kit must be an array.`);
      for (const name of kit) {
        if (!primitiveNames.has(name)) fail(`${where}/template.json kit names unknown "${name}".`);
      }
      const options = manifest.options ?? {};
      if (options === null || typeof options !== "object" || Array.isArray(options)) {
        fail(`${where}/template.json options must be an object.`);
      }
      const specs = Object.fromEntries(
        Object.entries(options).map(([key, spec]) => [
          key,
          readOptionSpec(spec, `${where}/template.json options.${key}`),
        ]),
      );
      const examples = manifest.examples ?? [];
      if (!Array.isArray(examples)) fail(`${where}/template.json examples must be an array.`);
      return {
        id,
        title: manifest.title,
        summary: manifest.summary,
        kit,
        options: specs,
        examples,
        html: NodeFS.readFileSync(htmlPath, "utf8"),
      };
    });
}

/** Reads and checks a kit directory. */
export function readKit(kitDir) {
  const { primitives, core } = readPrimitives(kitDir);
  const templates = readTemplates(kitDir, new Set(primitives.map((p) => p.name)));
  return { core, primitives, templates };
}

/** The text of src/generated.ts for a kit. */
export function renderKitModule(kit) {
  return `// Generated; do not edit. Regenerate with
//   node packages/workspace-kit/scripts/generate.mjs <kitDir>
import type { KitSource } from "./types.ts";

export const GENERATED_KIT: KitSource = ${JSON.stringify(kit, null, 2)};
`;
}

function main() {
  const kitDirArg = process.argv[2];
  if (!kitDirArg) fail("usage: node scripts/generate.mjs <kitDir>");
  const { core, primitives, templates } = readKit(NodePath.resolve(kitDirArg));
  NodeFS.writeFileSync(outFile, renderKitModule({ core, primitives, templates }));
  console.log(
    JSON.stringify({
      out: outFile,
      core: core !== null,
      primitives: primitives.map((p) => p.name),
      templates: templates.map((t) => t.id),
      warnings,
    }),
  );
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  main();
