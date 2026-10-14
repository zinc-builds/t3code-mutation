/**
 * t3kit.history: undo/redo stack, jumpable step list with thumbnails, and named presets. In memory; the caller persists.
 * create(container, options?) -> instance. The panel fills container (give it a height; 240-320px wide works well).
 *   options.state: initial JSON state (default null).   options.label: first step's label (default 'Original').
 *   options.thumb: first step's thumbnail (see push).   options.presets: [{ name, state }] to start with (default []).
 *   options.presetPlaceholder: preset name field hint (default 'Name this look').
 *   options.limit: max steps, oldest dropped first (default 200).   options.title: header text (default 'History').
 *   options.keys: mod+Z undo, shift+mod+Z or ctrl+Y redo (default true). Text fields keep native undo; sliders don't.
 *     With several keyed instances, the one last clicked or focused receives the keys.
 * Model (get(), set() and the change payload), plain JSON:
 *   { state, index, entries: [{ id, label, at, state, hasThumb }], presets: [{ name, state }] }
 *   state = entries[index].state (the active step). at = epoch ms. ids are stable strings ('e1', 'e2', ...).
 * Instance
 *   push(label, state, thumb?) -> id  commit a step after the active one and drop the redo tail. A state equal to the
 *                                     active one is a no-op (returns the active id, no event). thumb: Blob, ImageBitmap,
 *                                     canvas, OffscreenCanvas or <img>; downscaled off-thread, the source is not kept.
 *   undo() / redo() -> boolean        false at either end.   canUndo() / canRedo() -> boolean.
 *   jump(idOrIndex) -> boolean        activate a step by id or index; false if already active; throws if unknown.
 *   savePreset(name, state?) -> name  store state (default: the active one) under name; the same name overwrites.
 *   applyPreset(name) -> id           push the preset as an undoable 'Preset: <name>' step. Throws if unknown.
 *   deletePreset(name)                throws if unknown.
 *   get() -> model                    deep copy.
 *   set({ entries?, index?, presets?, state? })  silent restore (no change event); set(get()) round-trips.
 *                                     entries: [{ label, state, id?, at? }], index defaults to the last one.
 *                                     state overwrites the active step in place. Thumbnails survive for kept ids.
 *   on('change', cb) -> unsubscribe   cb(model, { action }) after push, undo, redo, jump, applyPreset, savePreset or
 *                                     deletePreset, whether called in code or from the UI/keys. action = method name.
 *   destroy()                         removes DOM, listeners, the observer and thumbnail bitmaps.
 * Performance: no timers or animation loops. Rows are keyed and reused; each thumbnail decodes once to a small bitmap.
 *   Keep states small (parameters, not pixels) and pass a downscaled preview canvas as thumb.
 * Example:
 *   const h = t3kit.history.create(el, { state: { exposure: 0 } });
 *   h.on('change', ({ state }, { action }) => { if (action !== 'push') render(state); t3.workspace.setState({ h: h.get() }); });
 *   slider.onchange = () => h.push(`Exposure ${slider.value}`, { exposure: +slider.value }, previewCanvas);
 *   h.savePreset('Bright', { exposure: 40 });  h.applyPreset('Bright');  h.undo();
 *   // later: h.set(saved.h) restores steps and presets without an event.
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});

  const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const MOD = MAC ? "⌘" : "Ctrl+";
  const SHIFT = MAC ? "⇧" : "Shift+";
  const TEXT_INPUT =
    /^(text|search|url|tel|email|password|number|date|datetime-local|month|time|week)$/;
  const THUMB_W = 36;
  const THUMB_H = 26;

  const CSS = `
.t3k-history-root{box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-radius:var(--radius);font:12px/1.4 var(--font-sans)}
.t3k-history-root *{box-sizing:border-box}
.t3k-history-bar{flex:none;display:flex;align-items:center;gap:6px;height:40px;padding:0 6px 0 12px;border-bottom:1px solid var(--border)}
.t3k-history-title{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600}
.t3k-history-count{margin-right:auto;font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground);font-variant-numeric:tabular-nums;white-space:nowrap}
.t3k-history-icon{appearance:none;display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:calc(var(--radius) - 4px);background:transparent;color:var(--foreground);cursor:pointer}
.t3k-history-icon:hover:not(:disabled){background:color-mix(in srgb,var(--foreground) 8%,transparent)}
.t3k-history-icon:disabled{opacity:.35;cursor:default}
.t3k-history-icon svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.t3k-history-root button:focus-visible,.t3k-history-input:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.t3k-history-steps{position:relative;flex:1 1 0;min-height:72px;margin:0;padding:4px 0;list-style:none;overflow:auto}
.t3k-history-step{appearance:none;display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:4px 10px 4px 8px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.t3k-history-step:hover{background:color-mix(in srgb,var(--foreground) 5%,transparent)}
.t3k-history-step[aria-current="step"]{background:color-mix(in srgb,var(--primary) 16%,transparent);box-shadow:inset 2px 0 0 var(--primary)}
.t3k-history-step.is-redo{color:var(--muted-foreground)}
.t3k-history-step.is-redo .t3k-history-label{font-style:italic}
.t3k-history-step.is-redo .t3k-history-thumb{opacity:.45}
.t3k-history-n{flex:none;width:18px;text-align:right;font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);font-variant-numeric:tabular-nums}
.t3k-history-thumb{flex:none;display:block;width:${THUMB_W}px;height:${THUMB_H}px;border:1px solid var(--border);border-radius:4px;background:var(--muted)}
.t3k-history-dot{flex:none;position:relative;width:${THUMB_W}px;height:${THUMB_H}px}
.t3k-history-dot::before{content:"";position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:var(--muted-foreground)}
.t3k-history-step[aria-current="step"] .t3k-history-dot::before{background:var(--primary)}
.t3k-history-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3k-history-time{flex:none;font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);font-variant-numeric:tabular-nums}
.t3k-history-presets{flex:0 1 auto;display:flex;flex-direction:column;gap:6px;max-height:45%;min-height:0;padding:10px 12px 12px;border-top:1px solid var(--border)}
.t3k-history-head{display:flex;align-items:baseline;justify-content:space-between;font-size:11px;font-weight:600;color:var(--muted-foreground)}
.t3k-history-save{flex:none;display:flex;gap:6px;margin:0}
.t3k-history-input{flex:1;min-width:0;height:28px;padding:0 8px;border:1px solid var(--input);border-radius:calc(var(--radius) - 4px);background:var(--background);color:var(--foreground);font:inherit}
.t3k-history-input::placeholder{color:var(--muted-foreground)}
.t3k-history-btn{appearance:none;flex:none;height:28px;padding:0 10px;border:1px solid transparent;border-radius:calc(var(--radius) - 4px);background:var(--primary);color:var(--primary-foreground);font:inherit;font-weight:500;cursor:pointer}
.t3k-history-btn:hover:not(:disabled){background:color-mix(in srgb,var(--primary) 88%,var(--foreground))}
.t3k-history-btn:disabled{background:transparent;border-color:var(--border);color:var(--muted-foreground);cursor:default}
.t3k-history-plist{display:flex;flex-direction:column;gap:2px;min-height:0;margin:0;padding:0;list-style:none;overflow:auto}
.t3k-history-prow{display:flex;align-items:center;gap:2px;border-radius:calc(var(--radius) - 4px)}
.t3k-history-prow:hover{background:color-mix(in srgb,var(--foreground) 5%,transparent)}
.t3k-history-apply{appearance:none;display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:28px;padding:0 8px;border:0;border-radius:inherit;background:transparent;color:var(--foreground);font:inherit;text-align:left;cursor:pointer}
.t3k-history-apply span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3k-history-apply::before{content:"";flex:none;width:6px;height:6px;border-radius:2px;background:var(--chart-2)}
.t3k-history-x{color:var(--muted-foreground)}
.t3k-history-x:hover:not(:disabled){color:var(--destructive)}
.t3k-history-x svg{width:13px;height:13px}
.t3k-history-empty{margin:0;color:var(--muted-foreground)}
.t3k-history-empty[hidden],.t3k-history-plist[hidden]{display:none}
.t3k-history-narrow .t3k-history-time,.t3k-history-narrow .t3k-history-n,.t3k-history-narrow .t3k-history-count{display:none}
`;

  const ICONS = {
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
  };

  // Keyboard routing shared by every keyed instance: the last one the user touched wins.
  const keyed = [];
  let keyOwner = null;

  function isTextEntry(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (node.isContentEditable || node.tagName === "TEXTAREA") return true;
    return node.tagName === "INPUT" && TEXT_INPUT.test(node.type);
  }

  function onDocumentKey(event) {
    if (!keyOwner || event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey))
      return;
    if (isTextEntry(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      if (event.shiftKey) keyOwner.redo();
      else keyOwner.undo();
    } else if (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      keyOwner.redo();
    }
  }

  function injectStyle() {
    if (document.querySelector('style[data-t3kit="history"]')) return;
    const style = document.createElement("style");
    style.dataset.t3kit = "history";
    style.textContent = CSS;
    document.head.append(style);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function iconButton(name, label, extraClass) {
    const b = el("button", extraClass ? `t3k-history-icon ${extraClass}` : "t3k-history-icon");
    b.type = "button";
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
    b.setAttribute("aria-label", label);
    b.title = label;
    return b;
  }

  function requireText(value, what) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(`history: ${what} must be a non-empty string`);
    }
    return value.trim();
  }

  function toJson(value, what) {
    const json = JSON.stringify(value);
    if (json === undefined)
      throw new TypeError(`history: ${what} must be JSON-serialisable (got ${typeof value})`);
    return json;
  }

  function checkThumb(src) {
    if (src == null) return null;
    const ok =
      src instanceof Blob ||
      src instanceof ImageBitmap ||
      src instanceof HTMLCanvasElement ||
      src instanceof HTMLImageElement ||
      (typeof OffscreenCanvas !== "undefined" && src instanceof OffscreenCanvas) ||
      (typeof VideoFrame !== "undefined" && src instanceof VideoFrame);
    if (!ok)
      throw new TypeError(
        "history: thumb must be a Blob, ImageBitmap, canvas, OffscreenCanvas or <img>",
      );
    return src;
  }

  function paintCover(canvas, bitmap) {
    const ctx = canvas.getContext("2d");
    const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }

  const formatTime = (at) =>
    new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function create(container, options = {}) {
    if (!(container instanceof HTMLElement))
      throw new TypeError("history.create: container must be an HTMLElement");
    const limit = options.limit ?? 200;
    const useKeys = options.keys ?? true;
    const title = options.title ?? "History";
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError("history: options.limit must be an integer >= 1");
    if (options.presets !== undefined && !Array.isArray(options.presets)) {
      throw new TypeError("history: options.presets must be an array of { name, state }");
    }
    injectStyle();

    let seq = 1;
    let destroyed = false;
    let entries = []; // { id, label, at, json, bitmap: ImageBitmap|null, pending: boolean }
    let index = 0;
    let presets = []; // { name, json }
    const listeners = new Set();
    const rows = new Map(); // entry id -> { li, btn, n, canvas|null }

    const nextId = () => `e${seq++}`;
    const reserveId = (id) => {
      const m = /(\d+)$/.exec(id);
      if (m) seq = Math.max(seq, Number(m[1]) + 1);
    };
    const assertLive = () => {
      if (destroyed) throw new Error("history: instance was destroyed");
    };
    const dpr = () => Math.max(1, Math.min(3, window.devicePixelRatio || 1));

    // ---- thumbnails: decode once into a small ImageBitmap, painted into a reused row canvas
    function release(entry) {
      if (entry.bitmap) entry.bitmap.close();
      entry.bitmap = null;
      entry.pending = false;
      entry.dead = true;
      rows.delete(entry.id);
    }

    function attachThumb(entry, src) {
      entry.pending = true;
      const resizeWidth = Math.round(THUMB_W * dpr() * 2);
      createImageBitmap(src, { resizeWidth, resizeQuality: "medium" }).then((bitmap) => {
        if (destroyed || entry.dead) {
          bitmap.close();
          return;
        }
        entry.pending = false;
        entry.bitmap = bitmap;
        const row = rows.get(entry.id);
        if (row) {
          rows.delete(entry.id); // rebuild the row so the dot becomes a canvas
          render();
        }
      });
    }

    // ---- model
    function model() {
      const all = entries.map((e) => ({
        id: e.id,
        label: e.label,
        at: e.at,
        state: JSON.parse(e.json),
        hasThumb: e.bitmap !== null || e.pending,
      }));
      return {
        state: all[index].state,
        index,
        entries: all,
        presets: presets.map((p) => ({ name: p.name, state: JSON.parse(p.json) })),
      };
    }

    function changed(action) {
      render();
      if (listeners.size === 0) return;
      const payload = model();
      for (const cb of [...listeners]) cb(payload, { action });
    }

    function commit(label, json, thumb, action) {
      if (entries[index].json === json) return entries[index].id;
      for (const dropped of entries.splice(index + 1)) release(dropped);
      const entry = {
        id: nextId(),
        label,
        at: Date.now(),
        json,
        bitmap: null,
        pending: false,
        dead: false,
      };
      entries.push(entry);
      if (thumb) attachThumb(entry, thumb);
      while (entries.length > limit) release(entries.shift());
      index = entries.length - 1;
      changed(action);
      return entry.id;
    }

    function move(to, action) {
      if (to === index) return false;
      index = to;
      changed(action);
      return true;
    }

    function findPreset(name) {
      const key = requireText(name, "preset name");
      const at = presets.findIndex((p) => p.name === key);
      if (at === -1) throw new Error(`history: unknown preset "${key}"`);
      return at;
    }

    const api = {
      get() {
        assertLive();
        return model();
      },

      set(partial) {
        assertLive();
        if (partial === null || typeof partial !== "object" || Array.isArray(partial)) {
          throw new TypeError("history.set: expects { entries?, index?, presets?, state? }");
        }
        for (const key of Object.keys(partial)) {
          if (!["entries", "index", "presets", "state"].includes(key)) {
            throw new TypeError(`history.set: unknown key "${key}"`);
          }
        }
        let nextEntries = entries;
        let nextIndex = index;
        let nextPresets = presets;
        let specs = null;
        let dropped = 0; // oldest entries cut by limit
        if (partial.entries !== undefined) {
          if (!Array.isArray(partial.entries) || partial.entries.length === 0) {
            throw new TypeError(
              "history.set: entries must be a non-empty array of { label, state }",
            );
          }
          const seen = new Set();
          specs = partial.entries.map((e, i) => {
            if (!e || typeof e !== "object")
              throw new TypeError(`history.set: entries[${i}] must be an object`);
            const id = e.id === undefined ? null : requireText(e.id, `entries[${i}].id`);
            if (id !== null && seen.has(id))
              throw new Error(`history.set: duplicate entry id "${id}"`);
            if (id !== null) seen.add(id);
            if (e.at !== undefined && !Number.isFinite(e.at))
              throw new TypeError(`history.set: entries[${i}].at must be epoch ms`);
            return {
              id,
              label: requireText(e.label, `entries[${i}].label`),
              at: e.at ?? Date.now(),
              json: toJson(e.state, `entries[${i}].state`),
            };
          });
          dropped = Math.max(0, specs.length - limit);
          specs = specs.slice(dropped);
          nextIndex = specs.length - 1;
        }
        const length = specs ? specs.length : entries.length;
        if (partial.index !== undefined) nextIndex = partial.index - dropped;
        if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= length) {
          throw new RangeError(`history.set: index ${nextIndex} is outside 0..${length - 1}`);
        }
        if (partial.presets !== undefined) {
          if (!Array.isArray(partial.presets))
            throw new TypeError("history.set: presets must be an array of { name, state }");
          const names = new Set();
          nextPresets = partial.presets.map((p, i) => {
            const name = requireText(p && p.name, `presets[${i}].name`);
            if (names.has(name)) throw new Error(`history.set: duplicate preset name "${name}"`);
            names.add(name);
            return { name, json: toJson(p.state, `presets[${i}].state`) };
          });
        }
        const stateJson = partial.state !== undefined ? toJson(partial.state, "set state") : null;
        // Validated: apply. Entries whose id survives keep their record (and so their thumbnail).
        if (specs) {
          const old = new Map(entries.map((e) => [e.id, e]));
          for (const sp of specs) if (sp.id !== null) reserveId(sp.id);
          nextEntries = specs.map((sp) => {
            const prev = sp.id !== null ? old.get(sp.id) : undefined;
            if (prev) {
              old.delete(sp.id);
              return Object.assign(prev, { label: sp.label, at: sp.at, json: sp.json });
            }
            return {
              id: sp.id ?? nextId(),
              label: sp.label,
              at: sp.at,
              json: sp.json,
              bitmap: null,
              pending: false,
              dead: false,
            };
          });
          for (const gone of old.values()) release(gone);
          rows.clear();
        }
        entries = nextEntries;
        index = nextIndex;
        presets = nextPresets;
        if (stateJson !== null) entries[index].json = stateJson;
        render();
      },

      push(label, state, thumb) {
        assertLive();
        return commit(
          requireText(label, "push label"),
          toJson(state, "push state"),
          checkThumb(thumb),
          "push",
        );
      },

      undo() {
        assertLive();
        return index > 0 ? move(index - 1, "undo") : false;
      },

      redo() {
        assertLive();
        return index < entries.length - 1 ? move(index + 1, "redo") : false;
      },

      canUndo: () => index > 0,
      canRedo: () => index < entries.length - 1,

      jump(idOrIndex) {
        assertLive();
        let to;
        if (Number.isInteger(idOrIndex))
          to = idOrIndex >= 0 && idOrIndex < entries.length ? idOrIndex : -1;
        else to = entries.findIndex((e) => e.id === idOrIndex);
        if (to === -1) throw new RangeError(`history.jump: no step ${JSON.stringify(idOrIndex)}`);
        return move(to, "jump");
      },

      savePreset(name, state) {
        assertLive();
        const key = requireText(name, "preset name");
        const json = state === undefined ? entries[index].json : toJson(state, "preset state");
        const at = presets.findIndex((p) => p.name === key);
        if (at >= 0) presets[at] = { name: key, json };
        else presets.push({ name: key, json });
        changed("savePreset");
        return key;
      },

      applyPreset(name) {
        assertLive();
        const preset = presets[findPreset(name)];
        return commit(`Preset: ${preset.name}`, preset.json, null, "applyPreset");
      },

      deletePreset(name) {
        assertLive();
        presets.splice(findPreset(name), 1);
        changed("deletePreset");
      },

      on(event, cb) {
        assertLive();
        if (event !== "change")
          throw new Error(`history.on: unknown event "${event}" (only 'change')`);
        if (typeof cb !== "function")
          throw new TypeError("history.on: callback must be a function");
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },

      destroy() {
        if (destroyed) return;
        destroyed = true;
        observer.disconnect();
        if (useKeys) {
          keyed.splice(keyed.indexOf(api), 1);
          if (keyOwner === api) keyOwner = keyed[keyed.length - 1] ?? null;
          if (keyed.length === 0) document.removeEventListener("keydown", onDocumentKey);
        }
        for (const e of entries) release(e);
        entries = [];
        presets = [];
        listeners.clear();
        rows.clear();
        root.remove();
      },
    };

    // ---- DOM
    const root = el("div", "t3k-history-root");
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", title || "History");

    const bar = el("div", "t3k-history-bar");
    const heading = el("h3", "t3k-history-title", title);
    heading.hidden = title === "";
    const count = el("span", "t3k-history-count");
    const undoBtn = iconButton("undo", `Undo (${MOD}Z)`);
    undoBtn.setAttribute("aria-keyshortcuts", "Meta+Z Control+Z");
    const redoBtn = iconButton("redo", `Redo (${MOD}${SHIFT}Z)`);
    redoBtn.setAttribute("aria-keyshortcuts", "Meta+Shift+Z Control+Shift+Z Control+Y");
    bar.append(heading, count, undoBtn, redoBtn);

    const stepsList = el("ol", "t3k-history-steps");
    stepsList.setAttribute("aria-label", "History steps");

    const presetBox = el("section", "t3k-history-presets");
    const presetHead = el("div", "t3k-history-head");
    const presetCount = el("span");
    presetHead.append(el("span", null, "Presets"), presetCount);
    const form = el("form", "t3k-history-save");
    const nameInput = el("input", "t3k-history-input");
    nameInput.type = "text";
    nameInput.placeholder = options.presetPlaceholder ?? "Name this look";
    nameInput.maxLength = 60;
    nameInput.setAttribute("aria-label", "Preset name");
    const saveBtn = el("button", "t3k-history-btn", "Save");
    saveBtn.type = "submit";
    saveBtn.title = "Save the active step as a preset (same name overwrites)";
    form.append(nameInput, saveBtn);
    const presetList = el("ul", "t3k-history-plist");
    presetList.setAttribute("aria-label", "Presets");
    const presetEmpty = el(
      "p",
      "t3k-history-empty",
      "Save the active step to reuse it in one click.",
    );
    presetBox.append(presetHead, form, presetList, presetEmpty);

    root.append(bar, stepsList, presetBox);

    function rowFor(entry) {
      let row = rows.get(entry.id);
      if (row) return row;
      const li = el("li");
      const btn = el("button", "t3k-history-step");
      btn.type = "button";
      btn.dataset.entryId = entry.id;
      btn.title = `${entry.label} · ${formatTime(entry.at)}`;
      const n = el("span", "t3k-history-n");
      let canvas = null;
      let visual;
      if (entry.bitmap) {
        canvas = el("canvas", "t3k-history-thumb");
        canvas.width = Math.round(THUMB_W * dpr());
        canvas.height = Math.round(THUMB_H * dpr());
        canvas.setAttribute("aria-hidden", "true");
        paintCover(canvas, entry.bitmap);
        visual = canvas;
      } else {
        visual = el("span", "t3k-history-dot");
      }
      btn.append(
        n,
        visual,
        el("span", "t3k-history-label", entry.label),
        el("span", "t3k-history-time", formatTime(entry.at)),
      );
      li.append(btn);
      row = { li, btn, n };
      rows.set(entry.id, row);
      return row;
    }

    function render() {
      if (destroyed) return;
      const focusedId = stepsList.contains(document.activeElement)
        ? document.activeElement.dataset.entryId
        : undefined;
      const lis = entries.map((entry, i) => {
        const row = rowFor(entry);
        row.n.textContent = String(i + 1);
        row.btn.classList.toggle("is-redo", i > index);
        if (i === index) row.btn.setAttribute("aria-current", "step");
        else row.btn.removeAttribute("aria-current");
        return row.li;
      });
      // replaceChildren only when the row set or order changed, so reused rows keep their painted canvases
      const current = stepsList.children;
      let same = current.length === lis.length;
      for (let i = 0; same && i < lis.length; i++) same = current[i] === lis[i];
      if (!same) stepsList.replaceChildren(...lis);
      if (focusedId !== undefined) rows.get(focusedId)?.btn.focus({ preventScroll: true });

      const active = rows.get(entries[index].id).li;
      const top = active.offsetTop;
      const bottom = top + active.offsetHeight;
      if (top < stepsList.scrollTop) stepsList.scrollTop = top - 4;
      else if (bottom > stepsList.scrollTop + stepsList.clientHeight)
        stepsList.scrollTop = bottom - stepsList.clientHeight + 4;

      undoBtn.disabled = index === 0;
      redoBtn.disabled = index >= entries.length - 1;
      count.textContent = `${index + 1}/${entries.length}`;

      presetList.replaceChildren(
        ...presets.map((p) => {
          const li = el("li", "t3k-history-prow");
          const apply = el("button", "t3k-history-apply");
          apply.type = "button";
          apply.dataset.action = "apply";
          apply.dataset.name = p.name;
          apply.title = `Apply "${p.name}" as a new step`;
          apply.append(el("span", null, p.name));
          const del = iconButton("close", `Delete preset ${p.name}`, "t3k-history-x");
          del.dataset.action = "delete";
          del.dataset.name = p.name;
          li.append(apply, del);
          return li;
        }),
      );
      presetList.hidden = presets.length === 0;
      presetEmpty.hidden = presets.length > 0;
      presetCount.textContent = presets.length ? String(presets.length) : "";
      saveBtn.disabled = nameInput.value.trim() === "";
    }

    undoBtn.addEventListener("click", () => api.undo());
    redoBtn.addEventListener("click", () => api.redo());
    stepsList.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-entry-id]");
      if (btn) api.jump(btn.dataset.entryId);
    });
    stepsList.addEventListener("keydown", (event) => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const buttons = [...stepsList.querySelectorAll("button[data-entry-id]")];
      const at = buttons.indexOf(document.activeElement);
      if (at === -1) return;
      event.preventDefault();
      const last = buttons.length - 1;
      const next = {
        Home: 0,
        End: last,
        ArrowDown: Math.min(last, at + 1),
        ArrowUp: Math.max(0, at - 1),
      }[event.key];
      buttons[next].focus();
    });
    presetList.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-action]");
      if (!btn) return;
      if (btn.dataset.action === "apply") api.applyPreset(btn.dataset.name);
      else api.deletePreset(btn.dataset.name);
    });
    nameInput.addEventListener("input", () => {
      saveBtn.disabled = nameInput.value.trim() === "";
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (nameInput.value.trim() === "") return;
      api.savePreset(nameInput.value);
      nameInput.value = "";
      saveBtn.disabled = true;
    });

    const observer = new ResizeObserver((records) => {
      root.classList.toggle("t3k-history-narrow", records[0].contentRect.width < 230);
    });
    observer.observe(root);

    if (useKeys) {
      const claim = () => {
        keyOwner = api;
      };
      root.addEventListener("pointerdown", claim, true);
      root.addEventListener("focusin", claim);
      if (keyed.length === 0) document.addEventListener("keydown", onDocumentKey);
      keyed.push(api);
      if (!keyOwner) keyOwner = api;
    }

    // ---- initial model
    const first = {
      id: nextId(),
      label: requireText(options.label ?? "Original", "options.label"),
      at: Date.now(),
      json: toJson(options.state ?? null, "options.state"),
      bitmap: null,
      pending: false,
      dead: false,
    };
    entries = [first];
    if (options.thumb != null) attachThumb(first, checkThumb(options.thumb));
    for (const [i, p] of (options.presets ?? []).entries()) {
      const name = requireText(p && p.name, `options.presets[${i}].name`);
      const json = toJson(p.state, `options.presets[${i}].state`);
      const at = presets.findIndex((q) => q.name === name);
      if (at >= 0) presets[at] = { name, json };
      else presets.push({ name, json });
    }

    container.append(root);
    render();
    return api;
  }

  t3kit.history = { create };
})();
