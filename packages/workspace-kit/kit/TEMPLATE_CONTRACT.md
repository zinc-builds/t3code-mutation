# Workspace Template Contract

A template is a complete, pro-grade workspace (photo develop, video edit…) composed from kit primitives (`KIT_CONTRACT.md`, `primitives/*.js`). To mutate, an agent picks a template and passes a small options object. It writes no HTML, so the mutation takes seconds. When the user wants something the template lacks, the agent bolts it on with a short `customScript` instead of rebuilding the app.

## Files

- `templates/<id>/template.html`: the whole workspace page. Kit primitives are NOT inlined. T3 (and `tools/assemble.mjs` for testing) injects the primitives listed in `template.json` before the page's own scripts, along with the theme and the `window.t3.workspace` bridge.
- `templates/<id>/template.json`:
  ```json
  {
    "id": "photo-develop",
    "title": "Photo Develop",
    "summary": "One line for the agent's catalog: when to pick this template.",
    "kit": ["develop", "histogram", "curves", "viewer", "history"],
    "options": {
      "title": { "type": "string", "default": "Develop", "description": "Header title." },
      "look": {
        "type": "string",
        "enum": ["neutral", "moody", "film", "vivid"],
        "default": "neutral",
        "description": "Starting look applied on load."
      }
    },
    "examples": [{ "title": "Moody edit", "look": "moody" }]
  }
  ```
  Keep `options` small (≤12 keys), flat where possible, every key with a `default` and a one-line `description`. Values are JSON. T3 checks `type` (`string`, `number`, `integer`, `boolean`, `array`, `object`, `null`, or a list such as `["string", "null"]` for a nullable key; a `default` must match it), `enum`, `minimum`/`maximum`, `items`, `properties` and `required`.
- `"vendor": ["sqlite-wasm"]` in `template.json`: third-party libraries the page needs (`KIT_CONTRACT.md`, Vendored Libraries). T3 injects them before the primitives; the page gets one with `await t3kit.vendor.load("sqlite-wasm")` during boot, and reports a rejection like any other boot failure. Each adds its size to the page (sqlite-wasm about 1.8 MB), so name only what the page uses.
- `"chrome": true | false` in `template.json`: whether the page can project its toolbar (and sidebar) into T3's native chrome. For `true`, T3 opens a chrome session for the workspace (any valid seed manifest; the page replaces its regions on load); for `false`, or when T3 opens none, the page keeps its own toolbar.

## Runtime

- Options arrive in `<script id="t3-template-options" type="application/json">{…}</script>`. Read it with `JSON.parse(document.getElementById('t3-template-options')?.textContent || '{}')`, merge over the defaults, and validate leniently (unknown keys ignored, bad values fall back to the default and log a warning).
- Media comes from `await t3.workspace.ready()` (`assets[]` with `file`, `url`, `name`, `mimeType`, `path`). Pick the first suitable asset by mime type, and handle multiple.
- Persist control values with `t3.workspace.setState({v:1, …})`, and restore them from `ready().state` / `initialState()` (merged over defaults, so older shapes still load).
- Bolt-ons go through the shared runtime, never a hand-rolled `window.t3template`: list `template-runtime` in `kit`, create it with `t3kit.templateRuntime.create({ id, pipeline: 'image'|'edl'|'data', addPanel, toolbar, getValues, setValues, export, ... })` (header of `primitives/template-runtime.js`), then:
  - `addPanel(title, { open, position })`: `'top'` puts a bolt-on panel first in the inspector (below a pure readout such as a histogram, in creation order) so it is in view on load; `'bottom'` after the template's own panels. `export()` returns the Export button's promise and throws on failure, so `t3template.export()` and `snap.mjs --eval` can drive it.
  - data templates (`pipeline: 'data'`: tables and charts, no picture or timeline) have no media hooks; bolt-ons use controls, panels, toolbar buttons and presets, and `verify.mjs` assembles them with `trips.csv`;
  - image templates call `rt.runImageStages(canvas, { scale, phase, info })` after their develop on the preview and on the full-resolution export (`scale` = canvas width / preview width; `info` adds template context such as the crop). A template whose output is a crop or resize also declares `stageTargets: ['image', 'output']` and runs `{ at: 'output' }` stages on every finished output and its preview;
  - EDL templates build exports through `rt.transformEdl(edl, { phase, info })`, chain `rt.exportFilters(edl, { phase, info })` ffmpeg fragments onto the render, and pass `info` (the selection, playhead...) to hooks. Picture templates also pass `previewTarget` (the monitor wrapper: CSS filter + overlay host) and `frame()`, call `rt.setPreviewTime(time, info)` on every frame, draw `rt.drawOverlays(canvas, time)` on stills, and composite `rt.renderOverlays()` PNGs in the render;
  - persist `rt.state()` (control values) with `setState` as `controls` and pass it back to `rt.publish({ instances, extras, saved })`;
  - link history with `rt.linkHistory(history, getState, applyState, { sources, idleMs, thumb, commit? })` (same options as `t3kit.links.historyState`, which it returns): every step then also holds the bolt-on control values, a control edit is one coalesced step (a drag, a typing burst, one toggle), and undo, redo, jump and presets restore controls with the template state. `commit(label)` overrides how a control step is pushed (e.g. flush a pending preview first);
  - EDL templates with sound pass `audioPreview: () => [instances with setAudioChain(build)]` (`t3kit.waveform`, `t3kit.player`), so `t3template.addAudioFilter` is heard live through Web Audio; the same filter descriptions become ffmpeg filters in `rt.exportFilters(...).audio`, in the order added among the export notes;
  - `config.export()` resolves to the delivered files: a `File`, `File[]` or `{ files, ffmpeg }`, where EDL templates must include `ffmpeg: [command]`. `t3template.export()` then resolves to `{ files: [{ name, type, size, width?, height? }], ffmpeg? }` (width and height for images), which T3's publish-time validation can check;
  - native chrome (`"chrome": true`): pass `chrome: { toolbar() -> items, sidebar?() -> sections, native(on) }` where items and sections are T3 chrome manifest entries plus `run(value?)`. `rt.publish` offers them to `t3.workspace.setChrome`; when T3 accepts, `native(true)` hides the page's own counterparts (same actions, ids mapped both ways: T3 `command` events call `run`, the page's state flows back as `values`), and bolt-on toolbar buttons follow as `bolt.N`. Call `rt.syncChrome()` after state a chrome entry shows changes (view mode, history, presets). When `setChrome` is missing or rejects, nothing changes: the in-page UI is the fallback;
  - report errors with `rt.reportError(err)` (console.error plus the shared dismissible banner);
  - run `options.customScript` last, once the media is loaded and the first preview rendered, with `rt.runCustomScript(code, options)`. Pass `options.controls` through: it seeds control values.
