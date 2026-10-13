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
