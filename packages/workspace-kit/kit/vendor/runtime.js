/**
 * t3kit.vendor: third-party libraries a template names in template.json "vendor", loaded from the page itself.
 * The page is sandboxed with no network, so T3 inlines everything before the primitives: this registry, then per
 * library its files (classic scripts, ES modules, binary files as base64) and the kit's init.js for it.
 *
 * t3kit.vendor.load(name) -> Promise<api>   runs the library's init once, after its ES modules have run, and
 *   resolves to what init returns (see vendor/<name>/init.js). Rejects when the library is not vendored into this
 *   page, one of its modules failed to run, or its init throws.
 * t3kit.vendor.names() -> string[]   the libraries vendored into this page.
 * t3kit.vendor.file(name, path) -> Promise<Blob>   one of the library's files as vendor.json lists it ("dist/x.wasm"),
 *   as the package ships it (a module without the hand-over epilogue), typed text/javascript or application/wasm.
 *   For code that runs the library elsewhere, such as a Worker. Rejects when the library or file is not vendored.
 * Library side (init.js and the generated module epilogue; templates do not call these):
 *   define(name, init({ exports, bytes }) -> api | Promise<api>)   exports: { [moduleFile]: { [name]: value } };
 *     bytes(file) -> Uint8Array decodes one of the library's binary files.
 *   ran(name, file, exports)   an ES module finished running and hands over its export list.
 * Example:
 *   const sqlite3 = await t3kit.vendor.load("sqlite-wasm");
 *   const db = new sqlite3.oo1.DB(":memory:");
 */
(function () {
  "use strict";
  const t3kit = (window.t3kit = window.t3kit || {});
  const inits = new Map(); // name -> init
  const ran = new Map(); // "name\0file" -> exports
  const loads = new Map(); // name -> Promise<api>

  const tags = (name, selector) =>
    [...document.querySelectorAll(`script${selector}[data-t3vendor]`)].filter(
      (el) => el.dataset.t3vendor === name,
    );

  // Inline module scripts run after parsing and before DOMContentLoaded, so by then every module has run or failed.
  const parsed = () =>
    document.readyState === "loading"
      ? new Promise((resolve) =>
          document.addEventListener("DOMContentLoaded", resolve, { once: true }),
        )
      : Promise.resolve();

  function bytes(name, file) {
    const el = tags(name, '[type="application/octet-stream"]').find(
      (tag) => tag.dataset.t3vendorFile === file,
    );
    if (!el) throw new Error(`t3kit.vendor: ${name} has no binary file "${file}"`);
    const text = atob(el.textContent.trim());
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  }

  // Inline delivery keys a file by its name, unique within a library (the generator enforces it).
  const TYPES = { js: "text/javascript", mjs: "text/javascript", wasm: "application/wasm" };
  async function file(name, path) {
    const base = String(path).split("/").pop();
    const el = tags(name, "").find(
      (tag) => tag.dataset.t3vendorFile === base && base !== "init.js",
    );
    if (!el) throw new Error(`t3kit.vendor.file: ${name} has no file "${path}"`);
    const type = TYPES[base.split(".").pop()] ?? "application/octet-stream";
    if (el.type === "application/octet-stream") return new Blob([bytes(name, base)], { type });
    const text = el.textContent;
    const epilogue = text.lastIndexOf("\n;t3kit.vendor.ran(");
    return new Blob([el.type === "module" && epilogue >= 0 ? text.slice(0, epilogue) : text], {
      type,
    });
  }

  async function start(name) {
    await parsed();
    const init = inits.get(name);
    if (!init) {
      throw new Error(
        `t3kit.vendor: "${name}" is not vendored into this page (vendored: ${[...inits.keys()].join(", ") || "none"})`,
      );
    }
    const exports = {};
    for (const el of tags(name, '[type="module"]')) {
      const file = el.dataset.t3vendorFile;
      const key = `${name}\0${file}`;
      if (!ran.has(key)) {
        throw new Error(`t3kit.vendor: ${name}/${file} did not run; see the error it raised`);
      }
      exports[file] = ran.get(key);
    }
    return init({ exports, bytes: (file) => bytes(name, file) });
  }

  t3kit.vendor = {
    load(name) {
      if (!loads.has(name)) loads.set(name, start(name));
      return loads.get(name);
    },
    names: () => [...inits.keys()],
    file,
    define(name, init) {
      if (typeof init !== "function")
        throw new TypeError(`t3kit.vendor.define(${name}): needs a function`);
      if (inits.has(name)) throw new Error(`t3kit.vendor.define: ${name} is already defined`);
      inits.set(name, init);
    },
    ran(name, file, exports) {
      ran.set(`${name}\0${file}`, exports);
    },
  };
})();
