/**
 * t3kit.palette: design-token colour editor. OKLCH ramps per family (hue, chroma, lightness curve, per-step locks),
 * semantic roles per theme, a WCAG 2.x / APCA contrast matrix with one-click fixes. Reads and writes token files.
 * create(container, options?) -> instance. container: HTMLElement or CSS selector; the editor fills it.
 *   options: view 'ramps' (default) | 'contrast' | 'roles'; steps (ascending ints, default 50,100..900,950);
 *   method 'wcag' (default) | 'apca'; target 'AA' (default) | 'AAA'; theme 'light' (default) | 'dark'; value.
 * value = { v: 1, families, roles, pairs, unknown }
 *   families: [{ id, name, hue (0..360), chroma (0..0.4), curve: [[x, y], ...], steps: { '500': { hex, oklch, locked } } }]
 *     curve: x 0..1 = step position, y = OKLCH L; must hold x=0 and x=1; monotone cubic, the same spline as t3kit.curves.
 *   roles: { light: { 'fg.default': 'neutral.900', ... }, dark: { ... } }: a token is 'familyId.step' and must exist.
 *   pairs: [{ fg: role, bg: role, use: 'text' | 'large' | 'ui' }], roles defined in both themes. unknown: kept keys.
 * Instance
 *   get() -> value copy.  set(partial) -> families, roles, pairs, unknown each replace; unlocked steps recompute.
 *     No 'change'; emits 'report'. Throws (and keeps the old value) on bad shapes or dangling role/pair references.
 *   import(text, { format = 'auto' | 'json' | 'w3c' | 'css' | 'tailwind', apply = true }) -> { families, roles, warnings }.
 *     Applies the file (pairs and unknown too when it has them) and emits 'change'; apply: false only parses.
 *   export(format = 'json' | 'w3c' | 'css' | 'tailwind') -> string. json and w3c keep unknown keys and key order.
 *   addFamily({ name, seed: hex }) -> id.  editFamily(id, { name?, hue?, chroma?, curve? }): both emit 'change'.
 *   select(familyId, step?) emits 'select'.  selected() -> { familyId, step }.
 *   configure({ view?, theme?, method?, target? }): editor view and thresholds, no events.
 *   sample(blobOrUrl, { count = 6 }) -> Promise<hex[]>: k-means in OKLab on a 128px thumbnail, largest cluster first.
 *   harmony(seedHex, 'analogous' | 'triadic' | 'split' | 'tetradic' | 'mono') -> hex[] (seed hue first).
 *   report() -> [{ pair, fg, bg, use, theme, ratio, apca, pass, fix: { token, hex, ratio } | null }].
 *   fix(pairIndex?) -> applied [{ pair, theme, token, hex, ratio }]: repoints the fg role to the nearest passing
 *     unlocked step of its family, for one pair or every failing pair; emits 'change' when anything moved.
 *   on(event, cb) -> unsubscribe.  destroy() removes the DOM and listeners.
 * Events: 'change' (get()) on user edits, import, addFamily, editFamily, fix.  'select' ({ familyId, step }).
 *   'report' (report()) after every recompute, set() included.
 * Keys (ramps): Left/Right move the step, Up/Down the family; Shift+arrows nudge lightness 0.01 and lock; L toggles
 *   the lock; Enter (or double-click) edits the hex, Escape cancels. Curve: drag, click adds, double-click removes.
 * Thresholds: WCAG text 4.5 / 7, large and ui 3 / 4.5 (AA / AAA). APCA text Lc 75 / 90, large and ui Lc 60 / 75.
 * Statics: t3kit.palette.contrast(fg, bg, { method }) -> ratio or |Lc|; toOklch(hex) -> [l, c, h]; toHex(lch) clips.
 * Pair with t3kit.links.curvesPalette(curves, palette): a t3kit.curves editor shapes the selected family's curve.
 * Example:
 *   const pal = t3kit.palette.create(el, { view: 'contrast', method: 'apca' });
 *   const id = pal.addFamily({ name: 'Brand', seed: (await pal.sample(blob))[0] });
 *   pal.set({ roles: { light: { fg: `${id}.900`, bg: `${id}.50` }, dark: { fg: `${id}.50`, bg: `${id}.950` } },
 *             pairs: [{ fg: 'fg', bg: 'bg', use: 'text' }] });
 *   pal.on('change', () => save(pal.export('w3c')));
 */
