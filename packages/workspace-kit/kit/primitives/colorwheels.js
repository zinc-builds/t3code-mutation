/**
 * t3kit.colorwheels: three-way colour grading wheels (Shadows, Midtones, Highlights + optional Global) with a
 * hue/saturation puck and a luminance slider per wheel, plus Blending and Balance for the tonal split.
 * create(container, options?) -> instance. container: HTMLElement or CSS selector; fills its width (height is auto).
 *   options.value: initial partial value.  options.global: show the Global wheel (default true; value kept if hidden).
 *   options.tonal: show Blending/Balance sliders (default true).  options.header: title + Reset All row (default true).
 *   options.label: title / accessible name (default 'Color Wheels').  options.size: max wheel diameter px (default 200).
 * value = { shadows, midtones, highlights, global: {h, s, l}, blending, balance }
 *   h 0..360 degrees, 0 = red at 12 o'clock, clockwise (120 green, 240 blue); input wraps (-30 -> 330).
 *   s 0..1 puck distance from centre.  l -1..1 luminance offset.  Neutral wheel = {h:0, s:0, l:0}.
 *   blending 0..1 softness of tonal transitions (default 0.5).  balance -1..1, + gives highlights more range (default 0).
 * Instance
 *   get()              -> value, deep copy, JSON-serialisable.
 *   set(partial)       -> merge; wheels may be partial ({shadows: {s: 0.3}}). Throws TypeError (unknown key, non-number)
 *                         or RangeError (s, l, blending, balance out of range). Does NOT emit 'change'.
 *   reset(name?)       -> 'shadows' | 'midtones' | 'highlights' | 'global' | 'blending' | 'balance', or all. No 'change'.
 *   toUniforms()       -> { uCwShadows, uCwMidtones, uCwHighlights, uCwGlobal: [r,g,b] additive sRGB offsets,
 *                           uCwShadowRange, uCwHighlightRange: [lo,hi] luma ramps }. Length 3 -> uniform3fv, 2 -> uniform2fv.
 *   applyTo(imageData) -> grades that ImageData in place on the CPU (same maths as the GLSL) and returns it.
 *   on(event, cb)      -> unsubscribe.   destroy() -> removes DOM, observer, pending frame and listeners.
 * Static: t3kit.colorwheels.glsl: GLSL source (ES 1.00 and 3.00) declaring the uniforms above and
 *           vec3 colorwheelsGrade(vec3 srgb). Paste after your precision line; do not redeclare the uniforms.
 *         t3kit.colorwheels.uniformsOf(value) / .apply(imageData, value): same as the instance methods for any saved
 *           (partial) value, e.g. a full-resolution export without an instance.
 * Events: 'change' cb(get()): user edits only, at most once per frame while dragging, flushed on release.
 * Mouse: drag a wheel to set hue and saturation (centre = neutral). Double-click a wheel to reset it; double-click a
 *   slider to reset that slider. Reset All (header) resets everything and emits 'change'.
 * Keyboard (wheel focused): arrows move the puck (Shift = coarse, Alt = fine); Home, Delete or Backspace reset it.
 * Maths: weights ws/wm/wh from Rec.709 luma; out = c + (ws*S + wm*M + wh*H) / max(1, ws+wh) + G, clamped 0..1.
 *   Hue tints are luma-neutral (colour shifts without brightening); l adds a flat lift of 0.3 * l.
 * Performance: DOM + CSS; one hue bitmap per page (no timers or idle loops; theme changes are free). The primitive never
 *   touches pixels unless asked: grade a downscaled preview on the GPU per 'change', full resolution only on export.
 * Usage:
 *   const cw = t3kit.colorwheels.create(el, { value: { shadows: { h: 200, s: 0.3 }, highlights: { h: 35, s: 0.25 } } });
 *   const fs = `precision mediump float; ${t3kit.colorwheels.glsl} ... gl_FragColor.rgb = colorwheelsGrade(c.rgb);`;
 *   cw.on('change', () => draw(cw.toUniforms()));     // draw: for each [k, v] -> gl.uniform{v.length}fv(loc[k], v)
 *   cw.set({ midtones: { l: 0.1 } }); draw(cw.toUniforms()); // set() is silent, so redraw yourself
 *   t3kit.colorwheels.apply(fullResImageData, cw.get());     // export
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});

  const WHEELS = ["shadows", "midtones", "highlights", "global"];
  const TITLES = {
    shadows: "Shadows",
    midtones: "Midtones",
    highlights: "Highlights",
    global: "Global",
  };
  const OPTIONS = ["value", "global", "tonal", "header", "label", "size"];
  const HUE_NAMES = [
    "Red",
    "Orange",
    "Yellow",
    "Lime",
    "Green",
    "Spring",
    "Cyan",
    "Azure",
    "Blue",
    "Violet",
    "Magenta",
    "Rose",
  ];
  const LUMA = [0.2126, 0.7152, 0.0722];
  const CHROMA_GAIN = 0.45; // channel offset scale at full saturation
  const LUMA_GAIN = 0.3; // flat channel offset at l = 1
  const FEATHER_MIN = 0.05;
  const FEATHER_SPAN = 0.25;
  const SPLIT_SHIFT = 0.15;
  const STEP = { normal: 0.02, coarse: 0.1, fine: 0.005 };
  const TONAL_DEFAULTS = { blending: 0.5, balance: 0 };
  const MIN_WHEEL = 112; // px per column before the grid drops columns
  const KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  // Bipolar sliders get a centre notch so neutral is visible at a glance.
  const NOTCH =
    "linear-gradient(to right,transparent calc(50% - 1px),var(--muted-foreground) calc(50% - 1px),var(--muted-foreground) calc(50% + 1px),transparent calc(50% + 1px)) center/100% 10px no-repeat";
  const CSS = `
.t3k-colorwheels-root{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;width:100%;min-width:0;color:var(--foreground);font:12px/1.4 var(--font-sans)}
.t3k-colorwheels-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px}
.t3k-colorwheels-title{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.t3k-colorwheels-reset-all{flex:none;height:24px;padding:0 9px;border:1px solid var(--border);border-radius:calc(var(--radius) - 3px);background:transparent;color:var(--muted-foreground);font:500 11px var(--font-sans);cursor:pointer}
.t3k-colorwheels-reset-all:hover{color:var(--foreground);border-color:var(--input);background:var(--muted)}
.t3k-colorwheels-reset-all:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.t3k-colorwheels-grid{display:grid;gap:18px 14px;grid-template-columns:repeat(var(--t3k-colorwheels-cols,4),minmax(0,1fr))}
.t3k-colorwheels-wheel{display:flex;flex-direction:column;align-items:center;gap:7px;min-width:0}
.t3k-colorwheels-name{margin:0;font-size:12px;font-weight:600;color:var(--foreground)}
.t3k-colorwheels-wheel[data-active] .t3k-colorwheels-name::after{content:"";display:inline-block;width:5px;height:5px;margin-left:6px;vertical-align:middle;border-radius:50%;background:var(--primary)}
.t3k-colorwheels-disk{position:relative;box-sizing:border-box;width:100%;max-width:var(--t3k-colorwheels-size,200px);aspect-ratio:1/1;border-radius:50%;cursor:crosshair;touch-action:none;user-select:none;-webkit-user-select:none;background:radial-gradient(closest-side,color-mix(in srgb,var(--foreground) 45%,var(--background)) 4%,transparent 100%),var(--t3k-colorwheels-spectrum) center/100% 100%;box-shadow:0 0 0 1px var(--border),0 0 0 4px var(--muted),0 0 0 5px var(--border)}
.t3k-colorwheels-disk::before,.t3k-colorwheels-disk::after{content:"";position:absolute;left:50%;top:50%;background:var(--background);opacity:.55;pointer-events:none}
.t3k-colorwheels-disk::before{width:1px;height:14px;margin:-7px 0 0 -.5px}
.t3k-colorwheels-disk::after{width:14px;height:1px;margin:-.5px 0 0 -7px}
.t3k-colorwheels-disk:focus-visible{outline:2px solid var(--ring);outline-offset:7px}
.t3k-colorwheels-puck{position:absolute;z-index:1;left:50%;top:50%;width:14px;height:14px;box-sizing:border-box;border-radius:50%;border:2px solid var(--foreground);box-shadow:0 0 0 1.5px var(--background),inset 0 0 0 1px var(--background);transform:translate(-50%,-50%);pointer-events:none}
.t3k-colorwheels-readout{font:11px/1.3 var(--font-mono);color:var(--muted-foreground);text-align:center;min-height:1.3em;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.t3k-colorwheels-lum{display:flex;align-items:center;gap:8px;width:100%;max-width:var(--t3k-colorwheels-size,200px);min-width:0}
.t3k-colorwheels-lum-label{flex:none;font-size:11px;color:var(--muted-foreground)}
.t3k-colorwheels-value{flex:none;min-width:4ch;text-align:right;font:11px/1 var(--font-mono);color:var(--muted-foreground);font-variant-numeric:tabular-nums}
.t3k-colorwheels-tonal{display:flex;flex-direction:column;gap:10px;padding-top:14px;border-top:1px solid var(--border)}
.t3k-colorwheels-tonal-row{display:grid;grid-template-columns:64px minmax(0,1fr) 4ch;align-items:center;gap:10px}
.t3k-colorwheels-tonal-label{font-size:12px;color:var(--muted-foreground)}
.t3k-colorwheels-range{-webkit-appearance:none;appearance:none;flex:1 1 auto;min-width:0;width:100%;height:18px;margin:0;padding:0;background:transparent;cursor:pointer}
.t3k-colorwheels-range::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:var(--input)}
.t3k-colorwheels-range::-moz-range-track{height:4px;border-radius:2px;background:var(--input)}
.t3k-colorwheels-range.t3k-colorwheels-bipolar::-webkit-slider-runnable-track{background:${NOTCH},var(--input)}
.t3k-colorwheels-range.t3k-colorwheels-bipolar::-moz-range-track{background:${NOTCH},var(--input)}
.t3k-colorwheels-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;margin-top:-4px;border-radius:50%;border:2px solid var(--background);box-shadow:0 0 0 1px var(--foreground);background:var(--foreground)}
.t3k-colorwheels-range::-moz-range-thumb{width:8px;height:8px;border-radius:50%;border:2px solid var(--background);box-shadow:0 0 0 1px var(--foreground);background:var(--foreground)}
.t3k-colorwheels-range:focus-visible{outline:2px solid var(--ring);outline-offset:2px;border-radius:4px}
`;

  const GLSL = `uniform vec3 uCwShadows;
uniform vec3 uCwMidtones;
uniform vec3 uCwHighlights;
uniform vec3 uCwGlobal;
uniform vec2 uCwShadowRange;
uniform vec2 uCwHighlightRange;
vec3 colorwheelsGrade(vec3 c) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float ws = 1.0 - smoothstep(uCwShadowRange.x, uCwShadowRange.y, y);
  float wh = smoothstep(uCwHighlightRange.x, uCwHighlightRange.y, y);
  float wm = max(0.0, 1.0 - ws - wh);
  vec3 tone = (ws * uCwShadows + wm * uCwMidtones + wh * uCwHighlights) / max(1.0, ws + wh);
  return clamp(c + tone + uCwGlobal, 0.0, 1.0);
}
`;

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const round = (x, d) => Math.round(x * d) / d;
  const wrapHue = (h) => round(((h % 360) + 360) % 360, 100) % 360;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
  const hueName = (h) => HUE_NAMES[Math.floor(((h + 15) % 360) / 30)];
  const neutral = () => ({ h: 0, s: 0, l: 0 });
  const defaultValue = () => ({
    shadows: neutral(),
    midtones: neutral(),
    highlights: neutral(),
    global: neutral(),
    ...TONAL_DEFAULTS,
  });

  function finite(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(
        `colorwheels: ${name} must be a finite number, got ${JSON.stringify(value)}`,
      );
    }
    return value;
  }

  function inRange(value, name, lo, hi) {
    finite(value, name);
    if (value < lo || value > hi)
      throw new RangeError(`colorwheels: ${name} must be within ${lo}..${hi}, got ${value}`);
    return value;
  }

  function asObject(value, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`colorwheels: ${name} must be a plain object`);
    }
    return value;
  }

  function mergeWheel(current, patch, name) {
    asObject(patch, name);
    const next = { ...current };
    for (const key of Object.keys(patch)) {
      if (key === "h") next.h = wrapHue(finite(patch.h, `${name}.h`));
      else if (key === "s") next.s = inRange(patch.s, `${name}.s`, 0, 1);
      else if (key === "l") next.l = inRange(patch.l, `${name}.l`, -1, 1);
      else throw new TypeError(`colorwheels: unknown key "${name}.${key}" (use h, s, l)`);
    }
    return next;
  }

  // Returns a new value; the input value is never mutated, so a throwing patch leaves state intact.
  function mergeValue(value, patch, name) {
    asObject(patch, name);
    const next = copyValue(value);
    for (const key of Object.keys(patch)) {
      if (WHEELS.includes(key)) next[key] = mergeWheel(value[key], patch[key], key);
      else if (key === "blending") next.blending = inRange(patch.blending, "blending", 0, 1);
      else if (key === "balance") next.balance = inRange(patch.balance, "balance", -1, 1);
      else
        throw new TypeError(
          `colorwheels: unknown key "${key}" (use ${WHEELS.join(", ")}, blending, balance)`,
        );
    }
    return next;
  }

  function copyValue(v) {
    const out = {};
    for (const name of WHEELS) out[name] = { h: v[name].h, s: v[name].s, l: v[name].l };
    out.blending = v.blending;
    out.balance = v.balance;
    return out;
  }

  // Fully saturated hue as sRGB 0..1 (HSV with s = v = 1).
  function hueRgb(h) {
    const f = (n) => {
      const k = (n + h / 60) % 6;
      return 1 - Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
  }

  // Additive offset for one wheel: a luma-neutral hue tint plus a flat luminance lift.
  function offsetOf(w) {
    const pure = hueRgb(w.h);
    const y = LUMA[0] * pure[0] + LUMA[1] * pure[1] + LUMA[2] * pure[2];
    const k = w.s * CHROMA_GAIN;
    const lift = w.l * LUMA_GAIN;
    return pure.map((c) => round(k * (c - y) + lift, 1e5));
  }

  function uniformsOf(partial) {
    const v = mergeValue(defaultValue(), partial, "value");
    const feather = FEATHER_MIN + FEATHER_SPAN * v.blending;
    const shadowMid = 0.35 - SPLIT_SHIFT * v.balance;
    const highlightMid = 0.65 - SPLIT_SHIFT * v.balance;
    return {
      uCwShadows: offsetOf(v.shadows),
      uCwMidtones: offsetOf(v.midtones),
      uCwHighlights: offsetOf(v.highlights),
      uCwGlobal: offsetOf(v.global),
      uCwShadowRange: [round(shadowMid - feather, 1e5), round(shadowMid + feather, 1e5)],
      uCwHighlightRange: [round(highlightMid - feather, 1e5), round(highlightMid + feather, 1e5)],
    };
  }

  function apply(imageData, partial) {
    if (!imageData || !(imageData.data instanceof Uint8ClampedArray)) {
      throw new TypeError("colorwheels: apply needs an ImageData (or { data: Uint8ClampedArray })");
    }
    const u = uniformsOf(partial);
    const [S, M, H, G] = [u.uCwShadows, u.uCwMidtones, u.uCwHighlights, u.uCwGlobal];
    const [slo, shi] = u.uCwShadowRange;
    const [hlo, hhi] = u.uCwHighlightRange;
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255;
      const g = d[i + 1] / 255;
      const b = d[i + 2] / 255;
      const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
      const ws = 1 - smoothstep(slo, shi, y);
      const wh = smoothstep(hlo, hhi, y);
      const wm = Math.max(0, 1 - ws - wh);
      const n = Math.max(1, ws + wh);
      d[i] = clamp(r + (ws * S[0] + wm * M[0] + wh * H[0]) / n + G[0], 0, 1) * 255;
      d[i + 1] = clamp(g + (ws * S[1] + wm * M[1] + wh * H[1]) / n + G[1], 0, 1) * 255;
      d[i + 2] = clamp(b + (ws * S[2] + wm * M[2] + wh * H[2]) / n + G[2], 0, 1) * 255;
    }
    return imageData;
  }

  function describeWheel(w) {
    const pct = Math.round(w.s * 100);
    const lum = Math.round(w.l * 100);
    const tone = pct === 0 ? "Neutral" : `${hueName(w.h)} ${Math.round(w.h)}° ${pct}%`;
    return lum === 0 ? tone : `${tone} · L ${signed(lum)}`;
  }

  // Hue spectrum (0 = top, clockwise) painted once per page into a data URL. A CSS conic-gradient shows a seam line
  // at fractional sizes in Chrome's raster; this bitmap does not, and it never needs a redraw (the hue space is
  // theme-independent; the neutral centre is a CSS overlay in theme colours).
  let spectrum = null;
  function spectrumUrl() {
    if (spectrum) return spectrum;
    const n = 256;
    const canvas = document.createElement("canvas");
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const h = ((Math.atan2(x + 0.5 - n / 2, n / 2 - y - 0.5) * 180) / Math.PI + 360) % 360;
        const rgb = hueRgb(h);
        const i = (y * n + x) * 4;
        for (let c = 0; c < 3; c++) img.data[i + c] = (0.136 + 0.768 * rgb[c]) * 255; // hsl(h 80% 52%)
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    spectrum = `url("${canvas.toDataURL("image/png")}")`;
    return spectrum;
  }

  function ensureStyle() {
    if (document.head.querySelector('style[data-t3kit="colorwheels"]')) return;
    const style = document.createElement("style");
    style.setAttribute("data-t3kit", "colorwheels");
    style.textContent = CSS;
    document.head.append(style);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function range(min, max, label, bipolar) {
    const input = el(
      "input",
      bipolar ? "t3k-colorwheels-range t3k-colorwheels-bipolar" : "t3k-colorwheels-range",
    );
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    input.setAttribute("aria-label", label);
    return input;
  }

  function bool(value, name, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean")
      throw new TypeError(`colorwheels.create: options.${name} must be a boolean`);
    return value;
  }

  function create(target, options = {}) {
    const container = typeof target === "string" ? document.querySelector(target) : target;
    if (!(container instanceof HTMLElement)) {
      throw new TypeError(
        "colorwheels.create: container must be an HTMLElement or a selector that matches one",
      );
    }
    asObject(options, "options");
    for (const key of Object.keys(options)) {
      if (!OPTIONS.includes(key))
        throw new TypeError(
          `colorwheels.create: unknown option "${key}" (use ${OPTIONS.join(", ")})`,
        );
    }
    const showGlobal = bool(options.global, "global", true);
    const showTonal = bool(options.tonal, "tonal", true);
    const showHeader = bool(options.header, "header", true);
    const label = options.label ?? "Color Wheels";
    if (typeof label !== "string")
      throw new TypeError("colorwheels.create: options.label must be a string");
    const size = options.size === undefined ? 200 : inRange(options.size, "options.size", 64, 640);

    let value =
      options.value === undefined
        ? defaultValue()
        : mergeValue(defaultValue(), options.value, "options.value");
    const listeners = new Set();
    let frame = 0;
    let dirty = false;

    ensureStyle();
    const names = showGlobal ? WHEELS : WHEELS.slice(0, 3);
    const root = el("div", "t3k-colorwheels-root");
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", label);
    root.style.setProperty("--t3k-colorwheels-size", `${size}px`);
    root.style.setProperty("--t3k-colorwheels-spectrum", spectrumUrl());

    if (showHeader) {
      const head = el("div", "t3k-colorwheels-head");
      const resetAll = el("button", "t3k-colorwheels-reset-all", "Reset All");
      resetAll.type = "button";
      resetAll.addEventListener("click", () => commit(defaultValue(), null, true));
      head.append(el("span", "t3k-colorwheels-title", label), resetAll);
      root.append(head);
    }

    const grid = el("div", "t3k-colorwheels-grid");
    const parts = {};
    for (const name of names) {
      parts[name] = buildWheel(name);
      grid.append(parts[name].section);
    }
    root.append(grid);
    const tonal = showTonal ? buildTonal() : null;
    if (tonal) root.append(tonal.section);
    container.append(root);

    // Wheels waiting to be redrawn: a Set of names, 'all', or null. Drags redraw once per frame, not per move.
    let renderPending = null;
    function flushRender() {
      if (renderPending === "all") renderAll();
      else if (renderPending) for (const name of renderPending) renderWheel(name);
      renderPending = null;
    }

    function emitNow() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      flushRender();
      if (!dirty) return;
      dirty = false;
      const snapshot = copyValue(value);
      for (const cb of [...listeners]) cb(snapshot);
    }

    // User edit: the value updates now; DOM and 'change' follow now (discrete edits) or on the next frame (drags
    // and slider scrubs), so any number of pointer moves cost one redraw per frame.
    function commit(next, name, immediate) {
      value = next;
      if (!name) renderPending = "all";
      else if (renderPending !== "all") (renderPending ??= new Set()).add(name);
      dirty = true;
      if (immediate) emitNow();
      else if (!frame) frame = requestAnimationFrame(emitNow);
    }

    const editWheel = (name, patch, immediate) => {
      const next = copyValue(value);
      next[name] = { ...next[name], ...patch };
      commit(next, name, immediate);
    };

    // (x, y) in wheel radii, y down. The centre keeps the previous hue so saturation can return to it.
    function polar(name, x, y) {
      const r = Math.hypot(x, y);
      if (r < 1e-6) return { h: value[name].h, s: 0 };
      return { h: wrapHue((Math.atan2(x, -y) * 180) / Math.PI), s: round(Math.min(1, r), 1e4) };
    }

    function buildWheel(name) {
      const title = TITLES[name];
      const section = el("section", "t3k-colorwheels-wheel");
      section.dataset.wheel = name;
      const disk = el("div", "t3k-colorwheels-disk");
      disk.tabIndex = 0;
      disk.setAttribute("role", "slider");
      disk.setAttribute("aria-roledescription", "color wheel");
      disk.setAttribute("aria-label", `${title} hue and saturation`);
      disk.setAttribute("aria-valuemin", "0");
      disk.setAttribute("aria-valuemax", "100");
      const puck = el("span", "t3k-colorwheels-puck");
      disk.append(puck);
      const readout = el("div", "t3k-colorwheels-readout");
      readout.setAttribute("aria-hidden", "true");
      const lumRow = el("div", "t3k-colorwheels-lum");
      const lum = range(-100, 100, `${title} luminance`, true);
      const lumValue = el("output", "t3k-colorwheels-value");
      lumRow.append(el("span", "t3k-colorwheels-lum-label", "Lum"), lum, lumValue);
      section.append(el("h3", "t3k-colorwheels-name", title), disk, readout, lumRow);

      let pointer = null;
      let rect = null; // read once per drag so moves never force layout
      const at = (e) => {
        const r = rect.width / 2;
        return polar(name, (e.clientX - rect.left - r) / r, (e.clientY - rect.top - r) / r);
      };
      disk.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.detail > 1) return; // second click of a double-click: leave it to dblclick
        pointer = e.pointerId;
        rect = disk.getBoundingClientRect();
        disk.setPointerCapture(e.pointerId);
        disk.focus({ preventScroll: true });
        editWheel(name, at(e), false);
      });
      disk.addEventListener("pointermove", (e) => {
        if (e.pointerId === pointer) editWheel(name, at(e), false);
      });
      const release = (e) => {
        if (e.pointerId !== pointer) return;
        pointer = null;
        emitNow();
      };
      disk.addEventListener("pointerup", release);
      disk.addEventListener("pointercancel", release);
      disk.addEventListener("dblclick", () => editWheel(name, { h: 0, s: 0, l: 0 }, true));
      disk.addEventListener("keydown", (e) => {
        if (e.key === "Home" || e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          editWheel(name, { h: 0, s: 0, l: 0 }, true);
          return;
        }
        const dir = KEYS[e.key];
        if (!dir) return;
        e.preventDefault();
        const step = e.shiftKey ? STEP.coarse : e.altKey ? STEP.fine : STEP.normal;
        const w = value[name];
        const a = toRad(w.h);
        editWheel(
          name,
          polar(name, w.s * Math.sin(a) + dir[0] * step, -w.s * Math.cos(a) + dir[1] * step),
          true,
        );
      });

      lum.addEventListener("input", () => editWheel(name, { l: Number(lum.value) / 100 }, false));
      lum.addEventListener("change", emitNow);
      lum.addEventListener("dblclick", () => editWheel(name, { l: 0 }, true));
      return { section, disk, puck, readout, lum, lumValue };
    }

    function buildTonal() {
      const section = el("div", "t3k-colorwheels-tonal");
      const rows = [
        tonalRow("Blending", "blending", 0, false),
        tonalRow("Balance", "balance", -100, true),
      ];
      for (const row of rows) section.append(row.row);
      return { section, rows };
    }

    function tonalRow(text, key, min, bipolar) {
      const row = el("label", "t3k-colorwheels-tonal-row");
      const input = range(min, 100, text, bipolar);
      const out = el("output", "t3k-colorwheels-value");
      const edit = (v, immediate) => commit({ ...copyValue(value), [key]: v }, null, immediate);
      input.addEventListener("input", () => edit(Number(input.value) / 100, false));
      input.addEventListener("change", emitNow);
      input.addEventListener("dblclick", () => edit(TONAL_DEFAULTS[key], true));
      row.append(el("span", "t3k-colorwheels-tonal-label", text), input, out);
      return { key, input, out, row, bipolar };
    }

    function renderWheel(name) {
      const p = parts[name];
      if (!p) return; // hidden Global wheel: value kept, nothing to draw
      const w = value[name];
      const a = toRad(w.h);
      p.puck.style.left = `${50 + 50 * w.s * Math.sin(a)}%`;
      p.puck.style.top = `${50 - 50 * w.s * Math.cos(a)}%`;
      const lum = Math.round(w.l * 100);
      p.lum.value = String(lum);
      p.lumValue.textContent = signed(lum);
      const text = describeWheel(w);
      p.readout.textContent = text;
      p.disk.setAttribute("aria-valuenow", String(Math.round(w.s * 100)));
      p.disk.setAttribute("aria-valuetext", text);
      p.section.toggleAttribute("data-active", w.s > 0 || w.l !== 0);
    }

    function renderAll() {
      for (const name of names) renderWheel(name);
      if (!tonal) return;
      for (const row of tonal.rows) {
        const v = Math.round(value[row.key] * 100);
        row.input.value = String(v);
        row.out.textContent = row.bipolar ? signed(v) : String(v);
      }
    }

    // Column count changes only when the container crosses a breakpoint.
    let cols = 0;
    function layout() {
      const width = container.clientWidth;
      const n = names.length;
      const next = width >= n * MIN_WHEEL ? n : width >= 2 * MIN_WHEEL ? 2 : 1;
      if (next === cols) return;
      cols = next;
      grid.style.setProperty("--t3k-colorwheels-cols", String(next));
    }
    const observer = new ResizeObserver(layout);
    observer.observe(container);
    layout(); // synchronous first pass, so the first paint already has the right column count
    renderAll();

    return {
      get: () => copyValue(value),
      set(partial) {
        value = mergeValue(value, partial, "set()");
        renderAll();
      },
      reset(name) {
        const next = copyValue(value);
        if (name === undefined) value = defaultValue();
        else if (WHEELS.includes(name)) value = { ...next, [name]: neutral() };
        else if (Object.hasOwn(TONAL_DEFAULTS, name))
          value = { ...next, [name]: TONAL_DEFAULTS[name] };
        else throw new TypeError(`colorwheels.reset: unknown name "${name}"`);
        renderAll();
      },
      toUniforms: () => uniformsOf(value),
      applyTo: (imageData) => apply(imageData, value),
      on(event, cb) {
        if (event !== "change")
          throw new TypeError(`colorwheels.on: unknown event "${event}" (only "change")`);
        if (typeof cb !== "function")
          throw new TypeError("colorwheels.on: callback must be a function");
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      destroy() {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        observer.disconnect();
        listeners.clear();
        root.remove();
      },
    };
  }

  t3kit.colorwheels = { create, glsl: GLSL, uniformsOf, apply };
})();
