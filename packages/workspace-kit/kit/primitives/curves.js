/**
 * t3kit.curves: tone curve editor. RGB master + R/G/B channel curves, monotone spline, optional histogram backdrop.
 * create(container, options?) -> instance. container: HTMLElement or CSS selector; the editor fills it (give it a height).
 *   options.value: initial value (same shape as set()).   options.channel: 'rgb' (default) | 'r' | 'g' | 'b'.
 *   options.channels: tabs to show, subset of ['rgb','r','g','b'] (default all).   options.histogram: see setHistogram().
 *   options.label: accessible name (default 'Tone curve').
 * value = { rgb, r, g, b }: each [[x, y], ...] with x, y in 0..1 (0 = black). Points may be [x,y] or {x,y} in any order;
 *   they are clamped and sorted. Every curve must contain x=0 and x=1 (endpoints move vertically only, never removed).
 *   Key aliases: master=rgb, red=r, green=g, blue=b. Default per channel: [[0,0],[1,1]].
 * Instance
 *   get()              -> { rgb, r, g, b } deep copy, JSON-serialisable.
 *   set(partial)       -> replace any of rgb/r/g/b. Throws TypeError on bad input. Does NOT emit 'change'.
 *   reset(channel?)    -> identity for one channel, or for all four. Does NOT emit 'change'.
 *   lut()              -> { rgb, r, g, b }: 256 integers 0..255 each. rgb = master alone; r/g/b = master THEN channel,
 *                         i.e. the exact per-pixel mapping out.r = lut.r[in.r]. new Uint8ClampedArray(lut.r) works.
 *   setChannel(name) / channel() -> switch / read the active tab (no event).
 *   setHistogram(bins) -> number[] or typed array (any length, shared by all tabs) or { rgb?, r?, g?, b? }; null clears.
 *                         The backdrop shows the active channel's bins, else rgb. Spikes are capped so it stays readable.
 *   analyze(source)    -> Promise<{rgb,r,g,b} | null>: bins a 256px copy of a Blob, blob: URL, ImageBitmap, img, canvas
 *                         or video, then calls setHistogram. Resolves null if a newer analyze() superseded it.
 *   on(event, cb)      -> unsubscribe.   destroy() -> removes DOM, observers and listeners.
 * Static: t3kit.curves.histogramOf(source) -> Promise<{rgb,r,g,b}> of 256-bin counts (same sources as analyze).
 * Events: 'change' cb(value): user edits only, payload get(), at most once per frame while dragging.
 *         'channel' cb(name): the user clicked a tab.
 * Mouse: click empty plot adds a point; drag moves it (Shift = fine, x stays between neighbours); double-click,
 *   Alt+click or drag it off the plot removes it. Double-click an endpoint resets it. Readout shows in/out levels.
 * Keyboard (plot focused): arrows nudge the selected point (Shift = 10 levels); [ ] or PageUp/PageDown select;
 *   Enter or + adds a point on the curve after the selection; Delete/Backspace removes it; Escape deselects.
 * Performance: no animation loop or timers; pointer moves coalesce to one frame; the histogram layer repaints only on
 *   resize, theme change or setHistogram. The editor never touches image pixels: apply lut() to a downscaled
 *   preview while editing and to full resolution only on export.
 * Example:
 *   const ed = t3kit.curves.create(el, { value: { rgb: [[0, 0], [0.25, 0.18], [0.75, 0.82], [1, 1]] } });
 *   await ed.analyze(blob);                                  // optional histogram backdrop
 *   ed.on('change', () => applyLut(ed.lut()));               // applyLut: d[i] = L.r[s[i]], d[i+1] = L.g[s[i+1]], ...
 *   ed.set({ r: [[0, 0.05], [1, 1]] }); applyLut(ed.lut()); // set() is silent, so re-apply yourself
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});

  const CHANNELS = ["rgb", "r", "g", "b"];
  const ALIASES = { master: "rgb", red: "r", green: "g", blue: "b" };
  const TOKEN = { rgb: "--foreground", r: "--destructive", g: "--success", b: "--info" };
  const LABEL = { rgb: "RGB", r: "R", g: "G", b: "B" };
  const LONG = { rgb: "RGB master", r: "Red", g: "Green", b: "Blue" };
  const PAD = 14; // css px between stage edge and the square plot
  const HIT = 12; // css px pointer hit radius
  const OUT = 28; // css px beyond the plot where a dragged point is removed on release
  const GAP = 0.001; // minimum x spacing between neighbouring points
  const STEP = 1 / 255; // arrow key step (one level)
  const COARSE = 10 / 255; // shift + arrow key step
  const FINE_DRAG = 0.25; // shift-drag speed factor
  const SAMPLES = 160; // polyline resolution for drawing
  const CSS = `
.t3k-curves-root{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;width:100%;height:100%;min-height:0;min-width:0;color:var(--foreground);font:12px/1.4 var(--font-sans)}
.t3k-curves-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.t3k-curves-tabs{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--border);border-radius:var(--radius);background:var(--muted)}
.t3k-curves-tabs[hidden]{display:none}
.t3k-curves-tab,.t3k-curves-reset{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border:0;border-radius:calc(var(--radius) - 3px);background:transparent;color:var(--muted-foreground);font:inherit;font-weight:500;cursor:pointer}
.t3k-curves-tab:hover,.t3k-curves-reset:hover{color:var(--foreground)}
.t3k-curves-tab[aria-pressed="true"]{background:var(--card);color:var(--foreground);box-shadow:0 0 0 1px var(--border)}
.t3k-curves-swatch{width:7px;height:7px;border-radius:999px;background:var(--foreground)}
.t3k-curves-tab[data-ch="r"] .t3k-curves-swatch{background:var(--destructive)}
.t3k-curves-tab[data-ch="g"] .t3k-curves-swatch{background:var(--success)}
.t3k-curves-tab[data-ch="b"] .t3k-curves-swatch{background:var(--info)}
.t3k-curves-reset{margin-left:auto;height:28px;border:1px solid var(--border);border-radius:var(--radius)}
.t3k-curves-reset:hover{border-color:var(--input);background:var(--muted)}
.t3k-curves-tab:focus-visible,.t3k-curves-reset:focus-visible,.t3k-curves-stage:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.t3k-curves-stage{position:relative;flex:1 1 auto;min-height:160px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;cursor:crosshair}
.t3k-curves-layer{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.t3k-curves-readout{min-height:16px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--muted-foreground);font:11px/1.45 var(--font-mono);font-variant-numeric:tabular-nums}
`;
  let uid = 0;
  let styleEl = null;
  let live = 0;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const identity = () => [
    [0, 0],
    [1, 1],
  ];
  const toByte = (v) => Math.round(clamp(v, 0, 1) * 255);
  const cloneCurve = (pts) => pts.map((p) => [p[0], p[1]]);
  const isIdentity = (pts) => pts.length === 2 && pts[0][1] === 0 && pts[1][1] === 1;
  const isList = (v) => Array.isArray(v) || ArrayBuffer.isView(v);
  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };
  const toPx = (x, y, g) => [g.ox + x * g.side, g.oy + (1 - y) * g.side];
  const toNorm = (px, py, g) => [(px - g.ox) / g.side, 1 - (py - g.oy) / g.side];

  function canonical(name) {
    const key = ALIASES[name] ?? name;
    if (!CHANNELS.includes(key)) {
      throw new TypeError(
        `curves: unknown channel "${name}". Use rgb, r, g or b (aliases master, red, green, blue).`,
      );
    }
    return key;
  }

  function checkCurve(name, pts) {
    if (!Array.isArray(pts) || pts.length < 2)
      throw new TypeError(`curves: ${name} needs at least two [x, y] points`);
    const out = pts
      .map((p, i) => {
        const x = Array.isArray(p) ? p[0] : p?.x;
        const y = Array.isArray(p) ? p[1] : p?.y;
        if ((Array.isArray(p) && p.length !== 2) || !Number.isFinite(x) || !Number.isFinite(y)) {
          throw new TypeError(
            `curves: ${name}[${i}] must be [x, y] or {x, y} numbers, got ${JSON.stringify(p)}`,
          );
        }
        return [clamp(x, 0, 1), clamp(y, 0, 1)];
      })
      .sort((a, b) => a[0] - b[0]);
    const last = out.length - 1;
    if (out[0][0] !== 0 || out[last][0] !== 1)
      throw new TypeError(`curves: ${name} must contain points at x=0 and x=1`);
    for (let i = 1; i <= last; i++) {
      if (out[i][0] - out[i - 1][0] < GAP)
        throw new TypeError(`curves: ${name} has points closer than ${GAP} in x`);
    }
    return out;
  }

  function parseValue(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new TypeError("curves: expected an object such as { rgb: [[0, 0], [1, 1]] }");
    }
    const out = {};
    for (const key of Object.keys(source)) out[canonical(key)] = checkCurve(key, source[key]);
    return out;
  }

  // Fritsch-Carlson monotone tangents: the spline never overshoots its control points.
  function tangents(p) {
    const n = p.length;
    const d = new Array(n - 1);
    const m = new Array(n);
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
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
    return m;
  }

  function makeEval(p) {
    const m = tangents(p);
    const last = p.length - 1;
    return (x) => {
      if (x <= p[0][0]) return p[0][1];
      if (x >= p[last][0]) return p[last][1];
      let lo = 0;
      let hi = last;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (p[mid][0] <= x) lo = mid;
        else hi = mid;
      }
      const x0 = p[lo][0];
      const h = p[hi][0] - x0;
      const t = (x - x0) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      const y =
        (2 * t3 - 3 * t2 + 1) * p[lo][1] +
        (t3 - 2 * t2 + t) * h * m[lo] +
        (-2 * t3 + 3 * t2) * p[hi][1] +
        (t3 - t2) * h * m[hi];
      return clamp(y, 0, 1);
    };
  }

  function buildLut(fns) {
    const out = { rgb: new Array(256), r: new Array(256), g: new Array(256), b: new Array(256) };
    for (let i = 0; i < 256; i++) {
      const master = fns.rgb(i / 255);
      out.rgb[i] = toByte(master);
      out.r[i] = toByte(fns.r(master));
      out.g[i] = toByte(fns.g(master));
      out.b[i] = toByte(fns.b(master));
    }
    return out;
  }

  function normalizeBins(name, bins) {
    if (!isList(bins)) throw new TypeError(`curves: histogram ${name} must be an array of counts`);
    const arr = Float64Array.from(bins);
    if (arr.length < 2 || arr.some((v) => !Number.isFinite(v) || v < 0)) {
      throw new TypeError(
        `curves: histogram ${name} needs at least two finite, non-negative counts`,
      );
    }
    const sorted = Float64Array.from(arr).sort();
    // Cap at the 99th percentile so one spike (pure black, clipped sky) does not flatten the rest.
    const p99 = sorted[Math.floor((arr.length - 1) * 0.99)];
    const cap = p99 > 0 ? p99 : sorted[arr.length - 1] > 0 ? sorted[arr.length - 1] : 1;
    return Float32Array.from(arr, (v) => Math.min(1, v / cap));
  }

  function normalizeHistogram(input) {
    if (input == null) return {};
    if (isList(input)) return { rgb: normalizeBins("bins", input) };
    if (typeof input !== "object")
      throw new TypeError("curves: setHistogram() expects number[], {rgb, r, g, b} or null");
    const out = {};
    for (const key of Object.keys(input)) out[canonical(key)] = normalizeBins(key, input[key]);
    return out;
  }

  async function histogramOf(source) {
    const input = typeof source === "string" ? await (await fetch(source)).blob() : source;
    const bitmap = await createImageBitmap(input);
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, w, h);
    const bins = {
      rgb: new Array(256).fill(0),
      r: new Array(256).fill(0),
      g: new Array(256).fill(0),
      b: new Array(256).fill(0),
    };
    for (let i = 0; i < data.length; i += 4) {
      const R = data[i];
      const G = data[i + 1];
      const B = data[i + 2];
      bins.r[R]++;
      bins.g[G]++;
      bins.b[B]++;
      bins.rgb[Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)]++;
    }
    return bins;
  }

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const read = (name) => cs.getPropertyValue(name).trim();
    const channel = {};
    for (const c of CHANNELS) channel[c] = read(TOKEN[c]);
    return {
      muted: read("--muted-foreground"),
      border: read("--border"),
      card: read("--card"),
      danger: read("--destructive"),
      channel,
    };
  }

  function strokeCurve(ctx, fn, g, color, width, alpha) {
    ctx.beginPath();
    for (let i = 0; i <= SAMPLES; i++) {
      const x = i / SAMPLES;
      const [px, py] = toPx(x, fn(x), g);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function acquireStyle() {
    live++;
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.setAttribute("data-t3kit", "curves");
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  function releaseStyle() {
    live--;
    if (live === 0 && styleEl) {
      styleEl.remove();
      styleEl = null;
    }
  }

  class CurveEditor {
    #root;
    #stage;
    #bg;
    #fg;
    #readout;
    #tabs = {};
    #resetBtn;
    #value = { rgb: identity(), r: identity(), g: identity(), b: identity() };
    #channels;
    #channel;
    #label;
    #selected = -1;
    #hover = -1;
    #cursor = null; // [px, py] of the pointer over the stage, for the readout
    #drag = null;
    #movePt = null;
    #compiled = null;
    #hist = {};
    #listeners = { change: new Set(), channel: new Set() };
    #w = 0;
    #h = 0;
    #dpr = 1;
    #raf = 0;
    #dirtyBg = true;
    #dirtyFg = true;
    #dirtyText = true;
    #destroyed = false;
    #analysisSeq = 0;
    #resizeObs;
    #themeObs;
    #mq;
    #onScheme;

    constructor(container, options) {
      this.#channels = options.channels
        ? [...new Set(options.channels.map(canonical))]
        : CHANNELS.slice();
      if (this.#channels.length === 0)
        throw new TypeError("curves: options.channels must list at least one channel");
      this.#channel = options.channel != null ? canonical(options.channel) : this.#channels[0];
      if (!this.#channels.includes(this.#channel)) {
        throw new TypeError(
          `curves: options.channel "${this.#channel}" is not in options.channels`,
        );
      }
      if (options.value != null) Object.assign(this.#value, parseValue(options.value));
      this.#hist = normalizeHistogram(options.histogram ?? null);
      this.#label = options.label ?? "Tone curve";
      acquireStyle();
      this.#buildDom(container);
      this.#bindEvents();
      this.#observeTheme();
      this.#resizeObs = new ResizeObserver(() => this.#sizeCanvases());
      this.#resizeObs.observe(this.#stage);
      this.#syncTabs();
      this.#sizeCanvases();
    }

    get() {
      const out = {};
      for (const c of CHANNELS) out[c] = cloneCurve(this.#value[c]);
      return out;
    }

    set(partial) {
      Object.assign(this.#value, parseValue(partial));
      this.#clearInteraction();
      this.#invalidate();
    }

    reset(name) {
      const keys = name === undefined ? CHANNELS : [canonical(name)];
      for (const c of keys) this.#value[c] = identity();
      this.#clearInteraction();
      this.#invalidate();
    }

    lut() {
      const c = this.#compile();
      c.lut ??= buildLut(c.fns);
      return { rgb: c.lut.rgb.slice(), r: c.lut.r.slice(), g: c.lut.g.slice(), b: c.lut.b.slice() };
    }

    channel() {
      return this.#channel;
    }

    setChannel(name) {
      const key = canonical(name);
      if (!this.#channels.includes(key))
        throw new TypeError(`curves: channel "${key}" is not shown (see options.channels)`);
      if (key === this.#channel) return false;
      this.#channel = key;
      this.#clearInteraction();
      this.#hover = -1;
      this.#dirtyBg = true;
      this.#syncTabs();
      this.#invalidate();
      return true;
    }

    setHistogram(bins) {
      this.#hist = normalizeHistogram(bins);
      this.#dirtyBg = true;
      this.#schedule();
    }

    async analyze(source) {
      const seq = ++this.#analysisSeq;
      const bins = await histogramOf(source);
      if (seq !== this.#analysisSeq || this.#destroyed) return null;
      this.setHistogram(bins);
      return bins;
    }

    on(event, cb) {
      const set = this.#listeners[event];
      if (!set) throw new TypeError(`curves: unknown event "${event}". Use 'change' or 'channel'.`);
      if (typeof cb !== "function") throw new TypeError("curves: on() needs a callback function");
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    }

    destroy() {
      if (this.#destroyed) return;
      this.#destroyed = true;
      cancelAnimationFrame(this.#raf);
      this.#raf = 0;
      this.#resizeObs.disconnect();
      this.#themeObs.disconnect();
      this.#mq.removeEventListener("change", this.#onScheme);
      this.#listeners.change.clear();
      this.#listeners.channel.clear();
      this.#root.remove();
      releaseStyle();
    }

    // ---- DOM ----

    #buildDom(container) {
      const id = ++uid;
      const root = el("div", "t3k-curves-root");
      const bar = el("div", "t3k-curves-bar");
      const tabs = el("div", "t3k-curves-tabs");
      tabs.setAttribute("role", "group");
      tabs.setAttribute("aria-label", `${this.#label} channel`);
      tabs.hidden = this.#channels.length < 2;
      for (const c of this.#channels) {
        const btn = el("button", "t3k-curves-tab");
        btn.type = "button";
        btn.dataset.ch = c;
        btn.title = LONG[c];
        btn.append(el("span", "t3k-curves-swatch"), LABEL[c]);
        btn.addEventListener("click", () => {
          if (this.setChannel(c)) this.#emit("channel", c);
        });
        this.#tabs[c] = btn;
        tabs.append(btn);
      }
      const reset = el("button", "t3k-curves-reset");
      reset.type = "button";
      reset.textContent = "Reset";
      reset.addEventListener("click", () => {
        if (isIdentity(this.#value[this.#channel])) return;
        this.#value[this.#channel] = identity();
        this.#selected = -1;
        this.#edited();
      });
      this.#resetBtn = reset;
      bar.append(tabs, reset);

      const stage = el("div", "t3k-curves-stage");
      stage.tabIndex = 0;
      stage.setAttribute("role", "group");
      stage.setAttribute("aria-roledescription", "tone curve editor");
      stage.setAttribute(
        "aria-label",
        `${this.#label}. Arrow keys move the selected point, Enter adds, Delete removes.`,
      );
      const readout = el("div", "t3k-curves-readout");
      readout.id = `t3k-curves-readout-${id}`;
      readout.setAttribute("aria-live", "polite");
      stage.setAttribute("aria-describedby", readout.id);
      const bg = el("canvas", "t3k-curves-layer");
      const fg = el("canvas", "t3k-curves-layer");
      bg.setAttribute("aria-hidden", "true");
      fg.setAttribute("aria-hidden", "true");
      stage.append(bg, fg);

      root.append(bar, stage, readout);
      container.append(root);
      this.#root = root;
      this.#stage = stage;
      this.#bg = bg;
      this.#fg = fg;
      this.#readout = readout;
    }

    #bindEvents() {
      const s = this.#stage;
      s.addEventListener("pointerdown", (e) => this.#onPointerDown(e));
      s.addEventListener("pointermove", (e) => this.#onPointerMove(e));
      s.addEventListener("pointerup", (e) => this.#onPointerUp(e));
      s.addEventListener("pointercancel", (e) => this.#onPointerUp(e));
      s.addEventListener("pointerleave", () => this.#onPointerLeave());
      s.addEventListener("dblclick", (e) => this.#onDoubleClick(e));
      s.addEventListener("keydown", (e) => this.#onKeyDown(e));
    }

    #observeTheme() {
      // Event-driven only: repaint when the T3 theme tokens (html style/class, #t3-theme in head) or the scheme change.
      const changed = () => {
        this.#dirtyBg = true;
        this.#dirtyFg = true;
        this.#schedule();
      };
      this.#themeObs = new MutationObserver(changed);
      this.#themeObs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style", "class", "data-theme"],
      });
      this.#themeObs.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      this.#mq = window.matchMedia("(prefers-color-scheme: dark)");
      this.#onScheme = changed;
      this.#mq.addEventListener("change", this.#onScheme);
    }

    #syncTabs() {
      for (const c of this.#channels)
        this.#tabs[c].setAttribute("aria-pressed", String(c === this.#channel));
      this.#resetBtn.setAttribute("aria-label", `Reset ${LONG[this.#channel]} curve`);
    }

    // ---- Scheduling and state ----

    #schedule() {
      if (this.#raf || this.#destroyed) return;
      this.#raf = requestAnimationFrame(() => this.#flush());
    }

    #flush() {
      if (this.#destroyed) return;
      this.#flushMove();
      if (this.#w > 0 && this.#h > 0 && (this.#dirtyBg || this.#dirtyFg)) {
        const colors = readColors();
        if (this.#dirtyBg) {
          this.#dirtyBg = false;
          this.#drawBackdrop(colors);
        }
        if (this.#dirtyFg) {
          this.#dirtyFg = false;
          this.#drawForeground(colors);
        }
      }
      if (this.#dirtyText) {
        this.#dirtyText = false;
        this.#updateReadout();
      }
      const cursor = this.#drag ? "grabbing" : this.#hover >= 0 ? "grab" : "crosshair";
      if (this.#stage.style.cursor !== cursor) this.#stage.style.cursor = cursor;
      this.#raf = 0; // cleared last so edits made during this frame do not queue a second one
    }

    #invalidate() {
      this.#compiled = null;
      this.#dirtyFg = true;
      this.#dirtyText = true;
      this.#schedule();
    }

    #edited() {
      this.#invalidate();
      this.#emit("change", this.get());
    }

    #emit(event, payload) {
      for (const cb of this.#listeners[event]) cb(payload);
    }

    #compile() {
      if (!this.#compiled) {
        const v = this.#value;
        this.#compiled = {
          fns: { rgb: makeEval(v.rgb), r: makeEval(v.r), g: makeEval(v.g), b: makeEval(v.b) },
          lut: null,
        };
      }
      return this.#compiled;
    }

    #clearInteraction() {
      this.#selected = -1;
      this.#drag = null;
      this.#movePt = null;
    }

    #select(i) {
      this.#selected = i;
      this.#dirtyFg = true;
      this.#dirtyText = true;
      this.#schedule();
    }

    #setHover(i) {
      if (i === this.#hover) return;
      this.#hover = i;
      this.#dirtyFg = true;
      this.#schedule();
    }

    // ---- Geometry and hit testing ----

    #geo() {
      const side = Math.max(1, Math.min(this.#w, this.#h) - PAD * 2);
      return { side, ox: (this.#w - side) / 2, oy: (this.#h - side) / 2 };
    }

    #localXY(clientX, clientY) {
      const r = this.#stage.getBoundingClientRect();
      return [clientX - r.left - this.#stage.clientLeft, clientY - r.top - this.#stage.clientTop];
    }

    #inPlot(px, py, g) {
      return px >= g.ox && px <= g.ox + g.side && py >= g.oy && py <= g.oy + g.side;
    }

    #hitTest(px, py) {
      const g = this.#geo();
      const pts = this.#value[this.#channel];
      let best = -1;
      let bestD = HIT * HIT;
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = toPx(pts[i][0], pts[i][1], g);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    }

    // ---- Editing ----

    #insertPoint(x, y) {
      if (x < GAP || x > 1 - GAP) return -1;
      const pts = this.#value[this.#channel];
      let j = 1;
      while (j < pts.length - 1 && pts[j][0] <= x) j++;
      if (x - pts[j - 1][0] < GAP || pts[j][0] - x < GAP) return -1;
      pts.splice(j, 0, [x, y]);
      return j;
    }

    #removePoint(i) {
      const pts = this.#value[this.#channel];
      if (i <= 0 || i >= pts.length - 1) return false;
      pts.splice(i, 1);
      this.#selected = -1;
      this.#hover = -1;
      this.#edited();
      return true;
    }

    #resetEndpoint(i) {
      const pts = this.#value[this.#channel];
      const y = i === 0 ? 0 : 1;
      if (pts[i][1] === y) return;
      pts[i] = [pts[i][0], y];
      this.#edited();
    }

    #nudge(i, dx, dy) {
      const pts = this.#value[this.#channel];
      const last = pts.length - 1;
      const [x0, y0] = pts[i];
      const x = i > 0 && i < last ? clamp(x0 + dx, pts[i - 1][0] + GAP, pts[i + 1][0] - GAP) : x0;
      const y = clamp(y0 + dy, 0, 1);
      if (x === x0 && y === y0) return;
      pts[i] = [x, y];
      this.#edited();
    }

    // Adds a point on the curve halfway between point i and its right neighbour.
    #addAfter(i) {
      const pts = this.#value[this.#channel];
      if (i < 0 || i >= pts.length - 1) return;
      if (pts[i + 1][0] - pts[i][0] < 4 * GAP) return;
      const x = (pts[i][0] + pts[i + 1][0]) / 2;
      const y = this.#compile().fns[this.#channel](x);
      pts.splice(i + 1, 0, [x, y]);
      this.#selected = i + 1;
      this.#edited();
    }

    #applyDrag(clientX, clientY, fine) {
      const d = this.#drag;
      if (!d) return;
      const [px, py] = this.#localXY(clientX, clientY);
      if (fine !== d.fine) {
        // Re-anchor so switching Shift mid-drag never makes the point jump.
        const p = this.#value[this.#channel][d.index];
        Object.assign(d, { fine, cx: px, cy: py, u: p[0], v: p[1] });
      }
      const g = this.#geo();
      const k = fine ? FINE_DRAG : 1;
      const rx = d.u + ((px - d.cx) / g.side) * k;
      const ry = d.v - ((py - d.cy) / g.side) * k;
      const pts = this.#value[this.#channel];
      const i = d.index;
      const interior = i > 0 && i < pts.length - 1;
      const x = interior ? clamp(rx, pts[i - 1][0] + GAP, pts[i + 1][0] - GAP) : pts[i][0];
      const y = clamp(ry, 0, 1);
      const out =
        interior &&
        (px < g.ox - OUT ||
          px > g.ox + g.side + OUT ||
          py < g.oy - OUT ||
          py > g.oy + g.side + OUT);
      if (out !== d.out) {
        d.out = out;
        this.#dirtyFg = true;
        this.#dirtyText = true;
      }
      if (x === pts[i][0] && y === pts[i][1]) return;
      pts[i] = [x, y];
      this.#edited();
    }

    #flushMove() {
      if (!this.#movePt) return;
      const { x, y, fine } = this.#movePt;
      this.#movePt = null;
      this.#applyDrag(x, y, fine);
    }

    // ---- Pointer and keyboard ----

    #onPointerDown(e) {
      if (e.button !== 0) return;
      this.#stage.focus({ preventScroll: true });
      const [px, py] = this.#localXY(e.clientX, e.clientY);
      let idx = this.#hitTest(px, py);
      if (idx >= 0 && e.altKey) {
        this.#removePoint(idx);
        e.preventDefault();
        return;
      }
      if (idx < 0) {
        const g = this.#geo();
        if (!this.#inPlot(px, py, g)) return;
        const [x, y] = toNorm(px, py, g);
        idx = this.#insertPoint(clamp(x, 0, 1), clamp(y, 0, 1));
        if (idx < 0) return;
        this.#edited();
      }
      this.#select(idx);
      const p = this.#value[this.#channel][idx];
      this.#drag = { index: idx, out: false, fine: e.shiftKey, cx: px, cy: py, u: p[0], v: p[1] };
      this.#stage.setPointerCapture(e.pointerId);
      e.preventDefault();
    }

    #onPointerMove(e) {
      const [px, py] = this.#localXY(e.clientX, e.clientY);
      this.#cursor = [px, py];
      this.#dirtyText = true;
      if (this.#drag) {
        this.#movePt = { x: e.clientX, y: e.clientY, fine: e.shiftKey };
      } else {
        this.#setHover(this.#hitTest(px, py));
      }
      this.#schedule();
    }

    #onPointerLeave() {
      if (this.#drag) return;
      this.#cursor = null;
      this.#dirtyText = true;
      this.#setHover(-1);
      this.#schedule();
    }

    #onPointerUp(e) {
      if (!this.#drag) return;
      this.#flushMove();
      const d = this.#drag;
      this.#drag = null;
      if (this.#stage.hasPointerCapture(e.pointerId))
        this.#stage.releasePointerCapture(e.pointerId);
      if (e.type === "pointerup" && d.out) this.#removePoint(d.index);
      this.#dirtyFg = true;
      this.#dirtyText = true;
      this.#schedule();
    }

    #onDoubleClick(e) {
      const [px, py] = this.#localXY(e.clientX, e.clientY);
      const i = this.#hitTest(px, py);
      if (i < 0) return;
      const last = this.#value[this.#channel].length - 1;
      if (i === 0 || i === last) this.#resetEndpoint(i);
      else this.#removePoint(i);
    }

    #onKeyDown(e) {
      const pts = this.#value[this.#channel];
      const s = this.#selected;
      const step = e.shiftKey ? COARSE : STEP;
      const dir = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, step],
        ArrowDown: [0, -step],
      }[e.key];
      const prev = e.key === "[" || e.key === "PageUp";
      const next = e.key === "]" || e.key === "PageDown";
      const add = e.key === "Enter" || e.key === "+" || e.key === "=";
      if (add) {
        // With no selection, add in the segment that spans the midtones.
        let i = s;
        if (i < 0) {
          i = 0;
          while (i < pts.length - 2 && pts[i + 1][0] <= 0.5) i++;
        }
        this.#addAfter(Math.min(i, pts.length - 2)); // on the white endpoint, add before it
      } else if (s < 0) {
        if (!dir && !prev && !next) return;
        this.#select(pts.length > 2 ? 1 : 0);
      } else if (dir) {
        this.#nudge(s, dir[0], dir[1]);
      } else if (prev) {
        this.#select(Math.max(0, s - 1));
      } else if (next) {
        this.#select(Math.min(pts.length - 1, s + 1));
      } else if (e.key === "Delete" || e.key === "Backspace") {
        this.#removePoint(s);
      } else if (e.key === "Escape") {
        this.#select(-1);
      } else {
        return;
      }
      e.preventDefault();
    }

    // ---- Rendering ----

    #sizeCanvases() {
      const w = this.#stage.clientWidth;
      const h = this.#stage.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (w === this.#w && h === this.#h && dpr === this.#dpr) return;
      this.#w = w;
      this.#h = h;
      this.#dpr = dpr;
      for (const c of [this.#bg, this.#fg]) {
        c.width = Math.max(1, Math.round(w * dpr));
        c.height = Math.max(1, Math.round(h * dpr));
      }
      this.#dirtyBg = true;
      this.#dirtyFg = true;
      this.#schedule();
    }

    #prepare(canvas) {
      const ctx = canvas.getContext("2d");
      ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
      ctx.clearRect(0, 0, this.#w, this.#h);
      return ctx;
    }

    #drawBackdrop(c) {
      const ctx = this.#prepare(this.#bg);
      const { side, ox, oy } = this.#geo();
      const own = this.#channel !== "rgb" ? this.#hist[this.#channel] : undefined;
      const hist = own ?? this.#hist.rgb;
      if (hist) {
        const n = hist.length;
        ctx.fillStyle = own ? c.channel[this.#channel] : c.muted;
        ctx.globalAlpha = own ? 0.2 : 0.28;
        ctx.beginPath();
        ctx.moveTo(ox, oy + side);
        for (let i = 0; i < n; i++)
          ctx.lineTo(ox + (i / (n - 1)) * side, oy + side * (1 - hist[i] * 0.92));
        ctx.lineTo(ox + side, oy + side);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      ctx.strokeStyle = c.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const t of [0.25, 0.5, 0.75]) {
        const px = Math.round(ox + t * side) + 0.5;
        const py = Math.round(oy + t * side) + 0.5;
        ctx.moveTo(px, oy);
        ctx.lineTo(px, oy + side);
        ctx.moveTo(ox, py);
        ctx.lineTo(ox + side, py);
      }
      ctx.stroke();
      ctx.strokeRect(
        Math.round(ox) + 0.5,
        Math.round(oy) + 0.5,
        Math.round(side) - 1,
        Math.round(side) - 1,
      );

      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = c.muted;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.moveTo(ox, oy + side);
      ctx.lineTo(ox + side, oy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    #drawForeground(c) {
      const ctx = this.#prepare(this.#fg);
      const g = this.#geo();
      const ch = this.#channel;
      const fns = this.#compile().fns;
      const color = c.channel[ch];
      if (ch === "rgb") {
        // Composite view: show edited colour channels faintly so their effect stays visible.
        for (const k of ["r", "g", "b"])
          if (!isIdentity(this.#value[k])) strokeCurve(ctx, fns[k], g, c.channel[k], 1.25, 0.55);
      } else if (!isIdentity(this.#value.rgb)) {
        strokeCurve(ctx, fns.rgb, g, c.muted, 1.25, 0.6);
      }
      strokeCurve(ctx, fns[ch], g, color, 2, 1);
      this.#value[ch].forEach((p, i) => {
        const [x, y] = toPx(p[0], p[1], g);
        const dragging = this.#drag !== null && this.#drag.index === i;
        const removing = dragging && this.#drag.out;
        const selected = i === this.#selected;
        const hot = selected || i === this.#hover || dragging;
        ctx.globalAlpha = removing ? 0.6 : 1;
        ctx.beginPath();
        ctx.arc(x, y, hot ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = selected ? color : c.card;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = removing ? c.danger : color;
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    }

    #updateReadout() {
      const pts = this.#value[this.#channel];
      const name = LONG[this.#channel];
      let text;
      if (this.#drag && this.#drag.out) {
        text = "Release to remove this point";
      } else if (this.#selected >= 0 && this.#selected < pts.length) {
        const [x, y] = pts[this.#selected];
        text = `${name} · point ${this.#selected + 1}/${pts.length} · in ${Math.round(x * 255)} → out ${Math.round(y * 255)}`;
      } else if (
        this.#cursor &&
        this.#w > 0 &&
        this.#inPlot(this.#cursor[0], this.#cursor[1], this.#geo())
      ) {
        const x = clamp(toNorm(this.#cursor[0], this.#cursor[1], this.#geo())[0], 0, 1);
        const y = this.#compile().fns[this.#channel](x);
        text = `${name} · in ${Math.round(x * 255)} → out ${Math.round(y * 255)}`;
      } else {
        text = "Click adds · drag moves · double-click removes";
      }
      if (this.#readout.textContent !== text) this.#readout.textContent = text;
    }
  }

  t3kit.curves = {
    create(container, options = {}) {
      const target = typeof container === "string" ? document.querySelector(container) : container;
      if (!(target instanceof HTMLElement)) {
        throw new TypeError(
          "curves.create: container must be an HTMLElement or a CSS selector that matches one",
        );
      }
      return new CurveEditor(target, options);
    },
    histogramOf,
  };
})();