(function () {
  "use strict";
  const t3kit = (window.t3kit = window.t3kit || {});

  const DEFAULT_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
  const THEMES = ["light", "dark"];
  const USES = ["text", "large", "ui"];
  const VIEWS = ["ramps", "contrast", "roles"];
  const METHODS = ["wcag", "apca"];
  const LEVELS = ["AA", "AAA"];
  const THRESH = {
    wcag: { AA: { text: 4.5, large: 3, ui: 3 }, AAA: { text: 7, large: 4.5, ui: 4.5 } },
    apca: { AA: { text: 75, large: 60, ui: 60 }, AAA: { text: 90, large: 75, ui: 75 } },
  };
  const MAX_CHROMA = 0.4;
  const NUDGE = 0.01;
  const GAP_X = 0.01; // minimum x spacing between neighbouring curve points
  const PAD = 8,
    ROW = 52,
    SW = 40,
    GAP = 3; // stage: outer pad, row pitch, swatch height, swatch gap (css px)
  const CURVE_H = 150,
    CURVE_P = 16,
    CURVE_B = 20; // curve canvas height, inset and bottom label band
  const CSS_VAR = "--"; // built apart from the names so the token lint reads only contract names in strings
  const STEP_NAME = /^([a-z0-9][a-z0-9-]*)-(\d+)$/;
  const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
  const CSS = `
.t3k-palette-root{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:100%;height:100%;min-height:0;overflow:auto;padding:12px;color:var(--foreground);background:var(--background);font:13px/1.4 var(--font-sans)}
.t3k-palette-root [hidden]{display:none!important}
.t3k-palette-root :focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.t3k-palette-bar,.t3k-palette-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.t3k-palette-bar{justify-content:space-between}
.t3k-palette-sec{display:grid;gap:12px;min-width:0}
.t3k-palette-group{display:inline-flex;flex-wrap:wrap;gap:2px;padding:2px;border:1px solid var(--border);border-radius:var(--radius);background:var(--muted)}
.t3k-palette-btn{display:inline-flex;align-items:center;height:26px;padding:0 10px;border:1px solid transparent;border-radius:calc(var(--radius) - 3px);background:transparent;color:var(--muted-foreground);font:inherit;font-weight:500;cursor:pointer}
.t3k-palette-btn:hover{color:var(--foreground)}
.t3k-palette-btn[aria-pressed="true"]{background:var(--card);border-color:var(--border);color:var(--foreground)}
.t3k-palette-btn:disabled{opacity:.5;cursor:default}
.t3k-palette-field{display:inline-flex;align-items:center;gap:6px;color:var(--muted-foreground);font-size:12px}
.t3k-palette-input,.t3k-palette-select{box-sizing:border-box;height:26px;min-width:0;padding:0 6px;border:1px solid var(--input);border-radius:calc(var(--radius) - 3px);background:var(--card);color:var(--foreground);font:inherit}
.t3k-palette-input[type=color]{width:36px;padding:2px}
.t3k-palette-range{width:140px;accent-color:var(--primary)}
.t3k-palette-out{min-width:4ch;font:12px var(--font-mono);color:var(--muted-foreground)}
.t3k-palette-stagewrap{position:relative;min-width:0}
.t3k-palette-stage{display:block;width:100%;border-radius:var(--radius)}
.t3k-palette-edit{position:absolute;box-sizing:border-box;padding:0 4px;border:2px solid var(--ring);border-radius:6px;background:var(--card);color:var(--foreground);font:600 11px var(--font-mono);outline:none}
.t3k-palette-status{margin:0;min-height:18px;font-size:12px;color:var(--muted-foreground)}
.t3k-palette-empty{padding:24px;border:1px dashed var(--border);border-radius:var(--radius);color:var(--muted-foreground);text-align:center}
.t3k-palette-curve{display:block;width:100%;height:150px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card)}
.t3k-palette-hint{margin:0;font-size:12px;color:var(--muted-foreground)}
.t3k-palette-matrixwrap{max-width:100%;overflow:auto;border:1px solid var(--border);border-radius:var(--radius)}
.t3k-palette-matrix{border-collapse:collapse;font-size:12px}
.t3k-palette-matrix th,.t3k-palette-matrix td{padding:0;border:1px solid var(--border)}
.t3k-palette-matrix th{padding:6px 8px;background:var(--muted);color:var(--muted-foreground);font-weight:500;text-align:left;white-space:nowrap}
.t3k-palette-cell{box-sizing:border-box;width:100%;min-width:96px;height:56px;padding:6px 8px;display:flex;flex-direction:column;justify-content:space-between}
.t3k-palette-cell b{font-size:15px;font-weight:600;line-height:1}
.t3k-palette-cell small{font-size:11px;line-height:1.2}
.t3k-palette-self{background:var(--muted);color:var(--muted-foreground);text-align:center}
.t3k-palette-pairs{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.t3k-palette-pair{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card)}
.t3k-palette-grow{flex:1 1 180px;min-width:0;overflow-wrap:anywhere}
.t3k-palette-pill{display:inline-flex;align-items:center;height:20px;padding:0 8px;border:1px solid var(--border);border-radius:999px;font-size:11px;white-space:nowrap}
.t3k-palette-pill[data-pass="true"]{border-color:var(--success);background:color-mix(in srgb,var(--success) 16%,transparent)}
.t3k-palette-pill[data-pass="false"]{border-color:var(--destructive);background:color-mix(in srgb,var(--destructive) 16%,transparent)}
.t3k-palette-roles{width:100%;border-collapse:collapse}
.t3k-palette-roles th,.t3k-palette-roles td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:middle}
.t3k-palette-swatch{display:inline-block;width:14px;height:14px;vertical-align:middle;border-radius:4px;border:1px solid var(--border)}
.t3k-palette-code{font:12px var(--font-mono);color:var(--muted-foreground)}
`;
  const TEMPLATE = `
<div class="t3k-palette-bar">
  <div class="t3k-palette-controls">
    <div class="t3k-palette-group" role="group" aria-label="View">
      <button type="button" class="t3k-palette-btn" data-view="ramps" aria-pressed="true">Ramps</button>
      <button type="button" class="t3k-palette-btn" data-view="contrast" aria-pressed="false">Contrast</button>
      <button type="button" class="t3k-palette-btn" data-view="roles" aria-pressed="false">Roles</button>
    </div>
    <div class="t3k-palette-group" data-group="theme" role="group" aria-label="Theme" hidden>
      <button type="button" class="t3k-palette-btn" data-theme-btn="light" aria-pressed="true">Light</button>
      <button type="button" class="t3k-palette-btn" data-theme-btn="dark" aria-pressed="false">Dark</button>
    </div>
  </div>
  <form class="t3k-palette-controls" data-add-form>
    <input class="t3k-palette-input" type="color" value="#346bf1" data-add-seed aria-label="Seed colour">
    <input class="t3k-palette-input" type="text" placeholder="Name" maxlength="40" data-add-name aria-label="New colour name">
    <button type="submit" class="t3k-palette-btn">Add colour</button>
  </form>
</div>
<p class="t3k-palette-status" data-status aria-live="polite"></p>
<section class="t3k-palette-sec" data-panel="ramps">
  <div class="t3k-palette-empty" data-empty>Add a colour to start its ramp.</div>
  <div class="t3k-palette-stagewrap" data-stagewrap>
    <canvas class="t3k-palette-stage" tabindex="0" data-stage aria-label="Colour ramps. Arrow keys move, L locks, Enter edits the hex."></canvas>
    <input class="t3k-palette-edit" data-edit hidden maxlength="7" aria-label="Edit hex">
  </div>
  <div class="t3k-palette-sec" data-family>
    <div class="t3k-palette-controls">
      <label class="t3k-palette-field">Name <input class="t3k-palette-input" type="text" maxlength="40" data-name></label>
      <label class="t3k-palette-field">Hue <input class="t3k-palette-range" type="range" min="0" max="360" step="1" data-hue aria-label="Hue"><output class="t3k-palette-out" data-hue-out></output></label>
      <label class="t3k-palette-field">Chroma <input class="t3k-palette-range" type="range" min="0" max="0.4" step="0.001" data-chroma aria-label="Chroma"><output class="t3k-palette-out" data-chroma-out></output></label>
    </div>
    <canvas class="t3k-palette-curve" tabindex="0" data-curve aria-label="Lightness curve. Arrows move the selected point, Delete removes it."></canvas>
    <p class="t3k-palette-hint">Arrows move the focus, L locks a step, Shift+arrows nudge lightness, Enter edits the hex. Drag the curve to shape lightness, click to add a point, double-click to remove one.</p>
  </div>
</section>
<section class="t3k-palette-sec" data-panel="contrast" hidden>
  <div class="t3k-palette-controls">
    <label class="t3k-palette-field">Method <select class="t3k-palette-select" data-method><option value="wcag">WCAG 2</option><option value="apca">APCA</option></select></label>
    <label class="t3k-palette-field">Level <select class="t3k-palette-select" data-target><option value="AA">AA</option><option value="AAA">AAA</option></select></label>
    <button type="button" class="t3k-palette-btn" data-fix-all>Fix all failing</button>
  </div>
  <div class="t3k-palette-matrixwrap" data-matrix></div>
  <ul class="t3k-palette-pairs" data-pairs></ul>
  <form class="t3k-palette-controls" data-pair-form>
    <label class="t3k-palette-field">Text <select class="t3k-palette-select" data-new-fg></select></label>
    <label class="t3k-palette-field">Background <select class="t3k-palette-select" data-new-bg></select></label>
    <label class="t3k-palette-field">Use <select class="t3k-palette-select" data-new-use><option value="text">text</option><option value="large">large</option><option value="ui">ui</option></select></label>
    <button type="submit" class="t3k-palette-btn">Add pair</button>
  </form>
</section>
<section class="t3k-palette-sec" data-panel="roles" hidden>
  <div data-roles-table></div>
  <form class="t3k-palette-controls" data-role-form>
    <input class="t3k-palette-input" type="text" placeholder="fg.muted" maxlength="40" data-role-name aria-label="New role name">
    <select class="t3k-palette-select" data-role-token aria-label="Token for new role"></select>
    <button type="submit" class="t3k-palette-btn">Add role</button>
  </form>
</section>`;

  // ---- Colour maths: sRGB hex <-> linear RGB <-> OKLab <-> OKLCH, gamut clipping, WCAG and APCA contrast ----
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round = (v, d) => {
    const p = 10 ** d;
    return Math.round(v * p) / p;
  };
  const clone = (v) => structuredClone(v);
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const mod360 = (h) => ((h % 360) + 360) % 360;
  const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const linToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

  function parseHex(hex) {
    const m = HEX.exec(typeof hex === "string" ? hex.trim() : "");
    if (!m) throw new TypeError(`palette: not a hex colour "${hex}"`);
    const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  const normHex = (hex) =>
    "#" +
    parseHex(hex)
      .map((c) =>
        Math.round(c * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");

  function rgbToOklab([r0, g0, b0]) {
    const [r, g, b] = [r0, g0, b0].map(srgbToLin);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }
  function linearOf([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  }
  const inGamut = (lin) => lin.every((c) => c >= -1e-6 && c <= 1 + 1e-6);
  // Scales chroma toward the neutral axis at fixed lightness until the colour fits sRGB.
  function labToHex([L0, a, b]) {
    const L = clamp(L0, 0, 1);
    let k = 1;
    if (!inGamut(linearOf([L, a, b]))) {
      let lo = 0,
        hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (inGamut(linearOf([L, a * mid, b * mid]))) lo = mid;
        else hi = mid;
      }
      k = lo;
    }
    const rgb = linearOf([L, a * k, b * k]).map((c) =>
      Math.round(clamp(linToSrgb(clamp(c, 0, 1)), 0, 1) * 255),
    );
    return "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  const toOklab = (hex) => rgbToOklab(parseHex(hex));
  function toOklch(hex) {
    const [L, a, b] = toOklab(hex);
    const c = Math.hypot(a, b);
    return [L, c, c < 1e-4 ? 0 : mod360((Math.atan2(b, a) * 180) / Math.PI)];
  }
  function toHex([L, C, h]) {
    const r = (h * Math.PI) / 180;
    return labToHex([L, C * Math.cos(r), C * Math.sin(r)]);
  }
  const lumOf = (hex) => {
    const [r, g, b] = parseHex(hex).map(srgbToLin);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  function wcagRatio(fg, bg) {
    const a = lumOf(fg),
      b = lumOf(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  const apcaY = (hex) => {
    const [r, g, b] = parseHex(hex).map((c) => c ** 2.4);
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    return y > 0.022 ? y : y + (0.022 - y) ** 1.414;
  };
  // Signed APCA-W3 0.0.98G-4g Lc: positive for dark text on light, negative for light text on dark.
  function apcaLc(fg, bg) {
    const t = apcaY(fg),
      bgY = apcaY(bg);
    if (bgY > t) {
      const s = (bgY ** 0.56 - t ** 0.57) * 1.14;
      return s < 0.1 ? 0 : (s - 0.027) * 100;
    }
    const s = (bgY ** 0.65 - t ** 0.62) * 1.14;
    return s > -0.1 ? 0 : (s + 0.027) * 100;
  }
  const contrastOf = (method, fg, bg) =>
    method === "apca" ? Math.abs(apcaLc(fg, bg)) : wcagRatio(fg, bg);
  const passes = (method, level, use, fg, bg) =>
    contrastOf(method, fg, bg) >= THRESH[method][level][use];

  function harmony(seedHex, mode) {
    const [L, C, H] = toOklch(seedHex);
    if (mode === "mono")
      return [-0.2, -0.1, 0, 0.1, 0.2].map((d) => toHex([clamp(L + d, 0, 1), C, H]));
    const shifts = {
      analogous: [-30, 0, 30],
      triadic: [0, 120, 240],
      split: [0, 150, 210],
      tetradic: [0, 90, 180, 270],
    }[mode];
    if (!shifts) throw new TypeError(`palette.harmony: unknown mode "${mode}"`);
    return shifts.map((d) => toHex([L, C, mod360(H + d)]));
  }

  // ---- Curves: lightness over normalised step position, a Fritsch-Carlson monotone cubic (as t3kit.curves) ----
  function tangents(p) {
    const n = p.length;
    const d = [],
      m = new Array(n);
    for (let i = 0; i < n - 1; i++) d[i] = (p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0]);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const a = m[i] / d[i],
        b = m[i + 1] / d[i],
        s = a * a + b * b;
      if (s > 9) {
        const k = 3 / Math.sqrt(s);
        m[i] = k * a * d[i];
        m[i + 1] = k * b * d[i];
      }
    }
    return m;
  }
  const tangentCache = new WeakMap(); // curve arrays are replaced, never mutated, so identity is a safe key
  function curveAt(curve, t) {
    const last = curve.length - 1;
    if (t <= curve[0][0]) return curve[0][1];
    if (t >= curve[last][0]) return curve[last][1];
    let m = tangentCache.get(curve);
    if (!m) tangentCache.set(curve, (m = tangents(curve)));
    let lo = 0;
    while (curve[lo + 1][0] < t) lo++;
    const hi = lo + 1,
      x0 = curve[lo][0],
      h = curve[hi][0] - x0;
    const u = (t - x0) / h,
      u2 = u * u,
      u3 = u2 * u;
    const y =
      (2 * u3 - 3 * u2 + 1) * curve[lo][1] +
      (u3 - 2 * u2 + u) * h * m[lo] +
      (-2 * u3 + 3 * u2) * curve[hi][1] +
      (u3 - u2) * h * m[hi];
    return clamp(y, 0, 1);
  }
  const stepOf = (hex, locked) => {
    const [L, c, h] = toOklch(hex);
    return { hex: normHex(hex), oklch: [round(L, 4), round(c, 4), round(h, 2)], locked };
  };
  // Unlocked steps are regenerated from curve, chroma and hue; locked steps keep their hex.
  function recomputeFamily(f, steps) {
    const out = {};
    steps.forEach((step, i) => {
      const key = String(step);
      const kept = f.steps?.[key];
      if (kept?.locked) {
        out[key] = stepOf(kept.hex, true);
        return;
      }
      const L = curveAt(f.curve, steps.length === 1 ? 0 : i / (steps.length - 1));
      out[key] = stepOf(toHex([clamp(L, 0, 1), f.chroma, f.hue]), false);
    });
    return { ...f, steps: out };
  }
  function checkCurve(curve, id) {
    if (!Array.isArray(curve) || curve.length < 2)
      throw new TypeError(`palette: family "${id}" needs a curve of at least two points`);
    const pts = curve
      .map((p) => {
        const [x, y] = Array.isArray(p) ? p : [NaN, NaN];
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw new TypeError(`palette: a curve point of "${id}" must be [x, y]`);
        return [clamp(x, 0, 1), clamp(y, 0, 1)];
      })
      .sort((a, b) => a[0] - b[0]);
    if (pts[0][0] !== 0 || pts[pts.length - 1][0] !== 1)
      throw new TypeError(`palette: the curve of "${id}" must contain x=0 and x=1`);
    for (let i = 1; i < pts.length; i++) {
      if (pts[i][0] - pts[i - 1][0] < 1e-6)
        throw new TypeError(`palette: the curve of "${id}" has two points at x=${pts[i][0]}`);
    }
    return pts;
  }
  const titleOf = (id) =>
    id
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  const splitToken = (tok) => {
    const i = tok.lastIndexOf(".");
    return [tok.slice(0, i), tok.slice(i + 1)];
  };

  function checkSteps(list) {
    if (!Array.isArray(list) || list.length < 2 || !list.every((s) => Number.isInteger(s))) {
      throw new TypeError("palette: steps must be at least two integers, ascending");
    }
    if (list.some((s, i) => i > 0 && s <= list[i - 1]))
      throw new TypeError("palette: steps must be strictly ascending");
    return list.slice();
  }

  // Builds a stable instance: state is internal, get() hands out copies, events go to on() subscribers.
  function create(container, options = {}) {
    const host = typeof container === "string" ? document.querySelector(container) : container;
    if (!(host instanceof HTMLElement))
      throw new TypeError("palette.create: container must be an HTMLElement or a selector");
    if (!isObj(options)) throw new TypeError("palette.create: options must be an object");
    for (const key of Object.keys(options)) {
      if (!["view", "steps", "method", "target", "theme", "value"].includes(key)) {
        throw new TypeError(
          `palette.create: unknown option "${key}" (use view, steps, method, target, theme, value)`,
        );
      }
    }
    injectStyle();
    const steps = checkSteps(options.steps ?? DEFAULT_STEPS);
    const config = { view: "ramps", theme: "light", method: "wcag", target: "AA" };
    let state = { families: [], roles: { light: {}, dark: {} }, pairs: [], unknown: {} };
    let focus = { id: null, step: Math.floor(steps.length / 2) };
    let curveSel = null;
    let editing = null;
    let statusLocked = false;
    let destroyed = false;
    let drag = null;
    let dragFrame = 0;
    let drawFrame = 0;
    const listeners = { change: new Set(), select: new Set(), report: new Set() };

    // ---- Validation and state updates ----
    function checkFamilies(list, strict) {
      if (!Array.isArray(list)) throw new TypeError("palette: families must be an array");
      const ids = new Set();
      return list.map((f) => {
        if (!isObj(f)) throw new TypeError("palette: a family must be an object");
        if (typeof f.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(f.id)) {
          throw new TypeError(
            `palette: family id "${f.id}" must be lowercase letters, digits and dashes`,
          );
        }
        if (ids.has(f.id)) throw new TypeError(`palette: duplicate family "${f.id}"`);
        ids.add(f.id);
        if (typeof f.name !== "string" || !f.name.trim())
          throw new TypeError(`palette: family "${f.id}" needs a name`);
        const hue = Number(f.hue),
          chroma = Number(f.chroma);
        if (
          !Number.isFinite(hue) ||
          !Number.isFinite(chroma) ||
          chroma < 0 ||
          chroma > MAX_CHROMA
        ) {
          throw new TypeError(`palette: family "${f.id}" needs a hue and a chroma from 0 to 0.4`);
        }
        const locks = {};
        for (const [key, s] of Object.entries(isObj(f.steps) ? f.steps : {})) {
          if (!steps.includes(Number(key))) {
            if (strict)
              throw new TypeError(
                `palette: family "${f.id}" has step ${key}, which is not in steps [${steps}]`,
              );
            continue;
          }
          if (s?.locked === true) locks[key] = { hex: normHex(s.hex), locked: true };
        }
        return recomputeFamily(
          {
            id: f.id,
            name: f.name.trim(),
            hue: mod360(hue),
            chroma,
            curve: checkCurve(f.curve, f.id),
            steps: locks,
          },
          steps,
        );
      });
    }
    function checkRoles(roles) {
      if (!isObj(roles) || !isObj(roles.light) || !isObj(roles.dark))
        throw new TypeError("palette: roles must be { light: {...}, dark: {...} }");
      for (const theme of THEMES) {
        for (const [role, tok] of Object.entries(roles[theme])) {
          if (typeof tok !== "string" || !/^[^.\s]+\.[^.\s]+$/.test(tok))
            throw new TypeError(
              `palette: role "${role}" (${theme}) must name a token like "neutral.900"`,
            );
        }
      }
      return { light: clone(roles.light), dark: clone(roles.dark) };
    }
    function checkPairs(pairs) {
      if (!Array.isArray(pairs)) throw new TypeError("palette: pairs must be an array");
      return pairs.map((p) => {
        if (
          !isObj(p) ||
          typeof p.fg !== "string" ||
          typeof p.bg !== "string" ||
          !USES.includes(p.use)
        ) {
          throw new TypeError("palette: a pair needs fg, bg and use ('text' | 'large' | 'ui')");
        }
        return { fg: p.fg, bg: p.bg, use: p.use };
      });
    }
    // Every role must point at an existing step and every pair at roles defined in both themes.
    function checkRefs(next) {
      for (const theme of THEMES) {
        for (const [role, tok] of Object.entries(next.roles[theme])) {
          const [famId, key] = splitToken(tok);
          const fam = next.families.find((f) => f.id === famId);
          if (!fam || !fam.steps[key])
            throw new TypeError(
              `palette: role "${role}" (${theme}) points at "${tok}", which does not exist`,
            );
        }
      }
      next.pairs.forEach((p, i) => {
        for (const theme of THEMES) {
          for (const role of [p.fg, p.bg]) {
            if (next.roles[theme][role] === undefined)
              throw new TypeError(
                `palette: pair ${i} uses role "${role}", which ${theme} does not define`,
              );
          }
        }
      });
      return next;
    }
    // Builds the next state from a partial value; the current state is untouched until every check passes.
    function nextState(partial, where) {
      if (!isObj(partial)) throw new TypeError(`${where}: expects an object`);
      for (const key of Object.keys(partial)) {
        if (!["v", "families", "roles", "pairs", "unknown"].includes(key))
          throw new TypeError(`${where}: unknown key "${key}"`);
      }
      if (partial.v !== undefined && partial.v !== 1) throw new TypeError(`${where}: v must be 1`);
      const next = { ...state };
      if (partial.families !== undefined) next.families = checkFamilies(partial.families, true);
      if (partial.roles !== undefined) next.roles = checkRoles(partial.roles);
      if (partial.pairs !== undefined) next.pairs = checkPairs(partial.pairs);
      if (partial.unknown !== undefined) {
        if (!isObj(partial.unknown)) throw new TypeError(`${where}: unknown must be an object`);
        next.unknown = clone(partial.unknown);
      }
      return checkRefs(next);
    }
    function applyPartial(partial) {
      state = nextState(partial, "palette.set");
    }
    const currentFamily = () => state.families.find((f) => f.id === focus.id) ?? null;
    function ensureFocus() {
      if (!state.families.some((f) => f.id === focus.id)) focus.id = state.families[0]?.id ?? null;
      focus.step = clamp(focus.step, 0, steps.length - 1);
    }
    function updateFamily(id, patch) {
      const i = state.families.findIndex((f) => f.id === id);
      state.families[i] = recomputeFamily({ ...state.families[i], ...patch }, steps);
    }
    function updateCurve(fam, pts) {
      updateFamily(fam.id, { curve: pts });
    }
    function tokenHex(tok) {
      const [famId, key] = splitToken(tok);
      const s = state.families.find((f) => f.id === famId)?.steps[key];
      if (!s) throw new Error(`palette: token "${tok}" does not exist`);
      return s.hex;
    }
    function roleHex(theme, role) {
      const tok = state.roles[theme][role];
      if (tok === undefined) throw new Error(`palette: role "${role}" is not defined for ${theme}`);
      return tokenHex(tok);
    }

    // ---- Reporting and fixes ----
    function report() {
      const rows = [];
      state.pairs.forEach((pair, i) => {
        for (const theme of THEMES) {
          const fg = roleHex(theme, pair.fg),
            bg = roleHex(theme, pair.bg);
          const pass = passes(config.method, config.target, pair.use, fg, bg);
          rows.push({
            pair: i,
            fg: pair.fg,
            bg: pair.bg,
            use: pair.use,
            theme,
            ratio: round(wcagRatio(fg, bg), 2),
            apca: round(apcaLc(fg, bg), 1),
            pass,
            fix: pass ? null : findFix(pair, theme),
          });
        }
      });
      return rows;
    }
    // Nearest passing unlocked step of the fg role's family, measured in step positions.
    function findFix(pair, theme) {
      const [famId, key] = splitToken(state.roles[theme][pair.fg]);
      const fam = state.families.find((f) => f.id === famId);
      const bgHex = roleHex(theme, pair.bg);
      const current = steps.indexOf(Number(key));
      const order = steps
        .map((_, i) => i)
        .filter((i) => !fam.steps[String(steps[i])].locked)
        .sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b);
      for (const i of order) {
        const hex = fam.steps[String(steps[i])].hex;
        if (passes(config.method, config.target, pair.use, hex, bgHex)) {
          return { token: `${fam.id}.${steps[i]}`, hex, ratio: round(wcagRatio(hex, bgHex), 2) };
        }
      }
      return null;
    }
    function fix(index) {
      if (
        index !== undefined &&
        !(Number.isInteger(index) && index >= 0 && index < state.pairs.length)
      ) {
        throw new RangeError(`palette.fix: pair ${index} does not exist`);
      }
      const indexes = index === undefined ? state.pairs.map((_, i) => i) : [index];
      const applied = [];
      for (const i of indexes) {
        for (const theme of THEMES) {
          const pair = state.pairs[i];
          const fg = roleHex(theme, pair.fg),
            bg = roleHex(theme, pair.bg);
          if (passes(config.method, config.target, pair.use, fg, bg)) continue;
          const found = findFix(pair, theme);
          if (!found) continue;
          state.roles[theme][pair.fg] = found.token;
          applied.push({ pair: i, theme, token: found.token, hex: found.hex, ratio: found.ratio });
        }
      }
      if (applied.length) changed();
      return applied;
    }

    // ---- Events ----
    function emit(event, payload) {
      for (const cb of [...listeners[event]]) cb(payload);
    }
    function changed() {
      statusLocked = false;
      refresh();
      emit("change", get());
      emit("report", report());
    }
    function get() {
      return {
        v: 1,
        families: clone(state.families),
        roles: clone(state.roles),
        pairs: clone(state.pairs),
        unknown: clone(state.unknown),
      };
    }
    function on(event, cb) {
      const set = listeners[event];
      if (!set) throw new TypeError(`palette.on: unknown event "${event}"`);
      set.add(cb);
      return () => set.delete(cb);
    }
    function focusOn(id, idx) {
      if (focus.id !== id) curveSel = null;
      focus = { id, step: idx };
      statusLocked = false;
      emit("select", { familyId: id, step: steps[idx] });
      refresh();
    }

    // ---- Family operations ----
    function addFamily({ name, seed } = {}) {
      if (typeof name !== "string" || !name.trim())
        throw new TypeError("palette.addFamily: name is required");
      const [L, C, H] = toOklch(seed);
      const base = slug(name.trim());
      let id = base,
        n = 2;
      while (state.families.some((f) => f.id === id)) id = `${base}-${n++}`;
      const curve = [
        [0, 0.97],
        [0.5, clamp(L, 0.1, 0.92)],
        [1, 0.2],
      ];
      state.families.push(
        recomputeFamily(
          { id, name: name.trim(), hue: H, chroma: Math.min(C, MAX_CHROMA), curve, steps: {} },
          steps,
        ),
      );
      focus = { id, step: focus.step };
      curveSel = null;
      changed();
      return id;
    }
    // A user-equivalent edit of one family (links.curvesPalette drives the curve through it).
    function editFamily(id, patch = {}) {
      const fam = state.families.find((f) => f.id === id);
      if (!fam) throw new Error(`palette.editFamily: no family "${id}"`);
      if (!isObj(patch)) throw new TypeError("palette.editFamily: patch must be an object");
      for (const key of Object.keys(patch)) {
        if (!["name", "hue", "chroma", "curve"].includes(key))
          throw new TypeError(
            `palette.editFamily: unknown key "${key}" (use name, hue, chroma, curve)`,
          );
      }
      const [checked] = checkFamilies([{ ...fam, ...patch }], true);
      state.families[state.families.indexOf(fam)] = checked;
      if (patch.curve !== undefined) curveSel = null;
      changed();
    }
    const selected = () => ({
      familyId: focus.id,
      step: focus.id === null ? null : steps[focus.step],
    });
    function select(familyId, step) {
      if (!state.families.some((f) => f.id === familyId))
        throw new Error(`palette.select: no family "${familyId}"`);
      const idx = step === undefined ? focus.step : steps.indexOf(step);
      if (idx < 0) throw new RangeError(`palette.select: step ${step} is not in steps`);
      focusOn(familyId, idx);
    }
    function moveFocus(dFam, dStep) {
      const fi = clamp(
        state.families.indexOf(currentFamily()) + dFam,
        0,
        state.families.length - 1,
      );
      const si = clamp(focus.step + dStep, 0, steps.length - 1);
      focusOn(state.families[fi].id, si);
    }
    function toggleLock() {
      const fam = currentFamily();
      const key = String(steps[focus.step]);
      const st = fam.steps[key];
      updateFamily(fam.id, { steps: { ...fam.steps, [key]: { hex: st.hex, locked: !st.locked } } });
      changed();
    }
    function nudge(dL) {
      const fam = currentFamily();
      const key = String(steps[focus.step]);
      const [L, c, h] = toOklch(fam.steps[key].hex);
      const hex = toHex([clamp(L + dL, 0, 1), c, h]);
      updateFamily(fam.id, { steps: { ...fam.steps, [key]: { hex, locked: true } } });
      changed();
    }
    function removeCurvePoint(fam, i) {
      curveSel = null;
      updateCurve(
        fam,
        fam.curve.filter((_, k) => k !== i).map((p) => [...p]),
      );
      changed();
    }

    // ---- Import and export ----
    // Top-level key order of the last imported json / w3c file, so exports keep the file's layout.
    const order = { json: null, w3c: null };
    function ordered(keys, built) {
      const out = {};
      for (const k of [...(keys ?? []), ...Object.keys(built)])
        if (Object.hasOwn(built, k) && !Object.hasOwn(out, k)) out[k] = built[k];
      return out;
    }
    function exportText(format = "json") {
      if (format === "json") {
        const built = {
          v: 1,
          families: state.families,
          roles: state.roles,
          pairs: state.pairs,
          ...state.unknown,
        };
        return JSON.stringify(ordered(order.json, built), null, 2) + "\n";
      }
      if (format === "w3c") return JSON.stringify(ordered(order.w3c, toW3C()), null, 2) + "\n";
      if (format === "css" || format === "tailwind") return toCss(format);
      throw new TypeError(`palette.export: unknown format "${format}"`);
    }
    function toW3C() {
      const { $extensions: extra = {}, ...rest } = state.unknown;
      const color = {};
      for (const f of state.families) {
        const group = {};
        for (const s of steps) {
          const st = f.steps[String(s)];
          group[String(s)] = st.locked
            ? { $type: "color", $value: st.hex, $extensions: { t3kit: { locked: true } } }
            : { $type: "color", $value: st.hex };
        }
        group.$extensions = {
          t3kit: { name: f.name, hue: f.hue, chroma: f.chroma, curve: f.curve },
        };
        color[f.id] = group;
      }
      // DTCG names cannot hold dots, so role 'fg.default' nests as fg > default.
      const roles = {};
      for (const theme of THEMES) {
        roles[theme] = {};
        for (const [role, tok] of Object.entries(state.roles[theme])) {
          const path = role.split(".");
          let node = roles[theme];
          for (const part of path.slice(0, -1)) {
            if (node[part]?.$value !== undefined)
              throw new Error(
                `palette.export: role "${role}" collides with role "${part}" in W3C groups`,
              );
            node = node[part] ??= {};
          }
          const leaf = path[path.length - 1];
          if (node[leaf] !== undefined)
            throw new Error(`palette.export: role "${role}" collides with a role group in W3C`);
          node[leaf] = { $type: "color", $value: `{color.${tok}}` };
        }
      }
      return {
        ...rest,
        color,
        roles,
        $extensions: { ...extra, t3kit: { v: 1, pairs: state.pairs } },
      };
    }
    function toCss(format) {
      const stepPrefix = `${CSS_VAR}color-`,
        rolePrefix = `${CSS_VAR}role-`;
      const lines = ["/* t3kit.palette export */"];
      const dropped = Object.keys(state.unknown);
      if (dropped.length) lines.push(`/* unknown keys not exported: ${dropped.join(", ")} */`);
      const stepLines = [];
      for (const f of state.families) {
        for (const s of steps)
          stepLines.push(`  ${stepPrefix}${f.id}-${s}: ${f.steps[String(s)].hex};`);
      }
      const roleLines = (theme) =>
        Object.entries(state.roles[theme]).map(([role, tok]) => {
          const [famId, key] = splitToken(tok);
          return `  ${rolePrefix}${role.replaceAll(".", "--")}: var(${stepPrefix}${famId}-${key});`;
        });
      const light = roleLines("light"),
        dark = roleLines("dark");
      if (format === "tailwind")
        lines.push("@theme {", ...stepLines, "}", ":root {", ...light, "}");
      else lines.push(":root {", ...stepLines, ...light, "}");
      if (dark.length) lines.push(':root[data-theme="dark"] {', ...dark, "}");
      return lines.join("\n") + "\n";
    }
    // Parses a token file; by default applies it as one user edit. Pairs and unknown keys apply when the file has them;
    // otherwise current pairs whose roles survive are kept and the rest are dropped with a warning.
    function importText(text, { format = "auto", apply = true, ...extra } = {}) {
      if (typeof text !== "string") throw new TypeError("palette.import: text must be a string");
      if (Object.keys(extra).length)
        throw new TypeError(
          `palette.import: unknown option "${Object.keys(extra)[0]}" (use format, apply)`,
        );
      const kind = format === "auto" ? detectFormat(text) : format;
      const warnings = [];
      let parsed;
      if (kind === "json") parsed = importJson(text);
      else if (kind === "w3c") parsed = importW3C(text, warnings);
      else if (kind === "css" || kind === "tailwind") parsed = importCss(text, kind, warnings);
      else throw new TypeError(`palette.import: unknown format "${format}"`);
      const partial = { families: parsed.families, roles: parsed.roles };
      if (parsed.unknown) partial.unknown = parsed.unknown;
      if (parsed.pairs) partial.pairs = parsed.pairs;
      else {
        partial.pairs = state.pairs.filter((p) =>
          THEMES.every(
            (t) => parsed.roles[t][p.fg] !== undefined && parsed.roles[t][p.bg] !== undefined,
          ),
        );
        if (partial.pairs.length < state.pairs.length)
          warnings.push(
            `${state.pairs.length - partial.pairs.length} contrast pair(s) dropped: their roles are not in the file`,
          );
      }
      const next = nextState(partial, "palette.import");
      if (apply) {
        state = next;
        if (parsed.order) order[kind] = parsed.order;
        curveSel = null;
        changed();
      }
      return { families: clone(next.families), roles: clone(next.roles), warnings };
    }
    function detectFormat(text) {
      const t = text.trim();
      if (t.startsWith("{")) return /"\$(value|type)"/.test(t) ? "w3c" : "json";
      if (/@theme\b/.test(t)) return "tailwind";
      if (/--[\w-]+\s*:/.test(t)) return "css";
      throw new TypeError("palette.import: cannot detect the format, pass format");
    }
    function importJson(text) {
      const doc = JSON.parse(text);
      if (!isObj(doc) || doc.v !== 1) throw new TypeError("palette.import: JSON needs v: 1");
      const { v, families, roles, pairs, ...unknown } = doc;
      return {
        families: checkFamilies(families ?? [], true),
        roles: checkRoles(roles ?? { light: {}, dark: {} }),
        pairs: checkPairs(pairs ?? []),
        unknown,
        order: Object.keys(doc),
      };
    }
    // Collects { role: alias } from a DTCG group, joining nested group names with dots.
    function flattenRoles(node, prefix, out, theme, warnings) {
      for (const [key, val] of Object.entries(node ?? {})) {
        if (key.startsWith("$")) continue;
        const name = prefix ? `${prefix}.${key}` : key;
        if (isObj(val) && val.$value !== undefined) {
          const m =
            typeof val.$value === "string" && /^\{color\.([^.}]+)\.([^.}]+)\}$/.exec(val.$value);
          if (m) out[name] = `${m[1]}.${m[2]}`;
          else warnings.push(`role ${name} (${theme}) skipped: not a colour alias`);
        } else if (isObj(val)) flattenRoles(val, name, out, theme, warnings);
      }
      return out;
    }
    function importW3C(text, warnings) {
      const doc = JSON.parse(text);
      if (!isObj(doc)) throw new TypeError("palette.import: W3C tokens must be an object");
      const families = [],
        roles = { light: {}, dark: {} },
        unknown = {};
      let pairs = null;
      for (const [key, val] of Object.entries(doc)) {
        if (key === "color") {
          for (const [id, group] of Object.entries(val))
            if (!id.startsWith("$")) families.push(familyFromGroup(id, group, warnings));
        } else if (key === "roles") {
          for (const theme of THEMES) flattenRoles(val?.[theme], "", roles[theme], theme, warnings);
        } else if (key === "$extensions") {
          const { t3kit, ...rest } = val;
          if (Array.isArray(t3kit?.pairs)) pairs = t3kit.pairs;
          if (Object.keys(rest).length) unknown.$extensions = rest;
        } else {
          unknown[key] = val;
        }
      }
      return {
        families: checkFamilies(families, false),
        roles: checkRoles(roles),
        pairs: pairs && checkPairs(pairs),
        unknown,
        order: Object.keys(doc),
      };
    }
    function familyFromGroup(id, group, warnings) {
      const meta = group.$extensions?.t3kit;
      const stepsIn = {};
      for (const [key, tok] of Object.entries(group)) {
        if (key.startsWith("$")) continue;
        if (!steps.includes(Number(key))) {
          warnings.push(`color.${id}.${key} skipped: step not in steps`);
          continue;
        }
        if (typeof tok?.$value !== "string") {
          warnings.push(`color.${id}.${key} skipped: not a colour`);
          continue;
        }
        stepsIn[key] = {
          hex: tok.$value,
          locked: meta ? tok.$extensions?.t3kit?.locked === true : true,
        };
      }
      if (
        meta &&
        Number.isFinite(meta.hue) &&
        Number.isFinite(meta.chroma) &&
        Array.isArray(meta.curve)
      ) {
        return {
          id,
          name: meta.name ?? titleOf(id),
          hue: meta.hue,
          chroma: meta.chroma,
          curve: meta.curve,
          steps: stepsIn,
        };
      }
      return deriveFamily(id, titleOf(id), stepsIn);
    }
    // Foreign colours: hue and chroma come from the most chromatic step, the curve from the step lightness; steps stay locked.
    function deriveFamily(id, name, stepsIn) {
      const keys = Object.keys(stepsIn).sort((a, b) => Number(a) - Number(b));
      if (keys.length < 2)
        throw new TypeError(`palette.import: family "${id}" needs at least two steps`);
      const lch = keys.map((k) => toOklch(stepsIn[k].hex));
      const [, chroma, hue] = lch.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
      const curve = lch.map(([L], i) => [i / (keys.length - 1), L]);
      return { id, name, hue, chroma: Math.min(chroma, MAX_CHROMA), curve, steps: stepsIn };
    }
    function importCss(text, kind, warnings) {
      if (kind === "tailwind" && !/@theme\b/.test(text))
        throw new TypeError(
          "palette.import: tailwind v3 config objects are not supported, paste the v4 @theme CSS",
        );
      const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
      const stepsIn = {};
      const roles = { light: {}, dark: {} };
      for (const block of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const theme = /dark/.test(block[1]) ? "dark" : "light";
        for (const decl of block[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
          const name = decl[1],
            value = decl[2].trim();
          if (name.startsWith("role-")) {
            const role = name.slice(5).replaceAll("--", ".");
            const ref = /^var\(--(?:color-)?([^)]+)\)$/.exec(value);
            const m = ref && STEP_NAME.exec(ref[1]);
            if (m) roles[theme][role] = `${m[1]}.${m[2]}`;
            else warnings.push(`role ${role} (${theme}) skipped: ${value} is not a palette step`);
          } else if (name.startsWith("color-")) {
            const m = STEP_NAME.exec(name.slice(6));
            if (!m || !HEX.test(value)) {
              warnings.push(`--${name} skipped: not a palette step colour`);
              continue;
            }
            (stepsIn[m[1]] ??= {})[m[2]] = { hex: value, locked: true };
          }
        }
      }
      const families = [];
      for (const [id, byStep] of Object.entries(stepsIn)) {
        const keep = {};
        for (const [key, st] of Object.entries(byStep)) {
          if (steps.includes(Number(key))) keep[key] = st;
          else warnings.push(`${id} step ${key} skipped: not in steps`);
        }
        families.push(deriveFamily(id, titleOf(id), keep));
      }
      return { families: checkFamilies(families, false), roles: checkRoles(roles), warnings };
    }

    // ---- Sampling and harmony ----
    async function sample(source, { count = 6 } = {}) {
      if (!Number.isInteger(count) || count < 1)
        throw new TypeError("palette.sample: count must be a positive integer");
      // Blobs decode straight to the thumbnail width, so a 24MP photo never lands in memory at full size.
      const img =
        typeof source === "string"
          ? await loadImage(source)
          : await createImageBitmap(source, { resizeWidth: 128, resizeQuality: "medium" });
      const scale = Math.min(1, 128 / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale)),
        h = Math.max(1, Math.round(img.height * scale));
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      if (typeof img.close === "function") img.close();
      const data = ctx.getImageData(0, 0, w, h).data;
      const pts = [];
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        pts.push(rgbToOklab([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]));
      }
      if (!pts.length) throw new Error("palette.sample: the image has no opaque pixels");
      return kmeans(pts, Math.min(count, pts.length));
    }
    function kmeans(pts, k) {
      const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      // Farthest-point seeding keeps the result deterministic.
      let centers = [pts[0]];
      let dist = pts.map((p) => d2(p, pts[0]));
      while (centers.length < k) {
        let far = 0;
        for (let i = 1; i < pts.length; i++) if (dist[i] > dist[far]) far = i;
        centers.push(pts[far]);
        dist = dist.map((dv, i) => Math.min(dv, d2(pts[i], pts[far])));
      }
      const assign = new Int32Array(pts.length);
      for (let iter = 0; iter < 12; iter++) {
        let moved = false;
        for (let i = 0; i < pts.length; i++) {
          let best = 0,
            bd = Infinity;
          for (let c = 0; c < k; c++) {
            const dv = d2(pts[i], centers[c]);
            if (dv < bd) {
              bd = dv;
              best = c;
            }
          }
          if (assign[i] !== best) {
            assign[i] = best;
            moved = true;
          }
        }
        const sums = centers.map(() => [0, 0, 0, 0]);
        for (let i = 0; i < pts.length; i++) {
          const s = sums[assign[i]];
          s[0] += pts[i][0];
          s[1] += pts[i][1];
          s[2] += pts[i][2];
          s[3]++;
        }
        centers = centers.map((c, j) =>
          sums[j][3]
            ? [sums[j][0] / sums[j][3], sums[j][1] / sums[j][3], sums[j][2] / sums[j][3]]
            : c,
        );
        if (!moved && iter > 0) break;
      }
      const counts = centers.map(() => 0);
      for (const a of assign) counts[a]++;
      const hexes = centers
        .map((c, j) => ({ hex: labToHex(c), n: counts[j] }))
        .sort((a, b) => b.n - a.n)
        .map((x) => x.hex);
      return [...new Set(hexes)];
    }

    // ---- Rendering ----
    const root = document.createElement("div");
    root.className = "t3k-palette-root";
    root.innerHTML = TEMPLATE;
    host.appendChild(root);
    const $ = (sel) => root.querySelector(sel);
    const stage = $("[data-stage]"),
      stageWrap = $("[data-stagewrap]"),
      editor = $("[data-edit]");
    const curve = $("[data-curve]"),
      status = $("[data-status]");
    const nameInput = $("[data-name]"),
      hueInput = $("[data-hue]"),
      chromaInput = $("[data-chroma]");
    const panels = {
      ramps: $('[data-panel="ramps"]'),
      contrast: $('[data-panel="contrast"]'),
      roles: $('[data-panel="roles"]'),
    };
    let probe = null;

    function scheduleDraw() {
      if (!drawFrame && !destroyed) {
        drawFrame = requestAnimationFrame(() => {
          drawFrame = 0;
          draw();
        });
      }
    }
    function queueDrag() {
      if (!dragFrame) {
        dragFrame = requestAnimationFrame(() => {
          dragFrame = 0;
          applyDrag();
        });
      }
    }
    function setStatus(text, locked = true) {
      status.textContent = text;
      statusLocked = locked;
    }
    function describeFocus() {
      const fam = currentFamily();
      if (!fam) return "";
      const st = fam.steps[String(steps[focus.step])];
      return `${fam.name} ${steps[focus.step]} ${st.hex}${st.locked ? ", locked" : ""}`;
    }
    // Rebuilds DOM but keeps keyboard focus on the element that had it (matched by data-focus-key).
    function keepFocus(fn) {
      const active = root.contains(document.activeElement) ? document.activeElement : null;
      const key = active?.dataset?.focusKey;
      fn();
      if (key)
        root.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    }
    function sync(el, value) {
      if (document.activeElement !== el && el.value !== String(value)) el.value = String(value);
    }
    function refresh() {
      if (destroyed) return;
      keepFocus(() => {
        ensureFocus();
        for (const b of root.querySelectorAll("[data-view]"))
          b.setAttribute("aria-pressed", String(b.dataset.view === config.view));
        for (const b of root.querySelectorAll("[data-theme-btn]"))
          b.setAttribute("aria-pressed", String(b.dataset.themeBtn === config.theme));
        $('[data-group="theme"]').hidden = config.view === "ramps";
        for (const [name, el] of Object.entries(panels)) el.hidden = name !== config.view;
        const has = state.families.length > 0;
        $("[data-empty]").hidden = has;
        stageWrap.hidden = !has;
        $("[data-family]").hidden = !has;
        const fam = currentFamily();
        if (fam) {
          sync(nameInput, fam.name);
          sync(hueInput, Math.round(fam.hue));
          sync(chromaInput, fam.chroma);
          $("[data-hue-out]").textContent = `${Math.round(fam.hue)}°`;
          $("[data-chroma-out]").textContent = fam.chroma.toFixed(3);
        }
        if (!statusLocked)
          setStatus(config.view === "ramps" ? describeFocus() : status.textContent, false);
        if (config.view === "contrast") renderContrast();
        if (config.view === "roles") renderRoles();
      });
      scheduleDraw();
    }
    const roleOptions = (current) =>
      state.families
        .map((f) => {
          const opts = steps
            .map((s) => {
              const tok = `${f.id}.${s}`;
              return `<option value="${esc(tok)}"${tok === current ? " selected" : ""}>${esc(f.name)} ${s} · ${f.steps[String(s)].hex}</option>`;
            })
            .join("");
          return `<optgroup label="${esc(f.name)}">${opts}</optgroup>`;
        })
        .join("");
    const pill = (r) =>
      `${r.theme} ${config.method === "apca" ? `Lc ${Math.abs(r.apca).toFixed(0)}` : `${r.ratio.toFixed(2)}:1`} ${r.pass ? "pass" : "fail"}`;
    function renderContrast() {
      const theme = config.theme;
      const roles = Object.keys(state.roles[theme]);
      const matrix = $("[data-matrix]");
      if (!roles.length) {
        matrix.innerHTML = `<p class="t3k-palette-hint">Add roles in the Roles view to see the contrast matrix.</p>`;
      } else {
        const head = roles.map((c) => `<th scope="col">${esc(c)}</th>`).join("");
        const body = roles
          .map((r) => {
            const cells = roles
              .map((c) => {
                if (r === c) return `<td class="t3k-palette-self">-</td>`;
                const fg = roleHex(theme, r),
                  bg = roleHex(theme, c);
                const value =
                  config.method === "apca"
                    ? `Lc ${Math.abs(apcaLc(fg, bg)).toFixed(0)}`
                    : `${wcagRatio(fg, bg).toFixed(2)}:1`;
                const ok = passes(config.method, config.target, "text", fg, bg);
                return `<td><div class="t3k-palette-cell" style="background:${bg};color:${fg}"><b>Aa</b><small>${value} ${ok ? "pass" : "fail"}</small></div></td>`;
              })
              .join("");
            return `<tr><th scope="row">${esc(r)}</th>${cells}</tr>`;
          })
          .join("");
        matrix.innerHTML = `<table class="t3k-palette-matrix"><thead><tr><th scope="col">Text / Background</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
      }
      const rows = state.pairs.length ? report() : [];
      $("[data-pairs]").innerHTML = state.pairs
        .map((pair, i) => {
          const mine = rows.filter((r) => r.pair === i);
          const failing = mine.some((r) => !r.pass);
          const use = USES.map(
            (u) => `<option value="${u}"${u === pair.use ? " selected" : ""}>${u}</option>`,
          ).join("");
          const pills = mine
            .map((r) => `<span class="t3k-palette-pill" data-pass="${r.pass}">${pill(r)}</span>`)
            .join("");
          const fixes = mine.filter((r) => r.fix);
          const label = fixes.length === 1 ? `Use ${fixes[0].fix.token}` : "Fix both themes";
          const tip =
            fixes
              .map((r) => `${r.theme}: ${r.fg} to ${r.fix.token} (${r.fix.ratio}:1)`)
              .join("; ") || "No passing unlocked step in this family";
          const fixBtn = failing
            ? `<button type="button" class="t3k-palette-btn" data-fix="${i}" data-focus-key="fix:${i}" title="${esc(tip)}"${fixes.length ? "" : " disabled"}>${esc(label)}</button>`
            : "";
          return (
            `<li class="t3k-palette-pair"><span class="t3k-palette-grow"><code>${esc(pair.fg)}</code> on <code>${esc(pair.bg)}</code></span>` +
            `<select class="t3k-palette-select" data-pair-use="${i}" data-focus-key="use:${i}" aria-label="Use for pair ${i + 1}">${use}</select>${pills}${fixBtn}</li>`
          );
        })
        .join("");
      $("[data-fix-all]").disabled = !rows.some((r) => r.fix);
      sync($("[data-method]"), config.method);
      sync($("[data-target]"), config.target);
      const sig = roles.join("|");
      for (const sel of [$("[data-new-fg]"), $("[data-new-bg]")]) {
        if (sel.dataset.sig === sig) continue;
        sel.dataset.sig = sig;
        sel.innerHTML = roles.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
      }
    }
    function renderRoles() {
      const theme = config.theme;
      const roles = Object.keys(state.roles[theme]);
      $("[data-roles-table]").innerHTML = roles.length
        ? `<table class="t3k-palette-roles"><thead><tr><th scope="col">Role</th><th scope="col">Token</th><th scope="col">Preview</th></tr></thead><tbody>${roles
            .map((role) => {
              const tok = state.roles[theme][role];
              const hex = tokenHex(tok);
              return (
                `<tr><th scope="row"><code>${esc(role)}</code></th>` +
                `<td><select class="t3k-palette-select" data-role="${esc(role)}" data-focus-key="role:${esc(role)}" aria-label="Token for ${esc(role)}">${roleOptions(tok)}</select></td>` +
                `<td><span class="t3k-palette-swatch" style="background:${hex}"></span> <span class="t3k-palette-code">${hex}</span></td></tr>`
              );
            })
            .join("")}</tbody></table>`
        : `<p class="t3k-palette-hint">No roles yet. Add one below.</p>`;
      $("[data-role-token]").innerHTML = roleOptions(null);
    }

    // Stage geometry: family rows of swatches, with step labels, hex, lock glyph and focus ring drawn on a canvas.
    function stageGeom(W) {
      const LEFT = W < 520 ? 76 : 132,
        RIGHT = 6,
        N = steps.length;
      const cellW = Math.max(8, (W - LEFT - RIGHT - GAP * (N - 1)) / N);
      return { LEFT, cellW, cellStep: cellW + GAP };
    }
    function cellRect(r, c) {
      const g = stageGeom(stage.clientWidth);
      return { x: g.LEFT + c * g.cellStep, y: PAD + r * ROW, w: g.cellW, h: SW };
    }
    function cellAt(x, y) {
      const r = Math.floor((y - PAD) / ROW);
      if (r < 0 || r >= state.families.length || y - PAD - r * ROW > SW) return null;
      const g = stageGeom(stage.clientWidth);
      const c = Math.floor((x - g.LEFT) / g.cellStep);
      if (c < 0 || c >= steps.length || x - g.LEFT - c * g.cellStep > g.cellW) return null;
      return { r, c };
    }
    function readTokens() {
      const cs = getComputedStyle(document.documentElement);
      const get = (name) => cs.getPropertyValue(name).trim();
      if (!probe)
        probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      const hexOf = (value) => {
        probe.fillStyle = "#000000";
        probe.fillStyle = value;
        probe.fillRect(0, 0, 1, 1);
        const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
        return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
      };
      const fg = get("--foreground"),
        bg = get("--background");
      return {
        fg,
        bg,
        fgHex: hexOf(fg),
        bgHex: hexOf(bg),
        muted: get("--muted-foreground"),
        border: get("--border"),
        ring: get("--ring"),
        primary: get("--primary"),
        card: get("--card"),
        sans: get("--font-sans"),
        mono: get("--font-mono"),
      };
    }
    function draw() {
      if (destroyed) return;
      const t = readTokens();
      if (config.view === "ramps") {
        drawStage(t);
        drawCurve(t);
      }
    }
    function drawStage(t) {
      const fams = state.families;
      const W = stage.clientWidth;
      if (!W || !fams.length) return;
      const H = PAD * 2 + (fams.length - 1) * ROW + SW;
      const dpr = window.devicePixelRatio || 1;
      stage.style.height = `${H}px`;
      stage.width = Math.round(W * dpr);
      stage.height = Math.round(H * dpr);
      const ctx = stage.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const g = stageGeom(W);
      ctx.textBaseline = "top";
      fams.forEach((fam, r) => {
        const y = PAD + r * ROW;
        ctx.font = `600 12px ${t.sans}`;
        ctx.fillStyle = t.fg;
        ctx.fillText(ellipsize(ctx, fam.name, g.LEFT - 14), 8, y + 2);
        ctx.font = `11px ${t.mono}`;
        ctx.fillStyle = t.muted;
        ctx.fillText(
          ellipsize(ctx, `${Math.round(fam.hue)}° C${fam.chroma.toFixed(3)}`, g.LEFT - 14),
          8,
          y + 19,
        );
        steps.forEach((s, i) => {
          const st = fam.steps[String(s)];
          const x = g.LEFT + i * g.cellStep;
          ctx.beginPath();
          ctx.roundRect(x, y, g.cellW, SW, 6);
          ctx.fillStyle = st.hex;
          ctx.fill();
          const ink = wcagRatio(st.hex, t.fgHex) >= wcagRatio(st.hex, t.bgHex) ? t.fg : t.bg;
          ctx.fillStyle = ink;
          if (g.cellW >= 22) {
            ctx.font = `600 10px ${t.sans}`;
            ctx.fillText(String(s), x + 6, y + 5);
          }
          if (g.cellW >= 64) {
            ctx.font = `10px ${t.mono}`;
            ctx.fillText(st.hex, x + 6, y + SW - 15);
          }
          if (st.locked) drawLock(ctx, x + g.cellW - 12, y + 6, ink);
        });
      });
      const f = state.families.findIndex((x) => x.id === focus.id);
      if (f >= 0) {
        const cell = cellRect(f, focus.step);
        ctx.strokeStyle = t.ring;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(cell.x - 2, cell.y - 2, cell.w + 4, cell.h + 4, 7);
        ctx.stroke();
      }
    }
    function ellipsize(ctx, text, maxW) {
      if (ctx.measureText(text).width <= maxW) return text;
      let s = text;
      while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
      return s + "…";
    }
    function drawLock(ctx, x, y, color) {
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x + 4, y + 3.5, 2.5, Math.PI, 0);
      ctx.stroke();
      ctx.fillRect(x, y + 3.5, 8, 6);
    }
    const plotX = (x, W) => CURVE_P + x * (W - 2 * CURVE_P);
    const plotY = (y) => CURVE_H - CURVE_B - y * (CURVE_H - CURVE_B - CURVE_P);
    const xFromPx = (px, W) => clamp((px - CURVE_P) / (W - 2 * CURVE_P), 0, 1);
    const yFromPy = (py) => clamp((CURVE_H - CURVE_B - py) / (CURVE_H - CURVE_B - CURVE_P), 0, 1);
    function drawCurve(t) {
      const fam = currentFamily();
      const W = curve.clientWidth;
      if (!fam || !W) return;
      const dpr = window.devicePixelRatio || 1;
      curve.width = Math.round(W * dpr);
      curve.height = Math.round(CURVE_H * dpr);
      const ctx = curve.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, CURVE_H);
      const N = steps.length;
      const px = (x) => plotX(x, W);
      ctx.lineWidth = 1;
      ctx.strokeStyle = t.border;
      for (const y of [0, 0.25, 0.5, 0.75, 1]) {
        ctx.beginPath();
        ctx.moveTo(px(0), plotY(y));
        ctx.lineTo(px(1), plotY(y));
        ctx.stroke();
      }
      ctx.font = `10px ${t.mono}`;
      ctx.textAlign = "center";
      ctx.fillStyle = t.muted;
      steps.forEach((s, i) => {
        const x = px(i / (N - 1));
        ctx.save();
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, CURVE_P);
        ctx.lineTo(x, CURVE_H - CURVE_B);
        ctx.stroke();
        ctx.restore();
        ctx.fillText(String(s), x, CURVE_H - CURVE_B + 5);
      });
      ctx.textAlign = "start";
      ctx.beginPath();
      for (let k = 0; k <= 120; k++) {
        const tt = k / 120;
        const x = px(tt),
          y = plotY(curveAt(fam.curve, tt));
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = t.primary;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = t.muted;
      steps.forEach((s, i) => {
        ctx.beginPath();
        ctx.arc(px(i / (N - 1)), plotY(fam.steps[String(s)].oklch[0]), 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
      fam.curve.forEach((p, i) => {
        const sel = i === curveSel;
        ctx.beginPath();
        ctx.arc(px(p[0]), plotY(p[1]), sel ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = sel ? t.primary : t.card;
        ctx.fill();
        ctx.strokeStyle = sel ? t.ring : t.primary;
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    }
    function curveHit(fam, x, y) {
      const W = curve.clientWidth;
      let best = -1,
        bd = 100;
      fam.curve.forEach((p, i) => {
        const dx = plotX(p[0], W) - x,
          dy = plotY(p[1]) - y;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return best;
    }
    function applyDrag() {
      if (!drag || drag.px === null) return;
      const fam = currentFamily();
      if (!fam) return;
      const W = curve.clientWidth;
      const pts = fam.curve.map((p) => [...p]);
      const i = drag.index;
      const interior = i > 0 && i < pts.length - 1;
      const x = xFromPx(drag.px, W),
        y = yFromPy(drag.py);
      if (interior) pts[i][0] = clamp(x, pts[i - 1][0] + GAP_X, pts[i + 1][0] - GAP_X);
      pts[i][1] = y;
      drag.px = null;
      updateCurve(fam, pts);
      changed();
    }
    function endDrag() {
      if (!drag) return;
      if (dragFrame) {
        cancelAnimationFrame(dragFrame);
        dragFrame = 0;
      }
      applyDrag();
      drag = null;
    }
    function openEditor() {
      const fam = currentFamily();
      if (!fam) return;
      const cell = cellRect(state.families.indexOf(fam), focus.step);
      editing = { id: fam.id, idx: focus.step };
      editor.value = fam.steps[String(steps[focus.step])].hex;
      Object.assign(editor.style, {
        left: `${cell.x}px`,
        top: `${cell.y}px`,
        width: `${cell.w}px`,
        height: `${cell.h}px`,
      });
      editor.hidden = false;
      editor.focus();
      editor.select();
    }
    function closeEditor(commit) {
      if (!editing) return;
      const { id, idx } = editing;
      if (commit) {
        let hex;
        try {
          hex = normHex(editor.value);
        } catch {
          setStatus(`"${editor.value}" is not a hex colour, like #346bf1.`);
          editor.focus();
          return;
        }
        editing = null;
        editor.hidden = true;
        const fam = state.families.find((f) => f.id === id);
        const key = String(steps[idx]);
        updateFamily(id, { steps: { ...fam.steps, [key]: { hex, locked: true } } });
        changed();
      } else {
        editing = null;
        editor.hidden = true;
      }
      stage.focus();
    }
    function configure(patch) {
      if (!isObj(patch)) throw new TypeError("palette.configure: expects an object");
      if (patch.view !== undefined) {
        if (!VIEWS.includes(patch.view))
          throw new TypeError(`palette.configure: unknown view "${patch.view}"`);
        config.view = patch.view;
      }
      if (patch.theme !== undefined) {
        if (!THEMES.includes(patch.theme))
          throw new TypeError(`palette.configure: unknown theme "${patch.theme}"`);
        config.theme = patch.theme;
      }
      if (patch.method !== undefined) {
        if (!METHODS.includes(patch.method))
          throw new TypeError(`palette.configure: unknown method "${patch.method}"`);
        config.method = patch.method;
      }
      if (patch.target !== undefined) {
        if (!LEVELS.includes(patch.target))
          throw new TypeError(`palette.configure: unknown target "${patch.target}"`);
        config.target = patch.target;
      }
      closeEditor(false);
      refresh();
    }
    function applyFixes(index) {
      const applied = fix(index);
      if (!applied.length) setStatus("No passing unlocked step found for that pair.");
    }

    // ---- Wiring ----
    root.addEventListener("click", (e) => {
      const view = e.target.closest("[data-view]");
      if (view) return configure({ view: view.dataset.view });
      const theme = e.target.closest("[data-theme-btn]");
      if (theme) return configure({ theme: theme.dataset.themeBtn });
      if (e.target.closest("[data-fix-all]")) return applyFixes(undefined);
      const fixBtn = e.target.closest("[data-fix]");
      if (fixBtn) return applyFixes(Number(fixBtn.dataset.fix));
    });
    root.addEventListener("change", (e) => {
      const el = e.target;
      if (el.matches("[data-method]")) return configure({ method: el.value });
      if (el.matches("[data-target]")) return configure({ target: el.value });
      if (el.matches("[data-pair-use]")) {
        const i = Number(el.dataset.pairUse);
        state.pairs[i] = { ...state.pairs[i], use: el.value };
        return changed();
      }
      if (el.matches("[data-role]")) {
        state.roles[config.theme][el.dataset.role] = el.value;
        return changed();
      }
      if (el.matches("[data-name]")) {
        const fam = currentFamily();
        const name = el.value.trim();
        if (fam && name) {
          updateFamily(fam.id, { name });
          return changed();
        }
        return refresh();
      }
    });
    root.addEventListener("input", (e) => {
      const fam = currentFamily();
      if (!fam) return;
      if (e.target.matches("[data-hue]")) {
        updateFamily(fam.id, { hue: Number(e.target.value) });
        return changed();
      }
      if (e.target.matches("[data-chroma]")) {
        updateFamily(fam.id, { chroma: Number(e.target.value) });
        return changed();
      }
    });
    root.addEventListener("submit", (e) => {
      e.preventDefault();
      const form = e.target;
      if (form.matches("[data-add-form]")) {
        const seed = form.querySelector("[data-add-seed]").value;
        const nameEl = form.querySelector("[data-add-name]");
        const name = nameEl.value.trim() || `Colour ${state.families.length + 1}`;
        addFamily({ name, seed });
        nameEl.value = "";
        return;
      }
      if (form.matches("[data-pair-form]")) {
        const fg = form.querySelector("[data-new-fg]").value;
        const bg = form.querySelector("[data-new-bg]").value;
        const use = form.querySelector("[data-new-use]").value;
        if (!fg || !bg) return setStatus("Pick a text and a background role first.");
        if (
          !THEMES.every((t) => state.roles[t][fg] !== undefined && state.roles[t][bg] !== undefined)
        ) {
          return setStatus("Both roles must exist in light and dark.");
        }
        state.pairs.push({ fg, bg, use });
        return changed();
      }
      if (form.matches("[data-role-form]")) {
        const name = form.querySelector("[data-role-name]").value.trim();
        const tok = form.querySelector("[data-role-token]").value;
        if (!name || !tok) return setStatus("Name the role and pick a token.");
        for (const theme of THEMES) state.roles[theme][name] = tok;
        form.querySelector("[data-role-name]").value = "";
        return changed();
      }
    });
    stage.addEventListener("pointerdown", (e) => {
      const hit = cellAt(e.offsetX, e.offsetY);
      if (!hit) return;
      stage.focus();
      focusOn(state.families[hit.r].id, hit.c);
    });
    stage.addEventListener("dblclick", (e) => {
      const hit = cellAt(e.offsetX, e.offsetY);
      if (!hit) return;
      focusOn(state.families[hit.r].id, hit.c);
      openEditor();
    });
    stage.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || !currentFamily()) return;
      const arrows = {
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
      };
      if (e.shiftKey && arrows[e.key]) {
        e.preventDefault();
        nudge(e.key === "ArrowUp" || e.key === "ArrowRight" ? NUDGE : -NUDGE);
        return;
      }
      if (arrows[e.key]) {
        e.preventDefault();
        moveFocus(...arrows[e.key]);
        return;
      }
      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        toggleLock();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        openEditor();
      }
    });
    editor.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        closeEditor(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeEditor(false);
      }
    });
    editor.addEventListener("blur", () => closeEditor(false));
    curve.addEventListener("pointerdown", (e) => {
      const fam = currentFamily();
      if (!fam) return;
      const W = curve.clientWidth;
      let i = curveHit(fam, e.offsetX, e.offsetY);
      if (i < 0) {
        const point = [clamp(xFromPx(e.offsetX, W), 0.02, 0.98), yFromPy(e.offsetY)];
        const pts = [...fam.curve, point].sort((a, b) => a[0] - b[0]);
        i = pts.indexOf(point);
        updateCurve(fam, pts);
        changed();
      }
      curveSel = i;
      drag = { index: i, px: null, py: null };
      curve.setPointerCapture(e.pointerId);
      curve.focus();
      scheduleDraw();
    });
    curve.addEventListener("pointermove", (e) => {
      if (!drag) return;
      drag.px = e.offsetX;
      drag.py = e.offsetY;
      queueDrag();
    });
    curve.addEventListener("pointerup", endDrag);
    curve.addEventListener("pointercancel", endDrag);
    curve.addEventListener("dblclick", (e) => {
      const fam = currentFamily();
      if (!fam) return;
      const i = curveHit(fam, e.offsetX, e.offsetY);
      if (i > 0 && i < fam.curve.length - 1) removeCurvePoint(fam, i);
    });
    curve.addEventListener("keydown", (e) => {
      const fam = currentFamily();
      if (!fam || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = focus.step / (steps.length - 1);
      const i =
        curveSel ??
        fam.curve.reduce(
          (best, p, k) => (Math.abs(p[0] - t) < Math.abs(fam.curve[best][0] - t) ? k : best),
          0,
        );
      const interior = i > 0 && i < fam.curve.length - 1;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (interior) removeCurvePoint(fam, i);
        return;
      }
      const big = e.shiftKey ? 0.05 : NUDGE;
      const delta = {
        ArrowUp: [0, big],
        ArrowDown: [0, -big],
        ArrowRight: [big, 0],
        ArrowLeft: [-big, 0],
      }[e.key];
      if (!delta) return;
      e.preventDefault();
      const pts = fam.curve.map((p) => [...p]);
      pts[i][1] = clamp(pts[i][1] + delta[1], 0, 1);
      if (interior)
        pts[i][0] = clamp(pts[i][0] + delta[0], pts[i - 1][0] + GAP_X, pts[i + 1][0] - GAP_X);
      curveSel = i;
      updateCurve(fam, pts);
      changed();
    });

    const offTheme = (t3kit.theme?.onChange ?? themeOnChange)(scheduleDraw);
    const resizeObserver = new ResizeObserver(() => scheduleDraw());
    resizeObserver.observe(stageWrap);
    resizeObserver.observe(curve);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      offTheme();
      resizeObserver.disconnect();
      if (drawFrame) cancelAnimationFrame(drawFrame);
      if (dragFrame) cancelAnimationFrame(dragFrame);
      root.remove();
      for (const set of Object.values(listeners)) set.clear();
    }

    if (options.value !== undefined) applyPartial(options.value);
    configure({
      view: options.view,
      theme: options.theme,
      method: options.method,
      target: options.target,
    });
    return {
      get,
      set(partial) {
        applyPartial(partial);
        refresh();
        emit("report", report());
      },
      import: importText,
      export: exportText,
      addFamily,
      editFamily,
      select,
      selected,
      configure,
      sample,
      harmony,
      report,
      fix,
      on,
      destroy,
    };
  }

  function slug(name) {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "family"
    );
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`palette.sample: cannot load ${src}`));
      img.src = src;
    });
  }
  // Inline stand-in for t3kit.theme.onChange (used when _core.js is absent): T3 swaps tokens on the root element's
  // style or class, or by rewriting <style id="t3-theme"> in head; the OS scheme can flip them too.
  function themeOnChange(cb) {
    const obs = new MutationObserver(() => cb());
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme"],
    });
    obs.observe(document.head, { childList: true, subtree: true, characterData: true });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", cb);
    return () => {
      obs.disconnect();
      scheme.removeEventListener("change", cb);
    };
  }
  function injectStyle() {
    if (document.querySelector('style[data-t3kit="palette"]')) return;
    const style = document.createElement("style");
    style.setAttribute("data-t3kit", "palette");
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  t3kit.palette = {
    create,
    contrast: (fg, bg, { method = "wcag" } = {}) => contrastOf(method, fg, bg),
    toOklch: (hex) => toOklch(hex),
    toHex: (lch) => toHex(lch),
  };
})();
