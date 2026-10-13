/**
 * t3kit.waveform: audio waveform for a media Blob with zoom/scroll, region selection, playhead and playback.
 *
 * create(container, options?)   all optional
 *   media     Blob | File | blob: URL decoded now (else call setMedia); inst.ready is its Promise
 *   value     initial { selection, zoom }       height  minimum track height px (default 160)
 *   controls  built-in toolbar (default true)   overview  navigator bar under the track (default true)
 *   follow    keep playhead in view while playing (default true)   loop  loop selection (default false)
 *   normalize scale the display to the loudest peak (default true; display only)
 *
 * Value (get / set / 'change')   { selection: { start, end }, zoom }   seconds, ms precision.
 *   start === end means no selection. zoom 1 = whole file fits; max zoom shows a 10 ms span.
 *   Scroll position is view state, not value.
 *
 * Instance
 *   get() -> value        set({ selection?, zoom? })  no 'change'; selection null clears; bad numbers throw
 *   setMedia(blobOrUrl) -> Promise<{ duration }>   Web Audio decode (video files work); playhead -> 0
 *   play()  pause()  seek(sec)  playSelection({ loop? })   sample-accurate stop / loop at selection end
 *   getPlayhead()  getDuration()  isPlaying()  scrollTo(sec) centres view   on(event, cb) -> unsubscribe
 *   setAudioChain(build | null)  playback runs through build(ctx, input) -> last AudioNode (connected to the speakers);
 *          called once a context exists, again after each setAudioChain. null plays straight out.   destroy()
 *
 * Events
 *   'change'   get()            user edited selection or zoom (drag, handles, keys, wheel, buttons)
 *   'playhead' seconds          seek, scrub, and every frame while playing
 *   'playback' { playing }      playback started or stopped     'ready'  { duration }  media decoded
 *   'error'    Error            decode or playback failure (also shown in the track)
 *
 * Mouse  drag wave = select, Shift+click = extend, click = seek + clear, drag ruler = scrub, drag handles
 *        = trim, Ctrl/Cmd/Alt+wheel = zoom at pointer, Shift/horizontal wheel = scroll, overview = pan.
 * Keys   Space play/pause, Shift+Space play selection, Left/Right 0.1 s (Shift 1 s), Home/End, I/O set
 *        in/out at playhead, Esc clear, Ctrl/Cmd+A select all, +/- zoom, 0 fit, Z zoom to selection, L loop.
 *
 * Example
 *   const wf = t3kit.waveform.create(el, { height: 200 });
 *   wf.on('change', (v) => console.log(v.selection, v.zoom));
 *   await wf.setMedia(blob);                       // or a blob: URL
 *   wf.set({ selection: { start: 1, end: 4 }, zoom: 2 });
 *   wf.playSelection();
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});

  const SR = 44100; // decode sample rate
  const BASE = 16; // samples per finest peak bucket
  const RULER_H = 22; // css px of the time ruler band
  const MIN_SPAN = 0.01; // shortest visible span in seconds (maximum zoom)
  const CHUNK = 1 << 16; // peak buckets built per task before yielding
  const STEPS = [
    0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300,
    600, 1800, 3600,
  ];
  const svg = (body) =>
    `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor">${body}</svg>`;
  const ICON = {
    play: svg('<path d="M4 2.5v11l9-5.5z"/>'),
    pause: svg(
      '<rect x="3.5" y="2.5" width="3" height="11" rx=".5"/><rect x="9.5" y="2.5" width="3" height="11" rx=".5"/>',
    ),
    sel: svg('<path d="M1.5 2.5h1.5v11H1.5zM13 2.5h1.5v11H13zM5 4.5v7l6-3.5z"/>'),
    start: svg('<path d="M3 2.5h1.75v11H3zM13 2.5v11L5.5 8z"/>'),
    loop: svg(
      '<path d="M4 5h6.5V3l3 3-3 3V7H4.5A1.5 1.5 0 0 0 3 8.5V9H1.5v-.5A3.5 3.5 0 0 1 4 5zm8 6H5.5v2l-3-3 3-3v2h6A1.5 1.5 0 0 0 13 7.5V7h1.5v.5A3.5 3.5 0 0 1 12 11z"/>',
    ),
  };

  const CSS = `
.t3k-waveform-root{display:flex;flex-direction:column;gap:8px;width:100%;height:100%;min-height:0;box-sizing:border-box;color:var(--foreground);font-family:var(--font-sans);font-size:12px;line-height:1.4}
.t3k-waveform-root [hidden]{display:none!important}
.t3k-waveform-root:focus{outline:none}
.t3k-waveform-root:focus-visible{outline:2px solid var(--ring);outline-offset:2px;border-radius:var(--radius)}
.t3k-waveform-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.t3k-waveform-group{display:inline-flex;align-items:center;gap:2px}
.t3k-waveform-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;min-width:28px;padding:0 10px;box-sizing:border-box;border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);background:var(--card);color:var(--foreground);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.t3k-waveform-btn[data-icon]{padding:0}
.t3k-waveform-btn:hover:not(:disabled){background:color-mix(in srgb,var(--foreground) 7%,var(--card))}
.t3k-waveform-btn:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.t3k-waveform-btn:disabled{opacity:.45;cursor:default}
.t3k-waveform-btn[data-act="toggle"]{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}
.t3k-waveform-btn[data-act="toggle"]:hover:not(:disabled){background:color-mix(in srgb,var(--primary-foreground) 12%,var(--primary))}
.t3k-waveform-btn[aria-pressed="true"]{border-color:var(--primary);color:var(--primary);background:color-mix(in srgb,var(--primary) 12%,var(--card))}
.t3k-waveform-readout{font-family:var(--font-mono);font-variant-numeric:tabular-nums;color:var(--muted-foreground);white-space:nowrap}
.t3k-waveform-readout[data-role="time"]{color:var(--foreground);padding:0 4px}
.t3k-waveform-readout[data-role="zoomro"]{min-width:44px;text-align:center}
.t3k-waveform-spacer{flex:1 1 auto}
.t3k-waveform-track{position:relative;flex:1 1 auto;min-height:160px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);overflow:hidden;cursor:crosshair;touch-action:none;user-select:none}
.t3k-waveform-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.t3k-waveform-status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;color:var(--muted-foreground);pointer-events:none}
.t3k-waveform-status[data-kind="error"]{color:var(--destructive)}
.t3k-waveform-playhead{position:absolute;top:0;bottom:0;left:0;width:1px;background:var(--foreground);pointer-events:none;z-index:2;will-change:transform}
.t3k-waveform-playhead::before{content:"";position:absolute;top:0;left:-5px;width:11px;height:7px;background:var(--foreground);clip-path:polygon(0 0,100% 0,50% 100%)}
.t3k-waveform-handle{position:absolute;top:0;bottom:0;left:0;width:12px;margin-left:-6px;cursor:ew-resize;touch-action:none;outline:none;z-index:3}
.t3k-waveform-handle::before{content:"";position:absolute;left:5px;top:0;bottom:0;width:2px;background:var(--primary)}
.t3k-waveform-handle::after{content:"";position:absolute;left:2px;top:3px;width:8px;height:14px;border-radius:3px;background:var(--primary)}
.t3k-waveform-handle:focus-visible::after{outline:2px solid var(--ring);outline-offset:1px}
.t3k-waveform-overview{position:relative;flex:0 0 30px;height:30px;border:1px solid var(--border);border-radius:var(--radius);background:var(--muted);overflow:hidden;cursor:pointer;touch-action:none;user-select:none}
.t3k-waveform-overview canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.t3k-waveform-ovsel{position:absolute;top:0;bottom:0;left:0;background:var(--primary);opacity:.3;pointer-events:none}
.t3k-waveform-ovhead{position:absolute;top:0;bottom:0;left:0;width:1px;background:var(--foreground);opacity:.8;pointer-events:none;z-index:2}
.t3k-waveform-window{position:absolute;top:0;bottom:0;left:0;min-width:4px;cursor:grab;z-index:1}
.t3k-waveform-window::before{content:"";position:absolute;inset:0;background:var(--primary);opacity:.14}
.t3k-waveform-window::after{content:"";position:absolute;inset:0;border-radius:2px;box-shadow:inset 0 0 0 1px var(--primary)}
`;

  const MARKUP = `
<div class="t3k-waveform-bar" data-role="bar">
  <button type="button" class="t3k-waveform-btn" data-act="toggle" data-icon aria-label="Play" title="Play / Pause (Space)"></button>
  <button type="button" class="t3k-waveform-btn" data-act="sel" title="Play Selection (Shift+Space)">${ICON.sel}Play Selection</button>
  <button type="button" class="t3k-waveform-btn" data-act="loop" aria-pressed="false" title="Loop Selection (L)">${ICON.loop}Loop</button>
  <button type="button" class="t3k-waveform-btn" data-act="start" data-icon aria-label="Go to start" title="Go to Start (Home)">${ICON.start}</button>
  <span class="t3k-waveform-readout" data-role="time"></span>
  <span class="t3k-waveform-spacer"></span>
  <span class="t3k-waveform-readout" data-role="selro"></span>
  <button type="button" class="t3k-waveform-btn" data-act="clear" title="Clear Selection (Esc)">Clear</button>
  <span class="t3k-waveform-group">
    <button type="button" class="t3k-waveform-btn" data-act="zout" data-icon aria-label="Zoom out" title="Zoom Out (-)">&minus;</button>
    <span class="t3k-waveform-readout" data-role="zoomro"></span>
    <button type="button" class="t3k-waveform-btn" data-act="zin" data-icon aria-label="Zoom in" title="Zoom In (+)">+</button>
  </span>
  <button type="button" class="t3k-waveform-btn" data-act="zsel" title="Zoom to Selection (Z)">Zoom Sel</button>
  <button type="button" class="t3k-waveform-btn" data-act="fit" title="Fit Whole File (0)">Fit</button>
</div>
<div class="t3k-waveform-track" data-role="track">
  <canvas class="t3k-waveform-canvas" data-role="wave"></canvas>
  <div class="t3k-waveform-status" data-role="status" hidden></div>
  <div class="t3k-waveform-playhead" data-role="head" hidden></div>
  <div class="t3k-waveform-handle" data-role="h-start" role="slider" tabindex="0" aria-label="Selection start" hidden></div>
  <div class="t3k-waveform-handle" data-role="h-end" role="slider" tabindex="0" aria-label="Selection end" hidden></div>
</div>
<div class="t3k-waveform-overview" data-role="overview">
  <canvas data-role="ov"></canvas>
  <div class="t3k-waveform-ovsel" data-role="ovsel" hidden></div>
  <div class="t3k-waveform-window" data-role="win" hidden></div>
  <div class="t3k-waveform-ovhead" data-role="ovhead" hidden></div>
</div>`;

  function injectStyle() {
    if (document.head.querySelector('style[data-t3kit="waveform"]')) return;
    const style = document.createElement("style");
    style.dataset.t3kit = "waveform";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function createEmitter() {
    const listeners = new Map();
    return {
      on(type, cb) {
        if (typeof cb !== "function") throw new TypeError("waveform on() needs a callback");
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(cb);
        return () => listeners.get(type).delete(cb);
      },
      emit(type, payload) {
        const set = listeners.get(type);
        if (set) for (const cb of [...set]) cb(payload);
      },
    };
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad2 = (n) => String(n).padStart(2, "0");
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0));

  function fmt(t, decimals = 2) {
    const v = Number.isFinite(t) && t > 0 ? t : 0;
    const m = Math.floor(v / 60);
    const s = (v - m * 60).toFixed(decimals);
    return `${pad2(m)}:${s.padStart(decimals + 3, "0")}`;
  }

  function tickLabel(t, step) {
    if (step < 0.01) return fmt(t, 3);
    if (step < 1) return fmt(t, 2);
    const s = Math.round(t);
    return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
  }

  function finite(v, name) {
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new TypeError(`waveform ${name} must be a finite number`);
    return v;
  }

  function tokens() {
    const cs = getComputedStyle(document.documentElement);
    const get = (name) => cs.getPropertyValue(name).trim();
    return {
      card: get("--card"),
      border: get("--border"),
      fg: get("--foreground"),
      muted: get("--muted-foreground"),
      primary: get("--primary"),
      mono: get("--font-mono"),
    };
  }

  function sizeCanvas(canvas, w, h) {
    const dpr = window.devicePixelRatio;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  // Finest level: min/max per BASE samples across all channels, built in slices so long files stay responsive.
  async function buildBasePeaks(chans, isStale) {
    const n = chans[0].length;
    const nb = Math.ceil(n / BASE);
    const min = new Float32Array(nb);
    const max = new Float32Array(nb);
    let peak = 0;
    for (let c0 = 0; c0 < nb; c0 += CHUNK) {
      const c1 = Math.min(nb, c0 + CHUNK);
      for (let b = c0; b < c1; b++) {
        let lo = 1;
        let hi = -1;
        const end = Math.min(n, (b + 1) * BASE);
        for (const data of chans) {
          for (let s = b * BASE; s < end; s++) {
            const v = data[s];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        min[b] = lo;
        max[b] = hi;
        if (hi > peak) peak = hi;
        if (-lo > peak) peak = -lo;
      }
      if (c1 < nb) {
        await yieldTask();
        if (isStale()) return null;
      }
    }
    return { level: { bs: BASE, n: nb, min, max }, peak };
  }

  // Each coarser level merges pairs of the level below; levels are built lazily and cached per zoom octave.
  function coarserLevel(p) {
    const n = Math.ceil(p.n / 2);
    const min = new Float32Array(n);
    const max = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = 2 * i;
      const b = Math.min(a + 1, p.n - 1);
      min[i] = Math.min(p.min[a], p.min[b]);
      max[i] = Math.max(p.max[a], p.max[b]);
    }
    return { bs: p.bs * 2, n, min, max };
  }

  function scanPeaks(lv, sa, spp, out) {
    const b0 = Math.floor(sa / lv.bs);
    if (b0 < 0 || b0 >= lv.n) return false;
    const b1 = Math.min(lv.n, Math.max(b0 + 1, Math.ceil((sa + spp) / lv.bs)));
    let lo = 1;
    let hi = -1;
    for (let b = b0; b < b1; b++) {
      if (lv.min[b] < lo) lo = lv.min[b];
      if (lv.max[b] > hi) hi = lv.max[b];
    }
    if (hi < lo) return false;
    out.lo = lo;
    out.hi = hi;
    return true;
  }

  // Sample-accurate scan used when one pixel covers less than one peak bucket.
  function scanRaw(chans, sa, spp, out) {
    const s0 = Math.max(0, Math.floor(sa));
    const s1 = Math.max(s0 + 1, Math.ceil(sa + spp));
    let lo = 1;
    let hi = -1;
    for (const data of chans) {
      const end = Math.min(s1, data.length);
      for (let s = s0; s < end; s++) {
        const v = data[s];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (hi < lo) return false;
    out.lo = lo;
    out.hi = hi;
    return true;
  }

  function create(container, options = {}) {
    if (!(container instanceof HTMLElement))
      throw new TypeError("waveform create() needs a container element");
    injectStyle();
    const emitter = createEmitter();
    const follow = options.follow ?? true;
    const normalize = options.normalize ?? true;
    const ac = new AbortController();
    const sig = { signal: ac.signal };
    const scratch = { lo: 0, hi: 0 };

    const root = document.createElement("div");
    root.className = "t3k-waveform-root";
    root.tabIndex = 0;
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Audio waveform");
    root.innerHTML = MARKUP;
    container.appendChild(root);

    const $ = (sel) => root.querySelector(sel);
    const el = {
      bar: $('[data-role="bar"]'),
      toggle: $('[data-act="toggle"]'),
      sel: $('[data-act="sel"]'),
      loop: $('[data-act="loop"]'),
      start: $('[data-act="start"]'),
      clear: $('[data-act="clear"]'),
      zout: $('[data-act="zout"]'),
      zin: $('[data-act="zin"]'),
      zsel: $('[data-act="zsel"]'),
      fit: $('[data-act="fit"]'),
      time: $('[data-role="time"]'),
      selro: $('[data-role="selro"]'),
      zoomro: $('[data-role="zoomro"]'),
      track: $('[data-role="track"]'),
      wave: $('[data-role="wave"]'),
      status: $('[data-role="status"]'),
      head: $('[data-role="head"]'),
      hs: $('[data-role="h-start"]'),
      he: $('[data-role="h-end"]'),
      overview: $('[data-role="overview"]'),
      ov: $('[data-role="ov"]'),
      ovsel: $('[data-role="ovsel"]'),
      win: $('[data-role="win"]'),
      ovhead: $('[data-role="ovhead"]'),
    };
    el.bar.hidden = options.controls === false;
    el.overview.hidden = options.overview === false;
    el.track.style.minHeight = `${options.height ?? 160}px`;

    const st = {
      buffer: null,
      duration: 0,
      sampleRate: SR,
      channels: [],
      levels: [],
      gain: 1,
      selection: { start: 0, end: 0 },
      zoom: 1,
      scroll: 0,
      playhead: 0,
      loop: !!options.loop,
    };
    const dirty = { wave: true, overview: true, chrome: true };
    let rafId = 0;
    let loadToken = 0;
    let drag = null;
    let ovDrag = null;
    let destroyed = false;
    let iconPlaying = null;
    // Playback: one AudioBufferSourceNode at a time, positioned from the AudioContext clock.
    let actx = null;
    let node = null;
    let chainBuild = null; // setAudioChain: playback -> chainIn -> build(...) -> speakers
    let chainIn = null;
    let chainOut = null;
    let clock = null; // { t0, from, start, end, loop }

    const playing = () => clock !== null;
    const hasSel = () => st.selection.end > st.selection.start;
    const span = () => st.duration / st.zoom;
    const pps = () => el.track.clientWidth / span();
    const zoomCeiling = () => (st.duration ? Math.max(1, st.duration / MIN_SPAN) : Infinity);
    const clampScroll = (s) => clamp(s, 0, Math.max(0, st.duration - span()));
    const trackLeft = () => el.track.getBoundingClientRect().left + el.track.clientLeft;
    const timeAt = (clientX) =>
      st.duration ? clamp(st.scroll + (clientX - trackLeft()) / pps(), 0, st.duration) : 0;
    const ovTime = (clientX) => {
      const r = el.overview.getBoundingClientRect();
      return (
        clamp((clientX - r.left - el.overview.clientLeft) / el.overview.clientWidth, 0, 1) *
        st.duration
      );
    };
    const defaultAnchor = () => {
      const inView = st.playhead >= st.scroll && st.playhead <= st.scroll + span();
      return inView ? st.playhead : st.scroll + span() / 2;
    };

    // Pointer drags apply once per animation frame with the newest x; flush() applies a pending one now (release).
    function perFrame(apply) {
      let pending = null;
      let id = 0;
      const run = () => {
        id = 0;
        const x = pending;
        pending = null;
        if (x !== null && !destroyed) apply(x);
      };
      return {
        move(clientX) {
          pending = clientX;
          if (!id) id = requestAnimationFrame(run);
        },
        flush() {
          if (id) cancelAnimationFrame(id);
          run();
        },
      };
    }

    function invalidate(...parts) {
      for (const p of parts) dirty[p] = true;
      if (!rafId && !destroyed) rafId = requestAnimationFrame(frame);
    }
    const invalidateView = () => invalidate("wave", "chrome");

    function frame() {
      rafId = 0;
      if (playing()) advancePlayhead();
      const c = dirty.wave || dirty.overview ? tokens() : null;
      if (dirty.wave) drawWave(c);
      if (dirty.overview) drawOverview(c);
      if (dirty.wave || dirty.overview || dirty.chrome) updateChrome();
      dirty.wave = dirty.overview = dirty.chrome = false;
      if (playing()) invalidate("chrome");
    }

    function setStatus(text, kind) {
      el.status.textContent = text;
      el.status.dataset.kind = kind ?? "";
      el.status.hidden = !text;
    }

    function levelFor(L) {
      while (st.levels.length <= L) st.levels.push(coarserLevel(st.levels[st.levels.length - 1]));
      return st.levels[L];
    }

    function normSelection(s) {
      if (s === null) return { start: 0, end: 0 };
      if (typeof s !== "object")
        throw new TypeError("waveform selection must be { start, end } or null");
      const hi = st.duration || Infinity;
      const a = clamp(finite(s.start, "selection.start"), 0, hi);
      const b = clamp(finite(s.end, "selection.end"), 0, hi);
      return a <= b ? { start: a, end: b } : { start: b, end: a };
    }

    function setSelection(start, end, emit) {
      const next = normSelection({ start, end });
      if (next.start === st.selection.start && next.end === st.selection.end) return;
      st.selection = next;
      invalidate("wave", "chrome");
      if (emit) emitter.emit("change", get());
    }

    function revealSelection() {
      if (!st.duration || !hasSel()) return;
      const { start, end } = st.selection;
      const sp = span();
      if (start >= st.scroll && end <= st.scroll + sp) return;
      st.scroll = clampScroll(end - start > sp ? start - sp * 0.05 : (start + end) / 2 - sp / 2);
    }

    function setZoom(z, anchorT, emit) {
      if (!st.duration) return;
      const prev = st.zoom;
      const anchor = anchorT ?? defaultAnchor();
      const frac = (anchor - st.scroll) / span();
      st.zoom = clamp(z, 1, zoomCeiling());
      if (st.zoom === prev) return;
      st.scroll = clampScroll(anchor - frac * span());
      invalidateView();
      if (emit) emitter.emit("change", get());
    }

    function zoomToSelection(emit) {
      if (!st.duration || !hasSel()) return;
      const { start, end } = st.selection;
      const len = end - start;
      const prev = st.zoom;
      st.zoom = clamp(st.duration / (len * 1.1), 1, zoomCeiling());
      st.scroll = clampScroll((start + end) / 2 - span() / 2);
      invalidateView();
      if (emit && st.zoom !== prev) emitter.emit("change", get());
    }

    function keepPlayheadVisible() {
      if (!st.duration) return;
      const sp = span();
      if (st.playhead < st.scroll || st.playhead > st.scroll + sp * 0.97) {
        st.scroll = clampScroll(st.playhead - sp * 0.08);
        invalidateView();
      }
    }

    function edgeScroll(clientX) {
      const r = el.track.getBoundingClientRect();
      const over = clientX < r.left ? clientX - r.left : clientX > r.right ? clientX - r.right : 0;
      if (!over) return;
      st.scroll = clampScroll(st.scroll + (over * 0.5) / pps());
      invalidateView();
    }

    function reportError(err) {
      emitter.emit("error", err);
    }

    // ---------- playback ----------
    function clockPosition() {
      const elapsed = actx.currentTime - clock.t0;
      if (clock.loop) {
        const len = clock.end - clock.start;
        return clock.start + ((clock.from - clock.start + elapsed) % len);
      }
      return Math.min(clock.end, clock.from + elapsed);
    }

    function stopNode() {
      if (!node) return;
      const n = node;
      node = null;
      n.onended = null;
      n.stop();
      n.disconnect();
    }

    // Plays [from, end); `start` is the region start used for looping and for seeks that stay in the region.
    function startPlayback(from, end, loop, start = from) {
      stopNode();
      const wasPlaying = playing();
      if (!actx) actx = new AudioContext();
      if (actx.state !== "running") actx.resume().catch(reportError);
      const n = actx.createBufferSource();
      n.buffer = st.buffer;
      n.connect(audioInput());
      if (loop) {
        n.loop = true;
        n.loopStart = start;
        n.loopEnd = end;
        n.start(0, from);
      } else {
        n.start(0, from, end - from);
      }
      n.onended = () => {
        if (node !== n) return;
        node = null;
        st.playhead = clock.end;
        clock = null;
        emitter.emit("playhead", st.playhead);
        emitter.emit("playback", { playing: false });
        invalidate("chrome");
      };
      node = n;
      clock = { t0: actx.currentTime, from, start, end, loop };
      st.playhead = from;
      if (!wasPlaying) emitter.emit("playback", { playing: true });
      invalidate("chrome");
    }

    // Where playback connects: the speakers, or the input of the chain from setAudioChain (built on first use).
    function audioInput() {
      if (!chainBuild) return actx.destination;
      if (!chainOut) {
        chainIn = actx.createGain();
        const out = chainBuild(actx, chainIn);
        if (!(out instanceof AudioNode))
          throw new TypeError(
            "t3kit.waveform: setAudioChain build(ctx, input) must return an AudioNode",
          );
        out.connect(actx.destination);
        chainOut = out;
      }
      return chainIn;
    }
    function setAudioChain(build) {
      if (build !== null && typeof build !== "function")
        throw new TypeError(
          "t3kit.waveform: setAudioChain(build | null) needs a function (ctx, input) => AudioNode",
        );
      if (chainIn) chainIn.disconnect();
      if (chainOut) chainOut.disconnect();
      chainIn = null;
      chainOut = null;
      chainBuild = build;
      if (node && actx) {
        node.disconnect();
        node.connect(audioInput()); // re-routes the sound that is playing now
      }
    }

    function advancePlayhead() {
      st.playhead = clockPosition();
      emitter.emit("playhead", st.playhead);
      if (follow) keepPlayheadVisible();
    }

    function play() {
      if (!st.duration) return;
      const from = st.playhead >= st.duration - 0.01 ? 0 : st.playhead;
      startPlayback(from, st.duration, false);
    }

    function playSelection(opts) {
      if (!st.duration) return;
      if (!hasSel()) return play();
      const loop = opts && opts.loop !== undefined ? !!opts.loop : st.loop;
      startPlayback(st.selection.start, st.selection.end, loop, st.selection.start);
    }

    function pause() {
      if (!playing()) return;
      st.playhead = clockPosition();
      stopNode();
      clock = null;
      emitter.emit("playhead", st.playhead);
      emitter.emit("playback", { playing: false });
      invalidate("chrome");
    }

    function seek(t) {
      if (!st.duration) return;
      const target = clamp(finite(t, "seek time"), 0, st.duration);
      if (playing()) {
        // Stay inside the region while seeking within it; otherwise continue to the end of the file.
        const inRegion = clock.end < st.duration && target >= clock.start && target < clock.end;
        if (inRegion) startPlayback(target, clock.end, clock.loop, clock.start);
        else if (target < st.duration) startPlayback(target, st.duration, false);
        else pause();
      }
      st.playhead = target;
      emitter.emit("playhead", st.playhead);
      invalidate("chrome");
    }

    // ---------- value ----------
    function get() {
      return {
        selection: { start: round3(st.selection.start), end: round3(st.selection.end) },
        zoom: round3(st.zoom),
      };
    }

    function set(partial) {
      if (!partial || typeof partial !== "object")
        throw new TypeError("waveform set() expects { selection?, zoom? }");
      if (partial.selection !== undefined) st.selection = normSelection(partial.selection);
      if (partial.zoom !== undefined) {
        const centre = st.scroll + span() / 2;
        st.zoom = clamp(finite(partial.zoom, "zoom"), 1, zoomCeiling());
        if (st.duration) st.scroll = clampScroll(centre - span() / 2);
      }
      if (partial.selection) revealSelection();
      st.scroll = clampScroll(st.scroll);
      invalidate("wave", "chrome");
    }

    function scrollTo(t) {
      st.scroll = clampScroll(finite(t, "scrollTo time") - span() / 2);
      invalidateView();
    }

    // ---------- media ----------
    function setMedia(media) {
      const token = ++loadToken;
      const isStale = () => token !== loadToken || destroyed;
      pause();
      setStatus("Decoding audio…");
      const run = async () => {
        let blob = media;
        if (typeof media === "string") {
          const res = await fetch(media);
          if (!res.ok) throw new Error(`waveform could not fetch media (${res.status})`);
          blob = await res.blob();
        }
        if (!(blob instanceof Blob))
          throw new TypeError("waveform setMedia() expects a Blob, File or URL string");
        const buffer = await new OfflineAudioContext(1, 1, SR).decodeAudioData(
          await blob.arrayBuffer(),
        );
        if (isStale()) return { duration: buffer.duration };
        const chans = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
        const built = await buildBasePeaks(chans, isStale);
        if (!built || isStale()) return { duration: buffer.duration };
        pause();
        st.buffer = buffer;
        st.duration = buffer.duration;
        st.sampleRate = buffer.sampleRate;
        st.channels = chans;
        st.levels = [built.level];
        st.gain = normalize && built.peak > 0 ? 1 / built.peak : 1;
        st.playhead = 0;
        st.scroll = 0;
        st.zoom = clamp(st.zoom, 1, zoomCeiling());
        st.selection = normSelection(st.selection);
        revealSelection();
        setStatus("");
        invalidate("wave", "overview", "chrome");
        emitter.emit("ready", { duration: st.duration });
        return { duration: st.duration };
      };
      return run().catch((err) => {
        if (token === loadToken && !destroyed)
          setStatus(`Could not decode audio: ${err.message}`, "error");
        reportError(err);
        throw err;
      });
    }

    // ---------- drawing ----------
    function drawRuler(ctx, W, p, c) {
      const t0 = st.scroll;
      const step = STEPS.find((s) => s * p >= 84) ?? STEPS[STEPS.length - 1];
      const minor =
        step /
        (String(step)
          .replace(/^0\.0*/, "")
          .startsWith("2")
          ? 4
          : 5);
      ctx.globalAlpha = 0.035;
      ctx.fillStyle = c.fg;
      ctx.fillRect(0, 0, W, RULER_H);
      ctx.globalAlpha = 1;
      ctx.fillStyle = c.border;
      ctx.fillRect(0, RULER_H - 1, W, 1);
      const end = t0 + W / p;
      ctx.fillStyle = c.muted;
      if (minor * p >= 8) {
        ctx.globalAlpha = 0.5;
        for (let i = Math.ceil(t0 / minor); i * minor <= end; i++) {
          ctx.fillRect(Math.round((i * minor - t0) * p), RULER_H - 4, 1, 3);
        }
        ctx.globalAlpha = 1;
      }
      ctx.font = `10px ${c.mono}`;
      ctx.textBaseline = "top";
      for (let i = Math.ceil(t0 / step); i * step <= end; i++) {
        const t = i * step;
        const x = Math.round((t - t0) * p);
        ctx.fillRect(x, RULER_H - 8, 1, 7);
        ctx.fillText(tickLabel(t, step), x + 4, 4);
      }
    }

    // Deep zoom: fewer samples than device pixels, so draw the actual sample curve (and dots when sparse).
    function drawSamples(ctx, W, H, p, mid, amp, c, xs0, xs1, selOn) {
      const sr = st.sampleRate;
      const t0 = st.scroll;
      const s0 = Math.max(0, Math.floor(t0 * sr) - 1);
      const s1 = Math.min(st.channels[0].length - 1, Math.ceil((t0 + W / p) * sr) + 1);
      const nc = st.channels.length;
      const path = new Path2D();
      const pts = [];
      for (let s = s0; s <= s1; s++) {
        let v = 0;
        for (const data of st.channels) v += data[s];
        v = clamp((v / nc) * st.gain, -1, 1);
        const x = (s / sr - t0) * p;
        const y = mid - v * amp;
        if (s === s0) path.moveTo(x, y);
        else path.lineTo(x, y);
        pts.push(x, y);
      }
      const dots = p / sr >= 6;
      const paint = (color, alpha) => {
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";
        ctx.stroke(path);
        if (dots)
          for (let i = 0; i < pts.length; i += 2)
            ctx.fillRect(pts[i] - 1.5, pts[i + 1] - 1.5, 3, 3);
      };
      paint(c.muted, 0.75);
      if (selOn && xs1 > 0 && xs0 < W) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(xs0, RULER_H, xs1 - xs0, H - RULER_H);
        ctx.clip();
        paint(c.primary, 1);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    function drawWave(c) {
      const W = el.track.clientWidth;
      const H = el.track.clientHeight;
      const ctx = sizeCanvas(el.wave, W, H);
      ctx.fillStyle = c.card;
      ctx.fillRect(0, 0, W, H);
      if (!st.duration || W <= 0) return;
      const p = pps();
      const sr = st.sampleRate;
      const t0 = st.scroll;
      const mid = RULER_H + (H - RULER_H) / 2;
      const amp = (H - RULER_H) / 2 - 6;
      const selOn = hasSel();
      const xs0 = (st.selection.start - t0) * p;
      const xs1 = (st.selection.end - t0) * p;

      drawRuler(ctx, W, p, c);
      if (selOn && xs1 > 0 && xs0 < W) {
        const a = Math.max(0, xs0);
        ctx.globalAlpha = 0.14;
        ctx.fillStyle = c.primary;
        ctx.fillRect(a, RULER_H, Math.min(W, xs1) - a, H - RULER_H);
        ctx.globalAlpha = 0.24;
        ctx.fillRect(a, 0, Math.min(W, xs1) - a, RULER_H - 1);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = c.border;
      ctx.fillRect(0, Math.round(mid), W, 1);

      const dpr = window.devicePixelRatio;
      const sppD = sr / (p * dpr);
      if (sppD < 1) {
        drawSamples(ctx, W, H, p, mid, amp, c, xs0, xs1, selOn);
        return;
      }
      // Min/max columns per device pixel, from the cached peak level for this zoom (raw samples when finer).
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const PW = el.wave.width;
      const midD = mid * dpr;
      const ampD = amp * dpr;
      const raw = sppD < BASE;
      const lv = raw ? null : levelFor(Math.floor(Math.log2(sppD / BASE)));
      const pD = p * dpr;
      let inSel = null;
      for (let x = 0; x < PW; x++) {
        const sa = t0 * sr + x * sppD;
        const ok = raw ? scanRaw(st.channels, sa, sppD, scratch) : scanPeaks(lv, sa, sppD, scratch);
        if (!ok) continue;
        const t = t0 + x / pD;
        const sel = selOn && t >= st.selection.start && t < st.selection.end;
        if (sel !== inSel) {
          inSel = sel;
          ctx.fillStyle = sel ? c.primary : c.muted;
          ctx.globalAlpha = sel ? 1 : 0.6;
        }
        const hi = Math.min(1, scratch.hi * st.gain);
        const lo = Math.max(-1, scratch.lo * st.gain);
        ctx.fillRect(x, midD - hi * ampD, 1, Math.max(1, (hi - lo) * ampD));
      }
      ctx.globalAlpha = 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function drawOverview(c) {
      if (el.overview.hidden) return;
      const W = el.overview.clientWidth;
      const H = el.overview.clientHeight;
      const ctx = sizeCanvas(el.ov, W, H);
      ctx.clearRect(0, 0, W, H);
      if (!st.duration || W <= 0) return;
      const spp = (st.sampleRate * st.duration) / W;
      const raw = spp < BASE;
      const lv = raw ? null : levelFor(Math.floor(Math.log2(spp / BASE)));
      const mid = H / 2;
      const amp = H / 2 - 3;
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = c.muted;
      for (let x = 0; x < W; x++) {
        const ok = raw
          ? scanRaw(st.channels, x * spp, spp, scratch)
          : scanPeaks(lv, x * spp, spp, scratch);
        if (!ok) continue;
        const hi = Math.min(1, scratch.hi * st.gain);
        const lo = Math.max(-1, scratch.lo * st.gain);
        ctx.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
      ctx.globalAlpha = 1;
    }

    const pct = (t) => `${(t / st.duration) * 100}%`;

    function updateChrome() {
      const on = hasSel();
      const { start, end } = st.selection;
      const isPlaying = playing();
      if (iconPlaying !== isPlaying) {
        iconPlaying = isPlaying;
        el.toggle.innerHTML = isPlaying ? ICON.pause : ICON.play;
        el.toggle.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
      }
      el.time.textContent = `${fmt(st.playhead)} / ${fmt(st.duration)}`;
      const dp = end - start < 0.1 ? 3 : 2;
      el.selro.textContent = on
        ? `${fmt(start, dp)} – ${fmt(end, dp)} · ${(end - start).toFixed(dp)} s`
        : "No selection";
      el.zoomro.textContent = `${st.zoom < 10 ? st.zoom.toFixed(1) : Math.round(st.zoom)}×`;
      el.loop.setAttribute("aria-pressed", String(st.loop));
      const ready = st.duration > 0;
      for (const b of [el.toggle, el.start, el.zout, el.zin, el.fit]) b.disabled = !ready;
      el.clear.disabled = el.sel.disabled = el.zsel.disabled = !on;
      el.zout.disabled = !ready || st.zoom <= 1;
      el.zin.disabled = !ready || st.zoom >= zoomCeiling();
      if (!ready) {
        for (const n of [el.hs, el.he, el.head, el.win, el.ovsel, el.ovhead]) n.hidden = true;
        return;
      }
      const W = el.track.clientWidth;
      const p = pps();
      const place = (h, t) => {
        const x = (t - st.scroll) * p;
        h.hidden = !(on && x >= -6 && x <= W + 6);
        h.style.transform = `translateX(${x}px)`;
        h.setAttribute("aria-valuemin", "0");
        h.setAttribute("aria-valuemax", st.duration.toFixed(3));
        h.setAttribute("aria-valuenow", t.toFixed(3));
        h.setAttribute("aria-valuetext", fmt(t));
      };
      place(el.hs, start);
      place(el.he, end);
      const xp = (st.playhead - st.scroll) * p;
      el.head.hidden = xp < -1 || xp > W + 1;
      el.head.style.transform = `translateX(${Math.round(xp)}px)`;
      el.win.hidden = false;
      el.win.style.left = pct(st.scroll);
      el.win.style.width = pct(span());
      el.ovsel.hidden = !on;
      el.ovsel.style.left = pct(start);
      el.ovsel.style.width = pct(end - start);
      el.ovhead.hidden = false;
      el.ovhead.style.left = pct(st.playhead);
    }

    // ---------- input: track ----------
    el.track.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0 || !st.duration) return;
        root.focus({ preventScroll: true });
        const y = e.clientY - el.track.getBoundingClientRect().top;
        const t = timeAt(e.clientX);
        el.track.setPointerCapture(e.pointerId);
        e.preventDefault();
        if (y < RULER_H) {
          drag = { kind: "scrub" };
          seek(t);
          return;
        }
        drag = { kind: "select", anchor: t, x: e.clientX, moved: false };
        if (e.shiftKey && hasSel()) {
          const { start, end } = st.selection;
          drag.anchor = Math.abs(t - start) < Math.abs(t - end) ? end : start;
          drag.moved = true;
          setSelection(drag.anchor, t, true);
        }
      },
      sig,
    );

    const trackMove = perFrame((clientX) => {
      if (!drag) return;
      if (drag.kind === "scrub") {
        seek(timeAt(clientX));
        return;
      }
      if (!drag.moved && Math.abs(clientX - drag.x) < 3) return;
      drag.moved = true;
      edgeScroll(clientX);
      setSelection(drag.anchor, timeAt(clientX), true);
    });
    el.track.addEventListener("pointermove", (e) => drag && trackMove.move(e.clientX), sig);

    const endTrackDrag = () => {
      trackMove.flush();
      if (!drag) return;
      if (drag.kind === "select" && !drag.moved) {
        seek(drag.anchor);
        setSelection(0, 0, true);
      }
      drag = null;
    };
    el.track.addEventListener("pointerup", endTrackDrag, sig);
    el.track.addEventListener("pointercancel", endTrackDrag, sig);

    el.track.addEventListener(
      "wheel",
      (e) => {
        if (!st.duration) return;
        if (e.ctrlKey || e.metaKey || e.altKey) {
          e.preventDefault();
          setZoom(st.zoom * Math.exp(-e.deltaY * 0.0025), timeAt(e.clientX), true);
        } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          e.preventDefault();
          st.scroll = clampScroll(st.scroll + (e.deltaX || e.deltaY) / pps());
          invalidateView();
        }
      },
      { passive: false, signal: ac.signal },
    );

    // ---------- input: handles ----------
    const moveHandle = (which, t) => {
      const s = st.selection;
      if (which === "start") setSelection(Math.min(t, s.end), s.end, true);
      else setSelection(s.start, Math.max(t, s.start), true);
    };
    for (const which of ["start", "end"]) {
      const h = which === "start" ? el.hs : el.he;
      let active = false;
      h.addEventListener(
        "pointerdown",
        (e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.preventDefault();
          active = true;
          h.setPointerCapture(e.pointerId);
          h.focus({ preventScroll: true });
        },
        sig,
      );
      const handleMove = perFrame((clientX) => {
        if (!active) return;
        edgeScroll(clientX);
        moveHandle(which, timeAt(clientX));
      });
      h.addEventListener("pointermove", (e) => active && handleMove.move(e.clientX), sig);
      const release = () => {
        handleMove.flush();
        active = false;
      };
      h.addEventListener("pointerup", release, sig);
      h.addEventListener("pointercancel", release, sig);
      h.addEventListener(
        "keydown",
        (e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          e.stopPropagation();
          const dir = e.key === "ArrowLeft" ? -1 : 1;
          const step = e.shiftKey ? 1 : 0.1;
          moveHandle(
            which,
            (which === "start" ? st.selection.start : st.selection.end) + dir * step,
          );
        },
        sig,
      );
    }

    // ---------- input: overview (drag the window to pan, click elsewhere to jump) ----------
    el.overview.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0 || !st.duration) return;
        el.overview.setPointerCapture(e.pointerId);
        const t = ovTime(e.clientX);
        if (e.target === el.win) {
          ovDrag = { grab: t - st.scroll };
        } else {
          ovDrag = { grab: span() / 2 };
          st.scroll = clampScroll(t - span() / 2);
          invalidateView();
        }
      },
      sig,
    );
    const overviewMove = perFrame((clientX) => {
      if (!ovDrag) return;
      st.scroll = clampScroll(ovTime(clientX) - ovDrag.grab);
      invalidateView();
    });
    el.overview.addEventListener("pointermove", (e) => ovDrag && overviewMove.move(e.clientX), sig);
    const endOvDrag = () => {
      overviewMove.flush();
      ovDrag = null;
    };
    el.overview.addEventListener("pointerup", endOvDrag, sig);
    el.overview.addEventListener("pointercancel", endOvDrag, sig);

    // ---------- input: toolbar and keys ----------
    const toggleLoop = () => {
      st.loop = !st.loop;
      if (playing() && clock.end < st.duration)
        startPlayback(clockPosition(), clock.end, st.loop, clock.start);
      invalidate("chrome");
    };
    const goStart = () => {
      seek(0);
      keepPlayheadVisible();
    };
    el.toggle.addEventListener("click", () => (playing() ? pause() : play()), sig);
    el.sel.addEventListener("click", () => playSelection(), sig);
    el.loop.addEventListener("click", toggleLoop, sig);
    el.start.addEventListener("click", goStart, sig);
    el.clear.addEventListener("click", () => setSelection(0, 0, true), sig);
    el.zout.addEventListener("click", () => setZoom(st.zoom / 1.5, null, true), sig);
    el.zin.addEventListener("click", () => setZoom(st.zoom * 1.5, null, true), sig);
    el.zsel.addEventListener("click", () => zoomToSelection(true), sig);
    el.fit.addEventListener("click", () => setZoom(1, null, true), sig);

    root.addEventListener(
      "keydown",
      (e) => {
        if (!st.duration) return;
        if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
          e.preventDefault();
          setSelection(0, st.duration, true);
          return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        // Native button activation owns Space and Enter on focused buttons.
        if (
          e.target !== root &&
          e.target.tagName === "BUTTON" &&
          (e.key === " " || e.key === "Enter")
        )
          return;
        const nudge = (d) => {
          seek(st.playhead + d);
          keepPlayheadVisible();
        };
        switch (e.key) {
          case " ":
            if (e.shiftKey) playSelection();
            else if (playing()) pause();
            else play();
            break;
          case "ArrowLeft":
            nudge(e.shiftKey ? -1 : -0.1);
            break;
          case "ArrowRight":
            nudge(e.shiftKey ? 1 : 0.1);
            break;
          case "Home":
            goStart();
            break;
          case "End":
            seek(st.duration);
            keepPlayheadVisible();
            break;
          case "i":
          case "I":
            setSelection(
              st.playhead,
              st.selection.end > st.playhead ? st.selection.end : st.duration,
              true,
            );
            break;
          case "o":
          case "O":
            setSelection(
              st.selection.start < st.playhead ? st.selection.start : 0,
              st.playhead,
              true,
            );
            break;
          case "Escape":
            setSelection(0, 0, true);
            break;
          case "+":
          case "=":
            setZoom(st.zoom * 1.5, null, true);
            break;
          case "-":
          case "_":
            setZoom(st.zoom / 1.5, null, true);
            break;
          case "0":
            setZoom(1, null, true);
            break;
          case "z":
          case "Z":
            zoomToSelection(true);
            break;
          case "l":
          case "L":
            toggleLoop();
            break;
          default:
            return;
        }
        e.preventDefault();
      },
      sig,
    );

    // ---------- size and theme ----------
    const ro = new ResizeObserver(() => invalidate("wave", "overview", "chrome"));
    ro.observe(el.track);
    ro.observe(el.overview);
    const retheme = () => invalidate("wave", "overview");
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme"],
    });
    mo.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    const themeEl = document.getElementById("t3-theme");
    if (themeEl && !document.head.contains(themeEl)) {
      mo.observe(themeEl, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    }
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", retheme, sig);

    const inst = {
      get,
      set,
      setMedia,
      play,
      pause,
      seek,
      playSelection,
      scrollTo,
      getPlayhead: () => st.playhead,
      getDuration: () => st.duration,
      isPlaying: playing,
      setAudioChain,
      on: emitter.on,
      ready: null,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        ac.abort();
        cancelAnimationFrame(rafId);
        ro.disconnect();
        mo.disconnect();
        stopNode();
        clock = null;
        if (actx) actx.close();
        root.remove();
      },
    };

    setStatus("Load media to see its waveform");
    if (options.value) set(options.value);
    invalidate("wave", "overview", "chrome");
    inst.ready = options.media ? setMedia(options.media) : Promise.resolve({ duration: 0 });
    return inst;
  }

  t3kit.waveform = { create };
})();
