#!/usr/bin/env node
// Bakes the workspace kit (primitives, templates and vendored libraries) into
// src/generated.ts. The server is bundled, so it cannot read these files from
// disk at runtime.
//
//   node packages/workspace-kit/scripts/generate.mjs   (sources: packages/workspace-kit/kit)
//
// <kitDir> holds primitives/<name>.js (and optionally primitives/_core.js),
// templates/<id>/{template.html,template.json}, and vendor/runtime.js with
// vendor/<name>/{vendor.json,init.js}. A vendored library's files come from
// the npm package it names, installed in the package that owns the kit (here
// packages/workspace-kit) and pinned there to that exact version. Anything
// malformed fails the run; nothing is skipped.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { validateTemplateOptions } from "../src/templateOptions.ts";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const outFile = NodePath.resolve(here, "../src/generated.ts");

// Primitives that wire other primitives together must load after them.
const LOAD_LAST = new Set(["links"]);
const VENDOR_LOADS = new Set(["script", "module", "bytes"]);
// A vendored file's path in its package, served as is: plain segments only.
const VENDOR_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
// Served next to the library's files, so no vendored file may take its place.
const VENDOR_INIT_PATH = "init.js";
const VENDOR_HASH_LENGTH = 16;
// An exact npm version: no range, tag or URL.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OPTION_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);
const NAME = /^[a-z][a-z0-9-]*$/;

/** The global a primitive registers: `template-runtime` -> `t3kit.templateRuntime`. */
export const primitiveGlobal = (name) => name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

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
  const lead = paragraph.replace(
    new RegExp(`^(?:t3kit\\.)?(?:${name}|${primitiveGlobal(name)}):\\s*`),
    "",
  );
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
    if (!NAME.test(name)) {
      fail(`primitive file name ${file} must be lowercase letters, digits and hyphens.`);
    }
    const source = NodeFS.readFileSync(NodePath.join(dir, file), "utf8");
    const global = primitiveGlobal(name);
    if (!new RegExp(`t3kit\\.${global}\\s*=`).test(source)) {
      fail(`${file} must register itself as t3kit.${global}.`);
    }
    const docs = readDocsHeader(source, file);
    return { name, summary: readSummary(docs, name), docs, source };
  });
  primitives.sort((a, b) => Number(LOAD_LAST.has(a.name)) - Number(LOAD_LAST.has(b.name)));
  const corePath = NodePath.join(dir, "_core.js");
  const core = NodeFS.existsSync(corePath) ? NodeFS.readFileSync(corePath, "utf8") : null;
  return { primitives, core };
}

/**
 * Checks a vendored ES module's static imports. T3 serves a library's files
 * from one directory laid out as in the package, so a module may import
 * another module the library vendors by a relative path, and nothing else:
 * a bare specifier or a file it does not vendor would fail in the page.
 */
function checkVendorModuleImports(source, file, modulePaths, where) {
  const specifiers = [
    ...source.matchAll(
      /^\s*(?:import|export)\s*(?:[\w$*{][\w$*{}\s,]*\bfrom\s*)?["']([^"']+)["']/gm,
    ),
  ].map((match) => match[1]);
  for (const specifier of specifiers) {
    const target =
      specifier.startsWith("./") || specifier.startsWith("../")
        ? NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(file), specifier))
        : null;
    if (target === null || !modulePaths.has(target)) {
      fail(
        `${where} imports "${specifier}"; a vendored module may import only another module the library vendors, by a relative path.`,
      );
    }
  }
}

const sha256 = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/**
 * The library's content hash, in every URL T3 serves its files at: it changes
 * with any file, the init or the version, so a cached file is never stale.
 */
function vendorHash(manifest, files, init) {
  const parts = [
    manifest.package,
    manifest.version,
    ...files.map((file) => `${file.path}\0${file.load}\0${sha256(file.bytes)}`),
    sha256(init),
  ];
  return sha256(parts.join("\n")).slice(0, VENDOR_HASH_LENGTH);
}

