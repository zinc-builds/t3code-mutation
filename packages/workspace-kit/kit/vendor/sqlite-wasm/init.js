/**
 * sqlite-wasm: the official SQLite build (@sqlite.org/sqlite-wasm), in memory on the page's main thread.
 * t3kit.vendor.load("sqlite-wasm") -> Promise<sqlite3>: the library's namespace, initialised once per page.
 *   sqlite3.oo1.DB(":memory:")   a database (exec, prepare, selectValue, changes, close).
 *   sqlite3.capi                 the C API (sqlite3_deserialize, sqlite3_js_db_export, sqlite3_error_offset).
 *   sqlite3.wasm                 heap helpers (allocFromTypedArray for sqlite3_deserialize).
 * A page that runs SQLite in a Worker (sql-workbench) takes the same files from t3kit.vendor.file and these settings.
 * The page is a sandboxed opaque origin with no network and no storage, so:
 *   - the wasm comes from the page itself (bytes("sqlite3.wasm")) through instantiateWasm, never a URL;
 *   - the kvvfs VFS (localStorage, which throws here) and the OPFS VFSes (workers, origin storage) are disabled.
 * Example:
 *   const sqlite3 = await t3kit.vendor.load("sqlite-wasm");
 *   const db = new sqlite3.oo1.DB(":memory:");
 *   db.exec({ sql: "select sqlite_version() as v", rowMode: "object", returnValue: "resultRows" });
 */
t3kit.vendor.define("sqlite-wasm", ({ exports, bytes }) => {
  const wasm = bytes("sqlite3.wasm");
  globalThis.sqlite3ApiConfig = {
    disable: {
      vfs: { kvvfs: true, opfs: true, "opfs-vfs": true, "opfs-sahpool": true, "opfs-wl": true },
    },
  };
  // Emscripten never hears about a failed instantiation through instantiateWasm, so it rejects the race instead.
  let failed;
  const instantiationFailed = new Promise((resolve, reject) => {
    failed = reject;
  });
  const ready = exports["index.mjs"].default({
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(wasm, imports).then((r) => done(r.instance, r.module), failed);
      return {};
    },
  });
  return Promise.race([ready, instantiationFailed]);
});
