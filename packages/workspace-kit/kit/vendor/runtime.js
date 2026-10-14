/**
 * t3kit.vendor: third-party libraries a template names in template.json "vendor", loaded from T3's vendor route.
 * T3 serves each library's files at one versioned, content-hashed URL and puts only this registry and a manifest
 * (#t3kit-vendor: { [name]: { url, files: [{ name, path, load, type }] } }) in the page. The url is root-relative and
 * resolves against the page's own URL, so a stored page loads its libraries from whichever origin serves it.
 *
 * t3kit.vendor.load(name) -> Promise<api>   loads the library once: its classic scripts in order, its init.js, its
 *   ES modules, and its binary files, then resolves to what its init returns (see vendor/<name>/init.js). Rejects
 *   when the library is not vendored into this page, a file fails to load or run, or its init throws.
 * t3kit.vendor.file(name, path) -> Promise<Blob>   one of the library's raw files, by its path in the package as
 *   vendor.json lists it (such as "dist/sqlite3.wasm"), typed with its content type; for a module Worker, use
 *   URL.createObjectURL(blob).
 * t3kit.vendor.names() -> string[]   the libraries vendored into this page.
 * Library side (init.js; templates do not call this):
 *   define(name, init({ exports, bytes }) -> api | Promise<api>)   exports: { [moduleFile]: module namespace };
 *     bytes(file) -> Uint8Array, one of the library's binary files, fetched before init runs.
 * Example:
 *   const sqlite3 = await t3kit.vendor.load("sqlite-wasm");
 *   const db = new sqlite3.oo1.DB(":memory:");
 */
(function () {
  "use strict";
  const t3kit = (window.t3kit = window.t3kit || {});
  const manifestTag = document.getElementById("t3kit-vendor");
  if (!manifestTag) throw new Error("t3kit.vendor: the page has no #t3kit-vendor manifest");
  const libraries = JSON.parse(manifestTag.textContent);
  const inits = new Map(); // name -> init
  const loads = new Map(); // name -> Promise<api>
  const blobs = new Map(); // "name\0file" -> Promise<Blob>

  function library(name) {
    const entry = libraries[name];
    if (!entry) {
      const vendored = Object.keys(libraries).join(", ") || "none";
      throw new Error(
        `t3kit.vendor: "${name}" is not vendored into this page (vendored: ${vendored})`,
      );
    }
    return entry;
  }

  // location.href, not document.baseURI: a page's <base> must not move T3's route.
  const urlOf = (name, path) => new URL(path, new URL(library(name).url, location.href)).href;

  function fetchBlob(name, file) {
    const key = `${name}\0${file.path}`;
    if (!blobs.has(key)) {
      const url = urlOf(name, file.path);
      const blob = fetch(url).then(
        (response) => {
          if (!response.ok) {
            throw new Error(
              `t3kit.vendor: ${name}/${file.path} could not be loaded (HTTP ${response.status})`,
            );
          }
          return response.blob();
        },
        (error) => {
          throw new Error(
            `t3kit.vendor: ${name}/${file.path} could not be fetched from ${url}: ${error.message}`,
          );
        },
      );
      blobs.set(key, blob);
    }
    return blobs.get(key);
  }

  function runScript(name, path) {
    const url = urlOf(name, path);
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = url;
      // CORS mode, so an error the library throws reaches the page with its message.
      el.crossOrigin = "anonymous";
      el.dataset.t3vendor = name;
      el.dataset.t3vendorFile = path;
      el.addEventListener("load", () => resolve(), { once: true });
      el.addEventListener(
        "error",
        () => reject(new Error(`t3kit.vendor: ${name}/${path} did not load from ${url}`)),
        { once: true },
      );
      document.head.append(el);
    });
  }

  async function runCode(name, files) {
    for (const file of files.filter((f) => f.load === "script")) await runScript(name, file.path);
    await runScript(name, "init.js");
    if (!inits.has(name)) {
      throw new Error(
        `t3kit.vendor: ${name}/init.js did not call t3kit.vendor.define("${name}", init)`,
      );
    }
    const exports = {};
    for (const file of files.filter((f) => f.load === "module")) {
      const url = urlOf(name, file.path);
      exports[file.name] = await import(url).catch((error) => {
        throw new Error(`t3kit.vendor: ${name}/${file.path} did not run: ${error.message}`);
      });
    }
    return exports;
  }

  async function start(name) {
    const { files } = library(name);
    // Binary files download while the code loads; Promise.all observes every rejection.
    const binary = Promise.all(
      files
        .filter((f) => f.load === "bytes")
        .map((file) =>
          fetchBlob(name, file)
            .then((blob) => blob.arrayBuffer())
            .then((buffer) => [file.name, new Uint8Array(buffer)]),
        ),
    );
    const [entries, exports] = await Promise.all([binary, runCode(name, files)]);
    const bytes = new Map(entries);
    return inits.get(name)({
      exports,
      bytes(file) {
        if (!bytes.has(file)) throw new Error(`t3kit.vendor: ${name} has no binary file "${file}"`);
        return bytes.get(file);
      },
    });
  }

  t3kit.vendor = {
    load(name) {
      if (!loads.has(name)) loads.set(name, start(name));
      return loads.get(name);
    },
    async file(name, path) {
      const file = library(name).files.find((f) => f.path === path);
      if (!file) {
        const paths = library(name)
          .files.map((f) => f.path)
          .join(", ");
        throw new Error(`t3kit.vendor: ${name} has no file "${path}" (files: ${paths})`);
      }
      const blob = await fetchBlob(name, file);
      return new Blob([blob], { type: file.type });
    },
    names: () => Object.keys(libraries),
    define(name, init) {
      if (typeof init !== "function")
        throw new TypeError(`t3kit.vendor.define(${name}): needs a function`);
      library(name);
      if (inits.has(name)) throw new Error(`t3kit.vendor.define: ${name} is already defined`);
      inits.set(name, init);
    },
  };
})();