/** The installed package's manifest, which must be the exact version the kit's package pins. */
function readVendorPackage(packageDir, pkg, version, where) {
  const owner = JSON.parse(NodeFS.readFileSync(NodePath.join(packageDir, "package.json"), "utf8"));
  const pinned = owner.devDependencies?.[pkg];
  if (pinned !== version) {
    fail(
      `${where} names ${pkg}@${version}, but ${owner.name} pins ${pkg} to ${JSON.stringify(pinned ?? null)}; add it to devDependencies at exactly ${version}.`,
    );
  }
  const root = NodePath.join(packageDir, "node_modules", ...pkg.split("/"));
  const manifestPath = NodePath.join(root, "package.json");
  if (!NodeFS.existsSync(manifestPath)) fail(`${where}: ${pkg} is not installed; run vp i.`);
  const installed = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")).version;
  if (installed !== version) {
    fail(`${where} names ${pkg}@${version}, but ${installed} is installed; run vp i.`);
  }
  return root;
}

/**
 * Reads kitDir/vendor: the t3kit.vendor runtime and each library's manifest,
 * files and init script. Packages resolve from packageDir/node_modules.
 */
export function readVendor(kitDir, packageDir) {
  const dir = NodePath.join(kitDir, "vendor");
  if (!NodeFS.existsSync(dir)) return { vendorRuntime: null, vendor: [] };
  const runtimePath = NodePath.join(dir, "runtime.js");
  if (!NodeFS.existsSync(runtimePath)) fail(`${dir} needs runtime.js, the t3kit.vendor registry.`);
  const vendorRuntime = NodeFS.readFileSync(runtimePath, "utf8");
  if (!/t3kit\.vendor\s*=/.test(vendorRuntime))
    fail("vendor/runtime.js must register t3kit.vendor.");
  readDocsHeader(vendorRuntime, "vendor/runtime.js");
  const vendor = NodeFS.readdirSync(dir)
    .filter((entry) => NodeFS.statSync(NodePath.join(dir, entry)).isDirectory())
    .toSorted()
    .map((name) => {
      const where = `vendor/${name}`;
      if (!NAME.test(name))
        fail(`${where}: a library name is lowercase letters, digits and hyphens.`);
      const manifestPath = NodePath.join(dir, name, "vendor.json");
      const initPath = NodePath.join(dir, name, "init.js");
      if (!NodeFS.existsSync(manifestPath) || !NodeFS.existsSync(initPath)) {
        fail(`${where} needs both vendor.json and init.js.`);
      }
      const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
      for (const key of ["package", "version", "license"]) {
        if (typeof manifest[key] !== "string" || manifest[key].trim() === "") {
          fail(`${where}/vendor.json needs a ${key}.`);
        }
      }
      if (!EXACT_VERSION.test(manifest.version)) {
        fail(`${where}/vendor.json version must be an exact version, not "${manifest.version}".`);
      }
      const root = readVendorPackage(packageDir, manifest.package, manifest.version, where);
      if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
        fail(`${where}/vendor.json needs files: [{ path, load }].`);
      }
      const names = new Set();
      const read = manifest.files.map((entry, index) => {
        const at = `${where}/vendor.json files[${index}]`;
        if (typeof entry?.path !== "string" || !VENDOR_LOADS.has(entry.load)) {
          fail(`${at} must be { path, load: ${[...VENDOR_LOADS].join(" | ")} }.`);
        }
        if (!VENDOR_PATH.test(entry.path) || entry.path === VENDOR_INIT_PATH) {
          fail(
            `${at}: path ${JSON.stringify(entry.path)} must be plain segments (letters, digits, ".", "_", "-") and not ${VENDOR_INIT_PATH}.`,
          );
        }
        const file = NodePath.resolve(root, entry.path);
        if (!file.startsWith(root + NodePath.sep) || !NodeFS.existsSync(file)) {
          fail(`${at}: ${manifest.package} has no file ${entry.path}.`);
        }
        const fileName = NodePath.basename(file);
        if (names.has(fileName)) fail(`${at}: two files are named ${fileName}.`);
        names.add(fileName);
        return {
          at,
          name: fileName,
          path: entry.path,
          load: entry.load,
          bytes: NodeFS.readFileSync(file),
        };
      });
      const modulePaths = new Set(
        read.filter((file) => file.load === "module").map((file) => file.path),
      );
      const files = read.map((file) => {
        if (file.load === "module") {
          checkVendorModuleImports(file.bytes.toString("utf8"), file.path, modulePaths, file.at);
        }
        return {
          name: file.name,
          path: file.path,
          load: file.load,
          content: file.bytes.toString(file.load === "bytes" ? "base64" : "utf8"),
        };
      });
      const init = NodeFS.readFileSync(initPath, "utf8");
      readDocsHeader(init, `${where}/init.js`);
      if (!init.includes(`t3kit.vendor.define(${JSON.stringify(name)}`)) {
        fail(`${where}/init.js must call t3kit.vendor.define(${JSON.stringify(name)}, init).`);
      }
      return {
        name,
        package: manifest.package,
        version: manifest.version,
        license: manifest.license,
        hash: vendorHash(manifest, read, init),
        files,
        init,
      };
    });
  return { vendorRuntime, vendor };
}

