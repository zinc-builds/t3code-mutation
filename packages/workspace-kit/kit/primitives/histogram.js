/**
 * t3kit.histogram: overlaid RGB + Rec.709 luma histogram with shadow/highlight clip triangles and %.
 * Cheap: sources are point-sampled down to sampleEdge on a scratch canvas (ImageData strided), so
 * a 24MP still or 4K frame costs at most sampleEdge^2 px. Draws only on data/resize/theme/probe.
 *
 * create(container, options?) -> instance
 *   options.density     'compact' (64px plot, clip % in plot) | 'dense' (axis, stats table)  'compact'
 *   options.channels    { r, g, b, l: boolean }           visible curves, default all true
 *   options.clip        { shadows: 0, highlights: 255 }   level <= shadows / >= highlights is clipped
 *   options.sampleEdge  integer 16..4096                  longest analysed edge, default 512
 *   options.controls    boolean                           channel + density toggles, default true
 *
 * instance.update(source) -> Promise<state | null>   null when a newer update superseded it
 *   source: Blob | File | 'blob:' / 'data:' URL string | ImageBitmap | ImageData | HTMLImageElement
 *           | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement (frame loaded) | VideoFrame
 *           | null (clears). Throws TypeError for anything else.
 * instance.get() -> { density, channels, clip, controls, hasData, source, bins, stats, clipping }
 *   source:   { width, height, analysedWidth, analysedHeight, sampled, counted, ms } | null
 *   bins:     { r, g, b, l } number[256] counts (pixels with alpha >= 8) | null
 *   stats:    { r|g|b|l: { mean, median } } on 0-255 | null
 *   clipping: { shadows|highlights: { pct, channels: { r, g, b, l } } } percent 0-100 | null
 *             pct = pixels where ANY of R,G,B is clipped; channels.l uses luma.
 * instance.set(partial)  density, channels, clip, controls. clip recounts the cached sample (~2ms).
 *                        Unknown keys throw. Does NOT emit change.
 * instance.on(event, cb) -> unsubscribe
 *   'change'   user toggled a channel or density; payload = get()
 *   'analyze'  an update(source) finished (also for null); payload = get()
 *   'probe'    hover/arrow-key level probe; payload { level, r, g, b, l } (% at level) or { level: null }
 * instance.destroy()
 *
 * Colours: R --destructive, G --success, B --info, L --muted-foreground; curves screen-blend on dark
 * and multiply on light. Triangles fill with the colour of each clipped channel. Keyboard: focus
 * the plot, Left/Right (Shift = 8), Home/End, Escape clears the probe.
 *
 * Example:
 *   const h = t3kit.histogram.create(el, { density: 'dense' });
 *   const s = await h.update(file);                 // File/Blob/blob: URL from t3.workspace.assets()
 *   if (s.clipping.highlights.pct > 1) warn('Highlights blown');
 *   h.set({ clip: { highlights: 250 } });           // re-evaluate without re-decoding
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});

  const BINS = 256;
  const MIN_ALPHA = 8;
  const CHANNELS = ["r", "g", "b", "l"];
  const RGB = ["r", "g", "b"];
  const DRAW_ORDER = ["l", "r", "g", "b"];
  const LABEL = { r: "R", g: "G", b: "B", l: "L" };
  const NAME = { r: "Red", g: "Green", b: "Blue", l: "Luminance" };
  const LAYOUT = {
    compact: { top: 15, axis: 0, font: 10 },
    dense: { top: 17, axis: 15, font: 11 },
  };
  const DENSITY_LABEL = { compact: "Compact", dense: "Dense" };
  const SET_KEYS = ["density", "channels", "clip", "controls"];
  const DASH = "—";

  const CSS = `
.t3k-histogram-root{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;width:100%;min-width:0;color:var(--foreground);font-family:var(--font-sans);font-size:12px;line-height:1.35}
.t3k-histogram-root *{box-sizing:border-box}
.t3k-histogram-root[data-controls="false"] .t3k-histogram-head{display:none}
.t3k-histogram-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px}
.t3k-histogram-group{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);background:var(--muted)}
.t3k-histogram-btn{appearance:none;margin:0;height:22px;min-width:26px;padding:0 7px;border:0;border-radius:calc(var(--radius) - 4px);background:transparent;color:var(--muted-foreground);font:inherit;font-family:var(--font-mono);font-size:11px;cursor:pointer;--t3k-histogram-ch:var(--foreground)}
.t3k-histogram-btn:hover{color:var(--foreground)}
.t3k-histogram-btn[data-ch="r"]{--t3k-histogram-ch:var(--destructive)}
.t3k-histogram-btn[data-ch="g"]{--t3k-histogram-ch:var(--success)}
.t3k-histogram-btn[data-ch="b"]{--t3k-histogram-ch:var(--info)}
.t3k-histogram-btn[aria-pressed="true"]{background:color-mix(in srgb,var(--foreground) 11%,transparent);color:var(--t3k-histogram-ch)}
.t3k-histogram-btn[data-ch][aria-pressed="false"]{text-decoration:line-through;opacity:.7}
.t3k-histogram-btn:focus-visible,.t3k-histogram-canvas:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.t3k-histogram-plot{position:relative;width:100%;min-width:0;overflow:hidden;border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);background:var(--muted)}
.t3k-histogram-root[data-density="compact"] .t3k-histogram-plot{height:64px}
.t3k-histogram-root[data-density="dense"] .t3k-histogram-plot{height:156px}
.t3k-histogram-canvas{display:block;width:100%;height:100%;cursor:crosshair;touch-action:pan-y}
.t3k-histogram-empty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:var(--muted-foreground);font-size:11px;pointer-events:none}
.t3k-histogram-root[data-empty="true"] .t3k-histogram-empty{display:flex}
.t3k-histogram-dense{display:flex;flex-direction:column;gap:6px;min-width:0}
.t3k-histogram-root[data-density="compact"] .t3k-histogram-dense{display:none}
.t3k-histogram-table{width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:11px;font-variant-numeric:tabular-nums}
.t3k-histogram-table th,.t3k-histogram-table td{padding:3px 4px;border-top:1px solid var(--border);text-align:right;font-weight:400;white-space:nowrap}
.t3k-histogram-table th{border-top:0;color:var(--muted-foreground);font-size:10px}
.t3k-histogram-table th:first-child,.t3k-histogram-table td:first-child{text-align:left}
.t3k-histogram-table td{color:var(--muted-foreground)}
.t3k-histogram-table td[data-hot="true"]{color:var(--foreground)}
.t3k-histogram-table tr[data-off="true"] td{opacity:.45}
.t3k-histogram-dot{display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:2px;background:var(--t3k-histogram-ch,var(--foreground));vertical-align:0}
.t3k-histogram-line{margin:0;min-height:15px;font-family:var(--font-mono);font-size:11px;font-variant-numeric:tabular-nums;color:var(--muted-foreground);overflow-wrap:anywhere}
`;

  // One MutationObserver + one media query shared by every instance.
  const themeListeners = new Set();
  let themeObserver = null;
  let schemeQuery = null;
  const notifyTheme = () => {
    for (const fn of themeListeners) fn();
  };
  function subscribeTheme(fn) {
    if (themeListeners.size === 0) {
      themeObserver = new MutationObserver(notifyTheme);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
      themeObserver.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
      schemeQuery.addEventListener("change", notifyTheme);
    }
    themeListeners.add(fn);
    return () => {
      themeListeners.delete(fn);
      if (themeListeners.size > 0) return;
      themeObserver.disconnect();
      themeObserver = null;
      schemeQuery.removeEventListener("change", notifyTheme);
      schemeQuery = null;
    };
  }

  function ensureStyle() {
    if (document.querySelector('style[data-t3kit="histogram"]')) return;
    const style = document.createElement("style");
    style.dataset.t3kit = "histogram";
    style.textContent = CSS;
    document.head.append(style);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function checkDensity(value) {
    if (!Object.hasOwn(LAYOUT, value))
      throw new RangeError(`t3kit.histogram: density must be 'compact' or 'dense', got ${value}`);
  }
  function checkClip(clip) {
    for (const k of ["shadows", "highlights"]) {
      const v = clip[k];
      if (!Number.isInteger(v) || v < 0 || v > 255)
        throw new RangeError(`t3kit.histogram: clip.${k} must be an integer 0-255, got ${v}`);
    }
    if (clip.shadows >= clip.highlights)
      throw new RangeError("t3kit.histogram: clip.shadows must be below clip.highlights");
  }
  function mergeChannels(current, partial) {
    const next = { ...current };
    for (const k of Object.keys(partial)) {
      if (!CHANNELS.includes(k))
        throw new RangeError(`t3kit.histogram: unknown channel '${k}' (use r, g, b, l)`);
      next[k] = Boolean(partial[k]);
    }
    return next;
  }

  function fmtPct(p) {
    if (p > 0 && p < 0.01) return "<0.01%";
    return `${p.toFixed(2)}%`;
  }

  // Parses any CSS colour to relative luminance once per distinct value (chooses the blend mode).
  const lumaCache = new Map();
  let parseCtx = null;
  function luminanceOf(css) {
    if (lumaCache.has(css)) return lumaCache.get(css);
    if (parseCtx === null)
      parseCtx = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
    parseCtx.clearRect(0, 0, 1, 1);
    parseCtx.fillStyle = css;
    parseCtx.fillRect(0, 0, 1, 1);
    const [r, g, b] = parseCtx.getImageData(0, 0, 1, 1).data;
    const value = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    lumaCache.set(css, value);
    return value;
  }

  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    return {
      r: v("--destructive"),
      g: v("--success"),
      b: v("--info"),
      l: v("--muted-foreground"),
      fg: v("--foreground"),
      muted: v("--muted-foreground"),
      plot: v("--muted"),
      mono: v("--font-mono"),
      blend: luminanceOf(v("--background")) < 0.5 ? "screen" : "multiply",
    };
  }

  // Point-samples (no smoothing) so the sample is an unbiased subset of real pixel values: averaging
  // would hide clipped pixels. CPU-side sources (decoded bitmaps) scale on a CPU-raster canvas; GPU-side
  // sources (canvas, video) scale on a GPU canvas so only the small sample is read back.
  function drawSample(scaler, src, sw, sh, edge) {
    if (!(sw > 0 && sh > 0)) throw new Error("t3kit.histogram: source has no pixels");
    const scale = Math.min(1, edge / Math.max(sw, sh));
    const aw = Math.max(1, Math.round(sw * scale));
    const ah = Math.max(1, Math.round(sh * scale));
    if (scaler.canvas === null || scaler.canvas.width !== aw || scaler.canvas.height !== ah) {
      scaler.canvas = new OffscreenCanvas(aw, ah);
      scaler.ctx = scaler.canvas.getContext("2d", { willReadFrequently: scaler.cpu });
    }
    const ctx = scaler.ctx;
    ctx.globalCompositeOperation = "copy";
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, aw, ah);
    return { px: ctx.getImageData(0, 0, aw, ah).data, aw, ah, w: sw, h: sh, sampled: scale < 1 };
  }

  // ImageData is already CPU-side: take every stride-th pixel instead of copying the buffer.
  function sampleImageData(img, edge) {
    const { width: sw, height: sh, data } = img;
    if (!(sw > 0 && sh > 0)) throw new Error("t3kit.histogram: source has no pixels");
    const stride = Math.max(1, Math.ceil(Math.max(sw, sh) / edge));
    if (stride === 1) return { px: data.slice(), aw: sw, ah: sh, w: sw, h: sh, sampled: false };
    const aw = Math.ceil(sw / stride);
    const ah = Math.ceil(sh / stride);
    const px = new Uint8ClampedArray(aw * ah * 4);
    for (let y = 0, o = 0; y < ah; y++) {
      const row = y * stride * sw;
      for (let x = 0; x < aw; x++, o += 4) {
        const s = (row + x * stride) * 4;
        px[o] = data[s];
        px[o + 1] = data[s + 1];
        px[o + 2] = data[s + 2];
        px[o + 3] = data[s + 3];
      }
    }
    return { px, aw, ah, w: sw, h: sh, sampled: true };
  }

  async function sampleSource(source, edge, scalers) {
    const { cpu, gpu } = scalers;
    if (source instanceof ImageData) return sampleImageData(source, edge);
    if (typeof source === "string") {
      const img = new Image();
      img.src = source;
      await img.decode();
      return drawSample(cpu, img, img.naturalWidth, img.naturalHeight, edge);
    }
    if (source instanceof Blob) {
      if (source.type.startsWith("video/")) {
        throw new TypeError(
          "t3kit.histogram: video Blob given; pass a loaded HTMLVideoElement or VideoFrame instead",
        );
      }
      const bitmap = await createImageBitmap(source);
      try {
        return drawSample(cpu, bitmap, bitmap.width, bitmap.height, edge);
      } finally {
        bitmap.close();
      }
    }
    if (source instanceof ImageBitmap)
      return drawSample(cpu, source, source.width, source.height, edge);
    if (source instanceof HTMLImageElement) {
      if (!source.complete || source.naturalWidth === 0) await source.decode();
      return drawSample(cpu, source, source.naturalWidth, source.naturalHeight, edge);
    }
    if (source instanceof HTMLVideoElement) {
      if (source.readyState < 2)
        throw new Error("t3kit.histogram: video has no decoded frame (readyState < 2)");
      return drawSample(gpu, source, source.videoWidth, source.videoHeight, edge);
    }
    if (typeof VideoFrame === "function" && source instanceof VideoFrame) {
      return drawSample(gpu, source, source.displayWidth, source.displayHeight, edge);
    }
    if (source instanceof HTMLCanvasElement || source instanceof OffscreenCanvas) {
      return drawSample(gpu, source, source.width, source.height, edge);
    }
    throw new TypeError("t3kit.histogram: unsupported source (see header for accepted types)");
  }

  function sumRange(arr, lo, hi) {
    let s = 0;
    for (let i = lo; i <= hi; i++) s += arr[i];
    return s;
  }

  // One pass over the sample: channel bins, Rec.709 luma bins and any-channel clip counts.
  function measure(px, clip) {
    const bins = {
      r: new Uint32Array(BINS),
      g: new Uint32Array(BINS),
      b: new Uint32Array(BINS),
      l: new Uint32Array(BINS),
    };
    const { r, g, b, l } = bins;
    const lo = clip.shadows;
    const hi = clip.highlights;
    let counted = 0;
    let shadowAny = 0;
    let highlightAny = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < MIN_ALPHA) continue;
      const R = px[i];
      const G = px[i + 1];
      const B = px[i + 2];
      r[R]++;
      g[G]++;
      b[B]++;
      l[(54 * R + 183 * G + 19 * B + 128) >> 8]++; // weights sum to 256, so white maps to 255
      counted++;
      if (R <= lo || G <= lo || B <= lo) shadowAny++;
      if (R >= hi || G >= hi || B >= hi) highlightAny++;
    }
    const pct = (n) => (counted ? (n / counted) * 100 : 0);
    const side = (any, from, to) => ({
      pct: pct(any),
      channels: Object.fromEntries(CHANNELS.map((k) => [k, pct(sumRange(bins[k], from, to))])),
    });
    const stats = {};
    for (const k of CHANNELS) {
      const arr = bins[k];
      let sum = 0;
      let acc = 0;
      let median = -1;
      for (let i = 0; i < BINS; i++) {
        sum += i * arr[i];
        acc += arr[i];
        if (median < 0 && acc * 2 >= counted && counted > 0) median = i;
      }
      stats[k] = {
        mean: counted ? Math.round((sum / counted) * 100) / 100 : 0,
        median: Math.max(0, median),
      };
    }
    return {
      counted,
      bins,
      stats,
      clipping: { shadows: side(shadowAny, 0, lo), highlights: side(highlightAny, hi, BINS - 1) },
    };
  }

  function create(container, options) {
    if (!(container instanceof HTMLElement))
      throw new TypeError("t3kit.histogram.create: container must be an HTMLElement");
    const opts = options ?? {};
    const state = {
      density: opts.density ?? "compact",
      channels: mergeChannels({ r: true, g: true, b: true, l: true }, opts.channels ?? {}),
      clip: { shadows: 0, highlights: 255, ...opts.clip },
      controls: opts.controls ?? true,
    };
    const edge = opts.sampleEdge ?? 512;
    checkDensity(state.density);
    checkClip(state.clip);
    if (!Number.isInteger(edge) || edge < 16 || edge > 4096) {
      throw new RangeError(`t3kit.histogram: sampleEdge must be an integer 16..4096, got ${edge}`);
    }

    ensureStyle();
    const root = el("div", "t3k-histogram-root");
    const head = el("div", "t3k-histogram-head");
    const chGroup = el("div", "t3k-histogram-group");
    chGroup.setAttribute("role", "group");
    chGroup.setAttribute("aria-label", "Channels");
    const chButtons = {};
    for (const ch of CHANNELS) {
      const btn = el("button", "t3k-histogram-btn", LABEL[ch]);
      btn.type = "button";
      btn.dataset.ch = ch;
      btn.title = NAME[ch];
      btn.setAttribute("aria-label", `${NAME[ch]} channel`);
      chButtons[ch] = btn;
      chGroup.append(btn);
    }
    const dnGroup = el("div", "t3k-histogram-group");
    dnGroup.setAttribute("role", "group");
    dnGroup.setAttribute("aria-label", "Density");
    const dnButtons = {};
    for (const d of Object.keys(LAYOUT)) {
      const btn = el("button", "t3k-histogram-btn", DENSITY_LABEL[d]);
      btn.type = "button";
      dnButtons[d] = btn;
      dnGroup.append(btn);
    }
    head.append(chGroup, dnGroup);

    const plot = el("div", "t3k-histogram-plot");
    const canvas = el("canvas", "t3k-histogram-canvas");
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "slider");
    canvas.setAttribute("aria-label", "Histogram level probe");
    canvas.setAttribute("aria-valuemin", "0");
    canvas.setAttribute("aria-valuemax", "255");
    plot.append(canvas, el("div", "t3k-histogram-empty", "No source"));

    const dense = el("div", "t3k-histogram-dense");
    const table = el("table", "t3k-histogram-table");
    const headRow = el("tr");
    for (const t of ["Ch", "Mean", "Median", "Shadows", "Highlights"])
      headRow.append(el("th", "", t));
    table.append(el("thead"), el("tbody"));
    table.tHead.append(headRow);
    const cells = {};
    for (const k of [...CHANNELS, "any"]) {
      const row = el("tr");
      const name = el("td");
      if (k === "any") name.textContent = "Any RGB";
      else {
        const dot = el("span", "t3k-histogram-dot");
        dot.style.setProperty(
          "--t3k-histogram-ch",
          `var(${{ r: "--destructive", g: "--success", b: "--info", l: "--muted-foreground" }[k]})`,
        );
        name.append(dot, LABEL[k]);
      }
      const c = {
        row,
        mean: el("td", "", DASH),
        median: el("td", "", DASH),
        shadows: el("td", "", DASH),
        highlights: el("td", "", DASH),
      };
      row.append(name, c.mean, c.median, c.shadows, c.highlights);
      table.tBodies[0].append(row);
      cells[k] = c;
    }
    const probeLine = el("p", "t3k-histogram-line");
    const statusLine = el("p", "t3k-histogram-line");
    dense.append(table, probeLine, statusLine);
    root.append(head, plot, dense);
    container.append(root);

    const scalers = {
      cpu: { cpu: true, canvas: null, ctx: null },
      gpu: { cpu: false, canvas: null, ctx: null },
    };
    const handlers = { change: new Set(), analyze: new Set(), probe: new Set() };
    let analysis = null;
    let seq = 0;
    let probe = null;
    let frame = 0;
    let destroyed = false;

    function get() {
      const a = analysis;
      return {
        density: state.density,
        channels: { ...state.channels },
        clip: { ...state.clip },
        controls: state.controls,
        hasData: a !== null,
        source: a
          ? {
              width: a.w,
              height: a.h,
              analysedWidth: a.aw,
              analysedHeight: a.ah,
              sampled: a.sampled,
              counted: a.counted,
              ms: a.ms,
            }
          : null,
        bins: a ? Object.fromEntries(CHANNELS.map((k) => [k, Array.from(a.bins[k])])) : null,
        stats: a ? structuredClone(a.stats) : null,
        clipping: a ? structuredClone(a.clipping) : null,
      };
    }

    function emit(name, payload) {
      for (const cb of Array.from(handlers[name])) cb(payload ?? get());
    }

    function probePayload() {
      if (probe === null || !analysis) return { level: null };
      const n = analysis.counted;
      const out = { level: probe };
      for (const k of CHANNELS)
        out[k] = n ? Math.round((analysis.bins[k][probe] / n) * 1e5) / 1e3 : 0;
      return out;
    }

    function renderProbeText() {
      if (!analysis) {
        probeLine.textContent = "";
        canvas.setAttribute("aria-valuetext", "No data");
        return;
      }
      if (probe === null) {
        probeLine.textContent = "Hover the plot or use arrow keys to probe a level";
        canvas.setAttribute("aria-valuetext", "No level probed");
        return;
      }
      const p = probePayload();
      const parts = CHANNELS.filter((k) => state.channels[k]).map(
        (k) => `${LABEL[k]} ${fmtPct(p[k])}`,
      );
      probeLine.textContent = `Level ${probe}  ${parts.join("  ")}`;
      canvas.setAttribute("aria-valuenow", String(probe));
      canvas.setAttribute("aria-valuetext", probeLine.textContent);
    }

    function renderText() {
      root.dataset.density = state.density;
      root.dataset.controls = String(state.controls);
      root.dataset.empty = String(!analysis);
      for (const ch of CHANNELS)
        chButtons[ch].setAttribute("aria-pressed", String(state.channels[ch]));
      for (const d of Object.keys(LAYOUT))
        dnButtons[d].setAttribute("aria-pressed", String(state.density === d));
      const a = analysis;
      for (const k of [...CHANNELS, "any"]) {
        const c = cells[k];
        c.row.dataset.off = String(k !== "any" && !state.channels[k]);
        const st = a && k !== "any" ? a.stats[k] : null;
        c.mean.textContent = st ? st.mean.toFixed(1) : DASH;
        c.median.textContent = st ? String(st.median) : DASH;
        for (const side of ["shadows", "highlights"]) {
          const v = a ? (k === "any" ? a.clipping[side].pct : a.clipping[side].channels[k]) : null;
          c[side].textContent = v === null ? DASH : fmtPct(v);
          c[side].dataset.hot = String(v !== null && v > 0);
        }
      }
      statusLine.textContent = a
        ? `${a.w}×${a.h} source · analysed ${a.aw}×${a.ah}${a.sampled ? " (sampled)" : ""} · ` +
          `${a.counted.toLocaleString("en-US")} px · ${a.ms.toFixed(1)} ms`
        : "Waiting for a source";
      canvas.setAttribute(
        "aria-label",
        a
          ? `Histogram probe. Shadows ${fmtPct(a.clipping.shadows.pct)} clipped, highlights ${fmtPct(a.clipping.highlights.pct)} clipped`
          : "Histogram, no data",
      );
      renderProbeText();
    }

    // Corner triangle (dir +1 = left/shadows, -1 = right/highlights) filled per clipped channel.
    function drawIndicator(ctx, c, W, dir, side, font) {
      const leg = 8;
      const x = dir > 0 ? 3 : W - 3;
      const tri = new Path2D();
      tri.moveTo(x, 3);
      tri.lineTo(x + dir * leg, 3);
      tri.lineTo(x, 3 + leg);
      tri.closePath();
      const hot = RGB.filter((k) => side.channels[k] > 0);
      if (hot.length === 0) {
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = c.muted;
        ctx.lineWidth = 1;
        ctx.stroke(tri);
      } else {
        ctx.fillStyle = c.plot;
        ctx.fill(tri);
        ctx.globalCompositeOperation = c.blend;
        for (const k of hot) {
          ctx.fillStyle = c[k];
          ctx.fill(tri);
        }
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.globalAlpha = 1;
      ctx.font = `${font}px ${c.mono}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = dir > 0 ? "left" : "right";
      ctx.fillStyle = side.pct > 0 ? c.fg : c.muted;
      ctx.fillText(fmtPct(side.pct), x + dir * (leg + 4), 3 + leg / 2);
    }

    function drawCurves(ctx, c, W, top, base) {
      const bins = analysis.bins;
      const visible = DRAW_ORDER.filter((k) => state.channels[k]);
      // Peak ignores the end bins so a clipping spike does not flatten the curve; it clamps instead.
      let peak = 0;
      let all = 0;
      for (const k of visible) {
        for (let i = 0; i < BINS; i++) {
          if (bins[k][i] > all) all = bins[k][i];
          if (i > 0 && i < BINS - 1 && bins[k][i] > peak) peak = bins[k][i];
        }
      }
      if (peak === 0) peak = all;
      if (peak === 0) return;
      const scale = (base - top) / Math.sqrt(peak);
      const cell = W / BINS;
      for (const k of visible) {
        const arr = bins[k];
        const line = new Path2D();
        for (let i = 0; i < BINS; i++) {
          const y = base - Math.min(base - top, Math.sqrt(arr[i]) * scale);
          if (i === 0) line.moveTo(0, y);
          line.lineTo((i + 0.5) * cell, y);
        }
        line.lineTo(W, base - Math.min(base - top, Math.sqrt(arr[BINS - 1]) * scale));
        const fill = new Path2D(line);
        fill.lineTo(W, base);
        fill.lineTo(0, base);
        fill.closePath();
        const luma = k === "l";
        ctx.globalCompositeOperation = luma ? "source-over" : c.blend;
        ctx.globalAlpha = luma ? 0.22 : 0.5;
        ctx.fillStyle = c[k];
        ctx.fill(fill);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = luma ? 0.55 : 0.95;
        ctx.strokeStyle = luma ? c.fg : c[k];
        ctx.lineWidth = luma ? 1.25 : 1;
        ctx.stroke(line);
      }
      ctx.globalAlpha = 1;
    }

    function draw() {
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      if (W === 0 || H === 0) return;
      const dpr = window.devicePixelRatio;
      const pxW = Math.round(W * dpr);
      const pxH = Math.round(H * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const c = readTheme();
      const layout = LAYOUT[state.density];
      const top = layout.top;
      const base = H - layout.axis - (layout.axis ? 0 : 1);
      const cell = W / BINS;

      ctx.lineWidth = 1;
      ctx.strokeStyle = c.muted;
      ctx.globalAlpha = 0.16;
      ctx.beginPath();
      for (const v of [64, 128, 192]) {
        const x = Math.round(v * cell) + 0.5;
        ctx.moveTo(x, top - 4);
        ctx.lineTo(x, base);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      if (analysis) {
        drawCurves(ctx, c, W, top, base);
        drawIndicator(ctx, c, W, 1, analysis.clipping.shadows, layout.font);
        drawIndicator(ctx, c, W, -1, analysis.clipping.highlights, layout.font);
        if (probe !== null) {
          const x = Math.round((probe + 0.5) * cell) + 0.5;
          ctx.globalAlpha = 0.75;
          ctx.strokeStyle = c.fg;
          ctx.beginPath();
          ctx.moveTo(x, top - 4);
          ctx.lineTo(x, base);
          ctx.stroke();
          ctx.globalAlpha = 1;
          const label = String(probe);
          ctx.font = `${layout.font}px ${c.mono}`;
          const tw = ctx.measureText(label).width;
          const right = x + tw + 10 < W;
          const lx = right ? x + 4 : x - 4 - tw;
          const ly = base - 9;
          ctx.fillStyle = c.plot;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(lx - 2, ly - 7, tw + 4, 14);
          ctx.globalAlpha = 1;
          ctx.fillStyle = c.fg;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(label, lx, ly);
        }
      }
      if (layout.axis) {
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = c.muted;
        ctx.beginPath();
        ctx.moveTo(0, base + 0.5);
        ctx.lineTo(W, base + 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.font = `10px ${c.mono}`;
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = c.muted;
        const y = H - 3;
        ctx.textAlign = "left";
        ctx.fillText("0", 4, y);
        ctx.textAlign = "center";
        for (const v of [64, 128, 192]) ctx.fillText(String(v), v * cell, y);
        ctx.textAlign = "right";
        ctx.fillText("255", W - 4, y);
      }
    }

    function scheduleDraw() {
      if (frame !== 0 || destroyed) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    }

    function refresh() {
      renderText();
      scheduleDraw();
    }

    function setProbe(next) {
      if (next === probe || (next !== null && !analysis)) return;
      probe = next;
      renderProbeText();
      scheduleDraw();
      emit("probe", probePayload());
    }

    function assertAlive() {
      if (destroyed) throw new Error("t3kit.histogram: instance destroyed");
    }

    function update(source) {
      assertAlive();
      const mine = ++seq;
      const started = performance.now();
      if (source === null) {
        analysis = null;
        probe = null;
        refresh();
        emit("analyze");
        return Promise.resolve(get());
      }
      return sampleSource(source, edge, scalers).then(
        (sample) => {
          if (mine !== seq || destroyed) return null;
          analysis = { ...sample, ...measure(sample.px, state.clip) };
          analysis.ms = Math.round((performance.now() - started) * 10) / 10;
          if (probe !== null) emit("probe", probePayload());
          refresh();
          emit("analyze");
          return get();
        },
        (error) => {
          if (mine !== seq || destroyed) return null;
          throw error;
        },
      );
    }

    function set(partial) {
      assertAlive();
      for (const k of Object.keys(partial)) {
        if (!SET_KEYS.includes(k))
          throw new RangeError(
            `t3kit.histogram.set: unknown key '${k}' (media goes through update())`,
          );
      }
      if (partial.density !== undefined) checkDensity(partial.density);
      const clip = partial.clip !== undefined ? { ...state.clip, ...partial.clip } : state.clip;
      checkClip(clip);
      const channels =
        partial.channels !== undefined
          ? mergeChannels(state.channels, partial.channels)
          : state.channels;
      if (partial.density !== undefined) state.density = partial.density;
      if (partial.controls !== undefined) state.controls = Boolean(partial.controls);
      state.channels = channels;
      if (partial.clip !== undefined) {
        state.clip = clip;
        if (analysis) Object.assign(analysis, measure(analysis.px, clip));
      }
      refresh();
    }

    for (const ch of CHANNELS) {
      chButtons[ch].addEventListener("click", () => {
        state.channels = { ...state.channels, [ch]: !state.channels[ch] };
        refresh();
        emit("change");
      });
    }
    for (const d of Object.keys(LAYOUT)) {
      dnButtons[d].addEventListener("click", () => {
        if (state.density === d) return;
        state.density = d;
        refresh();
        emit("change");
      });
    }

    // Hover probes resolve once per animation frame with the newest pointer x.
    let probeX = null;
    let probeFrame = 0;
    canvas.addEventListener("pointermove", (event) => {
      probeX = event.clientX;
      if (probeFrame) return;
      probeFrame = requestAnimationFrame(() => {
        probeFrame = 0;
        if (probeX === null || destroyed) return;
        const rect = canvas.getBoundingClientRect();
        setProbe(
          Math.min(BINS - 1, Math.max(0, Math.floor(((probeX - rect.left) / rect.width) * BINS))),
        );
      });
    });
    canvas.addEventListener("pointerleave", () => {
      probeX = null;
      setProbe(null);
    });
    canvas.addEventListener("blur", () => setProbe(null));
    canvas.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 8 : 1;
      const from = probe ?? 128;
      let next;
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = from - step;
      else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = from + step;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = BINS - 1;
      else if (event.key === "Escape") next = null;
      else return;
      event.preventDefault();
      setProbe(next === null ? null : Math.min(BINS - 1, Math.max(0, next)));
    });

    const resizeObserver = new ResizeObserver(scheduleDraw);
    resizeObserver.observe(plot);
    const unsubscribeTheme = subscribeTheme(scheduleDraw);
    refresh();

    return {
      update,
      get,
      set,
      on(event, cb) {
        if (!Object.hasOwn(handlers, event))
          throw new RangeError(
            `t3kit.histogram: unknown event '${event}' (change, analyze, probe)`,
          );
        handlers[event].add(cb);
        return () => handlers[event].delete(cb);
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        cancelAnimationFrame(frame);
        cancelAnimationFrame(probeFrame);
        unsubscribeTheme();
        resizeObserver.disconnect();
        root.remove();
        for (const set of Object.values(handlers)) set.clear();
        analysis = null;
        for (const sc of Object.values(scalers)) {
          sc.canvas = null;
          sc.ctx = null;
        }
      },
    };
  }

  t3kit.histogram = { create };
})();
