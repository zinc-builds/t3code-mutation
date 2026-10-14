# Workspace Kit Contract

The kit is a library of pro-grade UI primitives that T3 Code injects into agent-built "mutation workspaces". An agent asks for the primitives it needs, then writes only glue code, so a workspace (photo editor, video editor…) appears in seconds instead of minutes. Every primitive MUST follow this contract exactly.

## Runtime Environment

- Runs inside a sandboxed, opaque-origin iframe (`sandbox="allow-scripts allow-forms"`): no localStorage/sessionStorage/IndexedDB/cookies, no alert/confirm/prompt, no window.open, no `<a download>`, no clipboard. Don't touch them, even defensively.
- No network assumptions: no CDN imports. Self-contained vanilla JS (ES2022), no build step, no dependencies.
- Media arrives as `File`/`Blob` objects and `blob:` URLs (from `t3.workspace.assets()`), so canvases are never tainted.
- Theme: T3 injects CSS custom properties on `:root` that change live between dark and light: `--background --foreground --muted --muted-foreground --card --card-foreground --popover --border --input --ring --primary --primary-foreground --accent --accent-foreground --destructive --warning --success --info --chart-1…--chart-6 --radius --font-sans --font-mono`. Use ONLY these for colour, radius and font (`var(--border)`, never hex). For canvas drawing, read them with `getComputedStyle(document.documentElement)` at draw time, and redraw when `document.documentElement` style or `#t3-theme` changes. The kit gives you `t3kit.theme.onChange(cb)` for this; see Shared Helpers.
- Performance: render on demand. No idle `requestAnimationFrame` loops, no continuous CSS animations. Debounce expensive work. 24MP photos and 4K video must stay responsive (use downscaled previews and full-res only on export).

## Module Shape

- One file: `primitives/<name>.js`, a classic script (not an ES module) that registers itself:
  ```js
  (function () {
    const t3kit = (window.t3kit = window.t3kit || {});
    t3kit.<name> = { create(container, options) { /* … */ return instance; } };
  })();
  ```
- `create(container, options)` renders into `container` (an HTMLElement the page owns and sizes). Fill it responsively and observe its size with ResizeObserver.
- The instance has at least:
  - `get()`: the current value/state (plain JSON-serialisable object).
  - `set(partial)`: apply values programmatically. This does NOT emit `change`.
  - `on(event, cb) → unsubscribe`: always supports `'change'` (user-driven value changes, payload = `get()`), plus primitive-specific events documented in the header.
  - `destroy()`: remove DOM and listeners.
  - Anything primitive-specific (e.g. `setImage(blobOrUrl)`, `exportBlob({type, quality})`), documented in the header.
- Styling: inject one `<style data-t3kit="<name>">` on first create. Prefix all classes `t3k-<name>-`. Never style global selectors.
- Accessibility: real buttons/inputs where controls exist; keyboard support for core interactions.

## Docs Header (Agents Read Only This)

The file MUST start with a JSDoc block of at most 40 lines: one-line purpose, `create` options, instance methods, events, and a 3–6 line usage example. Keep it compact and exact; it is pasted into an agent's context.

## Demo

`demos/<name>.html`: a standalone page that loads `../tools/theme.css` (via `<link rel=stylesheet>`) and `../primitives/<name>.js` (via `<script src>`), then exercises the primitive with media from `../media/` (`sonoma.jpg`, `photo.jpg`, `horizon.jpg`, `clip.mp4`, `trips.csv`). Load media with `fetch()` into a Blob and create a `blob:` URL, as a workspace would. The demo must render something meaningful within 2 seconds with no console errors.

## Verifying

`node ../tools/snap.mjs <demo.html> <out.png> [waitMs]` runs headless Chrome and prints console errors/warnings as JSON plus the screenshot path. Use it and look at the screenshot (read the PNG). A candidate with console errors or a blank render loses. Optional steps after the wait (`--wait-for`, `--scroll`, `--click`, `--wait`, `--eval`) reach state below the fold or behind a click; see the snap.mjs header. `node tools/serve.mjs` serves the kit over http for the in-app browser, which cannot open file:// pages.

- snap also runs `tools/lint.mjs` on the page and every local script it loads, and fails on findings. Run it alone with `node tools/lint.mjs <file.js|page.html>`: it flags CSS variables outside the token list above (primitive-local `--t3k-<name>-*` is allowed, also when the primitive is inlined into a page; T3's injected `<style id="t3-theme">` is not linted), self-rescheduling `requestAnimationFrame` loops without a stop condition, storage and dialog APIs, pointermove handlers that draw directly, and headers over 40 lines.
- WebGL primitives must pass `node tools/snap.mjs tools/webgl-orientation.html out.png 4000` (screen, readback and export all upright against an `<img>` decode).
- Pointer drags update state and draw at most once per animation frame (keep the newest pointer position, flush it on release).
- `primitives/links.js` (`t3kit.links`) holds the cross-primitive wiring (player and timeline, develop with histogram and curves, history). Prefer extending it over asking agents to hand-sync primitives.

## Shared Helpers (Optional)

`primitives/_core.js` (if present) provides `t3kit.theme.get(name)`, `t3kit.theme.onChange(cb)`, `t3kit.emitter()`, and `t3kit.loadImage(blobOrUrl)`. Primitives may depend on it only if it exists when the kit is assembled. To stay independent, each primitive should inline the small helpers it needs.

## Vendored Libraries

When a workspace needs a real engine (SQLite, a video editor core), the kit vendors a third-party library instead of rewriting it. The first is `sqlite-wasm`; read `vendor/runtime.js` and `vendor/sqlite-wasm/init.js` for the shape.

- Source: an npm package pinned to an exact version published at least 14 days earlier (check `npm view <pkg> time --json`), added to `packages/workspace-kit` with `vp add -D -E <pkg>@<version>`. The generator refuses a range, or an installed version that differs from the pin.
- `vendor/<name>/vendor.json`: `{ "package", "version", "license", "files": [{ "path", "load" }] }`. `path` is inside the package, in plain segments, and file base names are unique within the library. `load` is `script` (a classic script, run in order first), `module` (an ES module, imported; it may import the library's other `module` files by relative path, and nothing else) or `bytes` (binary such as wasm, fetched for the init, never executed). List only what the page uses.
- `vendor/<name>/init.js`: a classic script with a docs header that calls `t3kit.vendor.define("<name>", ({ exports, bytes }) => api)`. `exports[file]` is a module's namespace and `bytes(file)` a binary file, both by base name, loaded before init runs. It is where the sandbox is handled, once: binaries reach the library through its init options (Emscripten's `instantiateWasm` or `wasmBinary`), and anything that needs storage, cookies or a same-origin URL is switched off.
- `vendor/runtime.js` is the `t3kit.vendor` registry. Pages call `await t3kit.vendor.load("<name>")`, which loads the library's files and runs its init once, and `await t3kit.vendor.file("<name>", "<path>")` for one raw file as a typed Blob (build a module Worker from it; a cross-origin URL cannot start one).
- A template names its libraries in `template.json` `"vendor": ["<name>"]`; T3 puts only the registry and a manifest of the libraries' URLs in those pages, before the primitives. T3 serves the files from `/api/workspace-vendor/<name>/<version>/<hash>/<path>` (and the init at `…/<hash>/init.js`), immutable and readable from the page's opaque origin; the generator embeds them in `src/generated.ts`, so the server never reads `node_modules` at runtime. A library therefore costs its page nothing, but its files are a download on first load.
- Vendored files are third-party code: `tools/lint.mjs` skips them, but a page that loads them must still boot without console errors or warnings.