/**
 * Checks one option's spec where T3 reads it (type, enum, range, items,
 * properties, required; see TemplateOptionSpec) and returns it unchanged.
 * Keys T3 does not read pass through verbatim, so agents see the whole spec.
 */
function checkOptionSpec(spec, where) {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    fail(`${where} must be an object.`);
  }
  for (const alias of ["min", "max"]) {
    if (alias in spec) fail(`${where}.${alias} is not JSON Schema; write ${alias}imum.`);
  }
  if (spec.type !== undefined) {
    const types = Array.isArray(spec.type) ? spec.type : [spec.type];
    if (types.length === 0 || !types.every((type) => OPTION_TYPES.has(type))) {
      fail(`${where}.type must be one of ${[...OPTION_TYPES].join(", ")}, or a list of them.`);
    }
  }
  if (spec.enum !== undefined && !Array.isArray(spec.enum)) fail(`${where}.enum must be an array.`);
  for (const key of ["minimum", "maximum"]) {
    if (spec[key] !== undefined && typeof spec[key] !== "number")
      fail(`${where}.${key} must be a number.`);
  }
  if (spec.items !== undefined) checkOptionSpec(spec.items, `${where}.items`);
  if (spec.properties !== undefined) {
    if (
      spec.properties === null ||
      typeof spec.properties !== "object" ||
      Array.isArray(spec.properties)
    ) {
      fail(`${where}.properties must be an object.`);
    }
    for (const [key, property] of Object.entries(spec.properties)) {
      checkOptionSpec(property, `${where}.properties.${key}`);
    }
  }
  if (spec.required !== undefined) {
    if (!Array.isArray(spec.required) || !spec.required.every((key) => typeof key === "string")) {
      fail(`${where}.required must be an array of property names.`);
    }
    for (const key of spec.required) {
      if (spec.properties === undefined || !(key in spec.properties)) {
        fail(`${where}.required names "${key}", which is not in its properties.`);
      }
    }
  }
  return spec;
}

const isStringList = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "");

/**
 * Checks a template's bolt-on docs (TemplateBoltOn): what agents read before
 * writing options.customScript, so every field must be there and well typed.
 */
function checkBoltOn(boltOn, where) {
  if (boltOn === null || typeof boltOn !== "object" || Array.isArray(boltOn)) {
    fail(`${where} needs a boltOn object (summary, api, reservedShortcuts, example).`);
  }
  for (const key of ["summary", "example"]) {
    if (typeof boltOn[key] !== "string" || boltOn[key].trim() === "") {
      fail(`${where}.${key} must be a non-empty string.`);
    }
  }
  if (!isStringList(boltOn.api) || boltOn.api.length === 0) {
    fail(`${where}.api must be a non-empty array of strings, one per call.`);
  }
  if (!isStringList(boltOn.reservedShortcuts)) {
    fail(`${where}.reservedShortcuts must be an array of shortcut strings.`);
  }
  return boltOn;
}