- `template.json` carries a `boltOn` section: `summary`, `api` (one line per call, with this template's values shape, buffer sizes and where panels land), `reservedShortcuts` and one runnable `example` customScript. Agents read only this, so keep it exact and test the example. Options include `customScript` and `controls`.
- Export: an Export action that uses the primitive's full-res export, then `t3.workspace.attach(file)` (send to chat) and `t3.workspace.download(file, name)`.
- Mark the composer slot with `data-t3-composer` (bottom of the right inspector, ≥320px wide).
- Theme vars only, dense pro layout, keyboard shortcuts, no idle animation loops. It must look and feel like a shipping pro app.

## Verifying

```
node tools/verify.mjs [templateId ...]          # defaults, examples, boltOn.example + export result, undo (+ audio), chrome
node tools/assemble.mjs templates/<id>/template.html run.html "" sonoma.jpg options.json --script custom.js
node tools/snap.mjs run.html shot.png 4000 --scroll "text=Glow" --eval "await t3template.export()"
node tools/serve.mjs                             # http://127.0.0.1:4173/ for the in-app browser (no file://)
```

- `assemble.mjs` injects the libraries a template vendors from the T3 repo (`--t3 <repo>`, default `../../wt-r6`; `verify.mjs` passes its own `--t3` through), whose kit generator reads them from that repo's `packages/workspace-kit`.
- `assemble.mjs`: kit list `""` (read `template.json`), comma/space separated, or a JSON array. Assets are looked up as given (absolute or relative to the current directory), then in `kit/media/`; a missing one is an error. `--script` reads `customScript` from a plain JS file. The stub logs every download/attach as `{ name, type, size, width?, height?, text? }`.
- `assemble.mjs --chrome` makes the stub act as T3 with native chrome: `setChrome` resolves and logs, `window.__t3stub.chrome` holds the last patch, `window.__t3stub.command(id, value?)` sends a command. Without it `setChrome` rejects, as T3 does for a workspace without chrome.
- `verify.mjs` assembles each case with the pipeline's media (`sonoma.jpg`, `clip.mp4`, `trips.csv`), or with `"verifyAssets": "a.png,b.html"` from `template.json` when the template needs other media (design-review: `landing.png,landing.html`).
- `verify.mjs` cases: defaults and examples load clean; `bolt-on` runs the example and checks `t3template.export()` against the logged downloads (and `ffmpeg` for EDL); `undo` drags a bolt-on slider (one step, undo/redo, scripted `setValues`) and, for EDL, checks the `addAudioFilter` chain is live and in the export command; `chrome` (for `"chrome": true`) checks the manifest with T3's own validator (`--t3 <repo>`, default `../../wt-r6`), that the page hides its toolbar, and that an `export` command exports.
- `snap.mjs` steps run in order after the wait: `--wait-for`, `--scroll`, `--click` (CSS selector or `text=Label`), `--wait <ms>`, `--eval <js>` (value printed under `steps`). It exits 1 on any console error or failed step and still writes the screenshot.
- Every case must be free of console errors (exit 0) and the bolt-on export must log a download. Read the screenshots.