function readTemplates(kitDir, primitiveNames, vendorNames) {
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
      const vendor = manifest.vendor ?? [];
      if (!Array.isArray(vendor)) fail(`${where}/template.json vendor must be an array.`);
      for (const name of vendor) {
        if (!vendorNames.has(name)) fail(`${where}/template.json vendor names unknown "${name}".`);
      }
      const options = manifest.options ?? {};
      if (options === null || typeof options !== "object" || Array.isArray(options)) {
        fail(`${where}/template.json options must be an object.`);
      }
      for (const [key, spec] of Object.entries(options)) {
        checkOptionSpec(spec, `${where}/template.json options.${key}`);
      }
      const examples = manifest.examples ?? [];
      if (!Array.isArray(examples)) fail(`${where}/template.json examples must be an array.`);
      examples.forEach((example, index) => {
        const problems = validateTemplateOptions({ options }, example, `examples[${index}]`);
        if (problems.length > 0) fail(`${where}/template.json ${problems.join("; ")}.`);
      });
      if ("html" in manifest) fail(`${where}/template.json must not have an html key.`);
      checkBoltOn(manifest.boltOn, `${where}/template.json boltOn`);
      // true/false says whether the page projects its toolbar into T3's chrome;
      // an object is the seed manifest itself. T3 checks a manifest on publish.
      if (
        "chrome" in manifest &&
        typeof manifest.chrome !== "boolean" &&
        (manifest.chrome === null ||
          typeof manifest.chrome !== "object" ||
          Array.isArray(manifest.chrome))
      ) {
        fail(`${where}/template.json chrome must be true, false or a chrome manifest object.`);
      }
      // The manifest as written, so fields T3 does not read (bolt-on docs, notes) reach agents.
      return {
        ...manifest,
        kit,
        vendor,
        options,
        examples,
        html: NodeFS.readFileSync(htmlPath, "utf8"),
      };
    });
}

/**
 * Reads and checks a kit directory. Vendored packages resolve from
 * packageDir, the package that pins them (default: the kit's parent).
 */
export function readKit(kitDir, packageDir = NodePath.dirname(NodePath.resolve(kitDir))) {
  const { primitives, core } = readPrimitives(kitDir);
  const { vendorRuntime, vendor } = readVendor(kitDir, packageDir);
  const templates = readTemplates(
    kitDir,
    new Set(primitives.map((p) => p.name)),
    new Set(vendor.map((v) => v.name)),
  );
  return { core, vendorRuntime, vendor, primitives, templates };
}

/** The text of src/generated.ts for a kit. */
export function renderKitModule(kit) {
  return `// Generated; do not edit. Regenerate with
//   node packages/workspace-kit/scripts/generate.mjs   (sources: packages/workspace-kit/kit)
import type { KitSource } from "./types.ts";

export const GENERATED_KIT: KitSource = ${JSON.stringify(kit, null, 2)};
`;
}

function main() {
  // The kit sources live in packages/workspace-kit/kit; another directory can be passed while developing.
  const kitDir = process.argv[2]
    ? NodePath.resolve(process.argv[2])
    : NodeURL.fileURLToPath(new URL("../kit", import.meta.url));
  const kit = readKit(kitDir, NodePath.resolve(here, ".."));
  NodeFS.writeFileSync(outFile, renderKitModule(kit));
  console.log(
    JSON.stringify({
      out: outFile,
      core: kit.core !== null,
      vendor: kit.vendor.map((v) => `${v.package}@${v.version}`),
      primitives: kit.primitives.map((p) => p.name),
      templates: kit.templates.map((t) => t.id),
    }),
  );
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  main();
