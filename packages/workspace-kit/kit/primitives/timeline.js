/**
 * t3kit.timeline: multi-track NLE timeline. Video/audio tracks, clips with thumbnails and waveforms, playhead, markers.
 * create(container, options?): options { value?: EDL, fps=30, snap=true }. Fills container (give it a height). Fits on open.
 * EDL (seconds): { tracks:[{ id, kind:'video'|'audio', name?, muted?, locked?,
 *     clips:[{ id, src, in, out, start, label?, srcDuration?, ...yours }] }], playhead, markers:[{ id, time, label? }],
 *   range: null | { in, out } }   Tracks render top to bottom in array order. src is an opaque string (asset id or URL).
 *   A clip spans start .. start+(out-in) and shows source in..out; srcDuration caps trims. Clips on a track never overlap.
 * Instance:
 *   get() -> EDL copy                    set(partial) -> replace any of tracks|playhead|markers|range. Throws on bad
 *                                          shape, overlap or duplicate ids. Emits no 'change'; clears undo history.
 *   on(event, cb) -> unsubscribe         destroy()
 *   setThumbnails(clipId, frames, span?) -> Promise. frames: (Blob|url|canvas|ImageBitmap|img|video|null)[], spread
 *       evenly over source span {in,out} (default: the clip's in..out). Downscaled on decode; null = pending (nearest
 *       loaded frame shows). Trims keep frames aligned by source time; split halves inherit them.
 *   setWaveform(clipId, peaks, span?)    peaks: number[]|Float32Array of 0..1 amplitudes over the same span.
 *   selection() -> clipIds   select(ids)   seek(t)   play(rate=1)   pause()   undo()/redo() -> bool   fit()   zoom(pxPerSec)
 *   setTransport({ play(rate), pause() } | null)  hand Space/J/K/L and the buttons to an external engine (a player): no
 *       own clock, forward 1x only; drive the playhead with seek(). t3kit.links.playerTimeline does this for you.
 * Events: 'change' (EDL; user edits, undo/redo, user seeks, I/O range), 'playhead' (seconds; scrub, playback, seek),
 *   'select' (clipIds), 'play' ({ playing, rate }). Programmatic calls never emit 'change'.
 * Keys (timeline focused): Space play/pause · J/K/L reverse/pause/forward (repeat = 2x 4x 8x) · ←/→ frame (Shift 1 s)
 *   · Home/End · ↑/↓ previous/next edit · I/O range in/out · X clear range · S split at playhead (selected clips,
 *   else every unlocked track) · Delete/Backspace ripple delete (Alt or Shift = lift; with a range and no selection
 *   = extract range) · M marker · N snap · +/- zoom · \ fit · Esc cancel drag / clear selection · Cmd/Ctrl+A all
 *   · Cmd/Ctrl+Z undo · Shift+Cmd/Ctrl+Z or Ctrl+Y redo.
 * Mouse: drag ruler or empty lane = scrub · drag clip = move (onto a same-kind track; a multi-selection moves
 *   together) · drag clip edge = trim · drag marker · Shift/Cmd/Ctrl click = toggle select · Cmd/Ctrl+wheel = zoom.
 * Snapping (N) pulls to playhead, clip edges, markers, range and 0; otherwise edits land on the frame grid.
 * Usage:
 *   const tl = t3kit.timeline.create(el, { value: { tracks: [{ id: 'v1', kind: 'video', clips: [
 *     { id: 'c1', src: 'clip.mp4', in: 0, out: 5, start: 0, label: 'Opening' }] }], playhead: 0, markers: [] } });
 *   tl.setThumbnails('c1', frames, { in: 0, out: 14 });  // frames the host sampled from the source
 *   tl.on('playhead', (t) => { preview.currentTime = t; });
 *   tl.on('change', (edl) => save(edl));
 */
(function () {
  "use strict";
  const t3kit = (window.t3kit = window.t3kit || {});

  // ---- Constants
  const RULER_H = 36;
  const TRACK_H = { video: 64, audio: 48 };
  const GUTTER_W = 132;
  const LEFT_PAD = 12;
  const CLIP_PAD = 4;
  const LABEL_H = 17;
  const EDGE_PX = 6;
  const SNAP_PX = 8;
  const DRAG_PX = 3;
  const MIN_PPS = 2;
  const MAX_PPS = 1200;
  const HISTORY_MAX = 100;
  const THUMB_H = 112;
  const EPS = 1e-6;
  const MAX_RATE = 8;
  const URL_CACHE_MAX = 256;
  const EVENTS = ["change", "playhead", "select", "play"];
  const VALUE_KEYS = ["tracks", "playhead", "markers", "range"];
  const STEPS = [
    [0.1, 0.02],
    [0.25, 0.05],
    [0.5, 0.1],
    [1, 0.2],
    [2, 0.5],
    [5, 1],
    [10, 2],
    [15, 5],
    [30, 5],
    [60, 10],
    [120, 30],
    [300, 60],
    [600, 120],
    [1800, 300],
    [3600, 600],
  ];
  const THEME = {
    bg: "--background",
    card: "--card",
    muted: "--muted",
    border: "--border",
    fg: "--foreground",
    mfg: "--muted-foreground",
    primary: "--primary",
    video: "--chart-1",
    audio: "--chart-2",
    marker: "--chart-3",
    trim: "--warning",
    sans: "--font-sans",
    mono: "--font-mono",
  };
  const HINT =
    "Space play · J K L shuttle · I O range · S split · Delete ripple · M marker · N snap · Cmd/Ctrl+Z undo";
  const ICON = {
    reverse: '<path d="M7.5 3 1.5 8l6 5zM14.5 3l-6 5 6 5z"/>',
    pause:
      '<rect x="4" y="3" width="3" height="10" rx=".5"/><rect x="9" y="3" width="3" height="10" rx=".5"/>',
    play: '<path d="M4.5 2.5v11l9-5.5z"/>',
  };

  const CSS = `
.t3k-timeline-root{display:flex;flex-direction:column;box-sizing:border-box;width:100%;height:100%;min-height:220px;min-width:0;background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:12px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.t3k-timeline-bar{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 8px;border-bottom:1px solid var(--border);background:var(--card)}
.t3k-timeline-group{display:flex;align-items:center;gap:4px}
.t3k-timeline-sep{width:1px;align-self:stretch;margin:2px 4px;background:var(--border)}
.t3k-timeline-push{margin-left:auto}
.t3k-timeline-bar button,.t3k-timeline-hbtns button{display:inline-flex;align-items:center;justify-content:center;gap:4px;font:inherit;font-size:11px;color:var(--foreground);background:var(--background);border:1px solid var(--border);border-radius:calc(var(--radius) - 4px);padding:0 8px;height:24px;cursor:pointer;white-space:nowrap}
.t3k-timeline-bar button svg{width:12px;height:12px;fill:currentColor}
.t3k-timeline-bar button:hover:not(:disabled),.t3k-timeline-hbtns button:hover{border-color:var(--ring)}
.t3k-timeline-bar button:disabled{opacity:.4;cursor:default}
.t3k-timeline-bar button[aria-pressed="true"],.t3k-timeline-hbtns button[aria-pressed="true"]{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}
.t3k-timeline-tc{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:12px;padding:0 6px;white-space:nowrap}
.t3k-timeline-dur{color:var(--muted-foreground)}
.t3k-timeline-zoom{width:96px;accent-color:var(--primary)}
.t3k-timeline-rulerrow{flex:none;display:flex;border-bottom:1px solid var(--border)}
.t3k-timeline-corner{flex:none;box-sizing:border-box;width:${GUTTER_W}px;height:${RULER_H}px;display:flex;align-items:center;padding:0 10px;background:var(--card);border-right:1px solid var(--border);color:var(--muted-foreground);font-size:11px}
.t3k-timeline-rulerwrap,.t3k-timeline-viewport{position:relative;flex:1;min-width:0;overflow:hidden}
.t3k-timeline-body{flex:1;min-height:0;display:flex;overflow-x:hidden;overflow-y:auto;scrollbar-width:none}
.t3k-timeline-body::-webkit-scrollbar{display:none}
.t3k-timeline-viewport{outline:none}
.t3k-timeline-viewport:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.t3k-timeline-gutter{flex:none;box-sizing:border-box;width:${GUTTER_W}px;background:var(--card);border-right:1px solid var(--border)}
.t3k-timeline-head{box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:4px;padding:0 10px;border-bottom:1px solid var(--border);min-width:0}
.t3k-timeline-hname{display:flex;align-items:baseline;gap:6px;min-width:0}
.t3k-timeline-hname b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3k-timeline-hname span{color:var(--muted-foreground);font-size:10px;text-transform:uppercase;letter-spacing:.04em}
.t3k-timeline-hbtns{display:flex;gap:4px}
.t3k-timeline-hbtns button{font-size:10px;height:18px;padding:0 6px}
.t3k-timeline-canvas{display:block;touch-action:none;user-select:none;-webkit-user-select:none}
.t3k-timeline-ph{position:absolute;top:0;left:0;width:0;pointer-events:none;will-change:transform}
.t3k-timeline-ph::before{content:"";position:absolute;top:0;bottom:0;left:-1px;width:2px;background:var(--destructive)}
.t3k-timeline-phcap::after{content:"";position:absolute;top:0;left:-6px;width:12px;height:13px;background:var(--destructive);clip-path:polygon(0 0,100% 0,100% 60%,50% 100%,0 60%)}
.t3k-timeline-hrow{flex:none;display:flex;border-top:1px solid var(--border);background:var(--card)}
.t3k-timeline-hpad{flex:none;width:${GUTTER_W}px}
.t3k-timeline-hscroll{flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;height:12px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.t3k-timeline-hinner{height:1px}
.t3k-timeline-footer{flex:none;padding:4px 10px;border-top:1px solid var(--border);background:var(--card);color:var(--muted-foreground);font-family:var(--font-mono);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;

  // ---- Pure helpers
  const fail = (msg) => {
    throw new Error(`timeline: ${msg}`);
  };
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const round = (v) => Math.round(v * 1e6) / 1e6;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad = (n) => String(n).padStart(2, "0");
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const clipEnd = (c) => round(c.start + (c.out - c.in));
  const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function injectStyle() {
    if (document.querySelector('style[data-t3kit="timeline"]')) return;
    const style = el("style");
    style.dataset.t3kit = "timeline";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const [key, name] of Object.entries(THEME)) {
      const v = cs.getPropertyValue(name).trim();
      if (!v) fail(`theme variable ${name} is not set`);
      out[key] = v;
    }
    return out;
  }

  function rr(ctx, x, y, w, h, r) {
    const rad = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  function fmtRuler(t, step) {
    const whole = Math.floor(t + EPS);
    const h = Math.floor(whole / 3600);
    const m = Math.floor(whole / 60) % 60;
    const s = whole % 60;
    const base = h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    if (step >= 1) return base;
    return `${base}.${(t - whole).toFixed(step < 0.5 ? 2 : 1).slice(2)}`;
  }

  // ---- Validation (set() and options.value)
  function normalise(v) {
    for (const key of Object.keys(v))
      if (!VALUE_KEYS.includes(key)) fail(`unknown value key "${key}"`);
    if (!Array.isArray(v.tracks)) fail("tracks must be an array");
    const trackIds = new Set();
    const clipIds = new Set();
    for (const t of v.tracks) {
      if (typeof t.id !== "string" || !t.id) fail("track.id must be a non-empty string");
      if (trackIds.has(t.id)) fail(`duplicate track id "${t.id}"`);
      trackIds.add(t.id);
      if (t.kind !== "video" && t.kind !== "audio")
        fail(`track "${t.id}" kind must be "video" or "audio"`);
      if (!Array.isArray(t.clips)) fail(`track "${t.id}" clips must be an array`);
      for (const c of t.clips) {
        if (typeof c.id !== "string" || !c.id) fail(`clip on track "${t.id}" needs a string id`);
        if (clipIds.has(c.id)) fail(`duplicate clip id "${c.id}"`);
        clipIds.add(c.id);
        if (typeof c.src !== "string") fail(`clip "${c.id}" src must be a string`);
        if (!isNum(c.in) || !isNum(c.out) || !isNum(c.start))
          fail(`clip "${c.id}" needs numeric in, out, start`);
        if (c.in < 0 || c.start < 0) fail(`clip "${c.id}" in and start must be >= 0`);
        if (!(c.out - c.in > EPS)) fail(`clip "${c.id}" needs out > in`);
        if (c.srcDuration !== undefined && (!isNum(c.srcDuration) || c.out > c.srcDuration + EPS)) {
          fail(`clip "${c.id}" srcDuration must be a number >= out`);
        }
        c.in = round(c.in);
        c.out = round(c.out);
        c.start = round(c.start);
      }
      t.clips.sort((a, b) => a.start - b.start);
      for (let i = 1; i < t.clips.length; i++) {
        const prev = t.clips[i - 1];
        if (t.clips[i].start < clipEnd(prev) - EPS)
          fail(`clips "${prev.id}" and "${t.clips[i].id}" overlap on track "${t.id}"`);
      }
    }
    if (!Array.isArray(v.markers)) fail("markers must be an array");
    const markerIds = new Set();
    for (const m of v.markers) {
      if (typeof m.id !== "string" || !m.id) fail("marker.id must be a non-empty string");
      if (markerIds.has(m.id)) fail(`duplicate marker id "${m.id}"`);
      markerIds.add(m.id);
      if (!isNum(m.time) || m.time < 0) fail(`marker "${m.id}" time must be a number >= 0`);
      m.time = round(m.time);
    }
    v.markers.sort((a, b) => a.time - b.time);
    if (!isNum(v.playhead) || v.playhead < 0) fail("playhead must be a number >= 0");
    if (v.range !== null) {
      const r = v.range;
      if (!r || !isNum(r.in) || !isNum(r.out) || r.in < 0 || r.out <= r.in)
        fail("range must be null or {in, out} with 0 <= in < out");
    }
    return {
      tracks: v.tracks,
      playhead: round(v.playhead),
      markers: v.markers,
      range: v.range ? { in: round(v.range.in), out: round(v.range.out) } : null,
    };
  }

  // ---- Thumbnail decoding: always downscaled to THUMB_H so 4K/24MP sources stay cheap.
  const blobCache = new WeakMap();
  const urlCache = new Map();

  function decodeBlob(blob) {
    if (!blobCache.has(blob))
      blobCache.set(
        blob,
        createImageBitmap(blob, { resizeHeight: THUMB_H, resizeQuality: "medium" }),
      );
    return blobCache.get(blob);
  }

  async function decodeFrame(f) {
    if (f === null) return null;
    if (f instanceof Blob) return decodeBlob(f);
    if (typeof f === "string") {
      if (!urlCache.has(f)) {
        if (urlCache.size >= URL_CACHE_MAX) urlCache.delete(urlCache.keys().next().value);
        urlCache.set(
          f,
          fetch(f)
            .then((r) => {
              if (!r.ok) fail(`thumbnail fetch failed (${r.status}) for ${f}`);
              return r.blob();
            })
            .then(decodeBlob),
        );
      }
      return urlCache.get(f);
    }
    if (typeof HTMLImageElement !== "undefined" && f instanceof HTMLImageElement && !f.complete)
      await f.decode();
    const h = f.naturalHeight || f.videoHeight || f.displayHeight || f.height;
    if (!h) fail("thumbnail frame has no size (not loaded yet?)");
    return h > THUMB_H
      ? createImageBitmap(f, { resizeHeight: THUMB_H, resizeQuality: "medium" })
      : createImageBitmap(f);
  }

  // ---- Gaps: free space on a track, ignoring excluded clip ids.
  function gapsOf(track, excluded) {
    const list = track.clips.filter((c) => !excluded.has(c.id)).sort((a, b) => a.start - b.start);
    const gaps = [];
    let cur = 0;
    for (const c of list) {
      if (c.start > cur + EPS) gaps.push({ lo: cur, hi: c.start });
      cur = Math.max(cur, clipEnd(c));
    }
    gaps.push({ lo: cur, hi: Infinity });
    return gaps;
  }

  // The gap containing the centre of [start, start+len], else the nearest one that fits len.
  function pickGap(gaps, start, len) {
    const center = start + len / 2;
    let best = null;
    let bestDist = Infinity;
    for (const g of gaps) {
      if (g.hi - g.lo < len - EPS) continue;
      const dist = center < g.lo ? g.lo - center : center > g.hi ? center - g.hi : 0;
      if (dist < bestDist) {
        best = g;
        bestDist = dist;
      }
    }
    return best;
  }

  function create(container, options = {}) {
    if (!(container instanceof HTMLElement))
      fail("create(container, options) needs an HTMLElement");
    injectStyle();
    const fps = options.fps ?? 30;
    if (!isNum(fps) || fps <= 0) fail("options.fps must be a positive number");
    const frame = 1 / fps;
    const q = (t) => round(Math.round(t * fps) / fps);

    // ---- State
    const listeners = Object.fromEntries(EVENTS.map((n) => [n, new Set()]));
    // options.value may omit playhead, markers and range; tracks default to one empty V1 and A1.
    let edl = normalise({
      tracks: [
        { id: "v1", kind: "video", name: "V1", clips: [] },
        { id: "a1", kind: "audio", name: "A1", clips: [] },
      ],
      playhead: 0,
      markers: [],
      range: null,
      ...clone(options.value ?? {}),
    });
    let pps = 80;
    let scrollX = 0;
    let fitted = false;
    let cssW = 0;
    let cssH = 0;
    let dprNow = 0;
    let snapOn = options.snap !== false;
    let selected = [];
    let selMarker = null;
    let drag = null;
    let pendingMove = null; // newest pointer position of a drag, applied on the next frame
    let moveFrame = 0;
    let hover = null;
    let guide = null;
    let lastMsg = "";
    let playing = false;
    let external = null; // { play(rate), pause() } when another engine owns playback (setTransport)
    let rate = 0;
    let playByUser = false;
    let playFrom = 0;
    let lastTs = 0;
    let rafId = 0;
    let frameQueued = false;
    let gutterSig = "";
    let theme = null;
    let destroyed = false;
    const undoStack = [];
    const redoStack = [];
    const thumbs = new Map();
    const peaks = new Map();
    const thumbSeq = new Map();

    const emit = (name, payload) => {
      for (const cb of [...listeners[name]]) cb(payload);
    };
    const get = () => clone(edl);

    // ---- Model helpers
    const timelineEnd = () =>
      edl.tracks.reduce((m, t) => t.clips.reduce((mm, c) => Math.max(mm, clipEnd(c)), m), 0);
    const extent = () =>
      Math.max(
        timelineEnd(),
        edl.playhead,
        edl.range ? edl.range.out : 0,
        ...edl.markers.map((m) => m.time),
      );
    const contentDur = () => extent() + 10;
    const allClipIds = () => edl.tracks.flatMap((t) => t.clips.map((c) => c.id));
    const findClip = (id) => {
      for (const track of edl.tracks) {
        const clip = track.clips.find((c) => c.id === id);
        if (clip) return { track, clip };
      }
      return null;
    };
    const rowTop = (i) => edl.tracks.slice(0, i).reduce((y, t) => y + TRACK_H[t.kind], 0);
    const tracksHeight = () => rowTop(edl.tracks.length);
    const timeToX = (t) => t * pps - scrollX + LEFT_PAD;
    const xToTime = (x) => (x - LEFT_PAD + scrollX) / pps;
    const trackAt = (y) => {
      for (let i = 0; i < edl.tracks.length; i++) {
        const top = rowTop(i);
        if (y >= top && y < top + TRACK_H[edl.tracks[i].kind]) return i;
      }
      return -1;
    };
    const maxScrollX = () => Math.max(0, contentDur() * pps + LEFT_PAD - cssW);
    const clampScroll = () => {
      scrollX = clamp(scrollX, 0, maxScrollX());
    };
    const serial = () => JSON.stringify({ tracks: edl.tracks, markers: edl.markers });
    const applySerial = (s) => {
      const o = JSON.parse(s);
      edl.tracks = o.tracks;
      edl.markers = o.markers;
    };
    const fmtTC = (t) => {
      const total = Math.max(0, Math.round(t * fps));
      const f = Math.round(fps);
      const s = Math.floor(total / f);
      return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(total % f)}`;
    };
    const fmtDur = (d) =>
      d >= 60
        ? `${Math.floor(d / 60)}:${pad(Math.floor(d % 60))}`
        : `${d.toFixed(d < 10 ? 2 : 1)}s`;
    const newId = (prefix) => {
      const taken = new Set([
        ...allClipIds(),
        ...edl.markers.map((m) => m.id),
        ...edl.tracks.map((t) => t.id),
      ]);
      let n = taken.size + 1;
      while (taken.has(`${prefix}${n}`)) n++;
      return `${prefix}${n}`;
    };

    // ---- DOM
    const root = el("div", "t3k-timeline-root");
    const bar = el("div", "t3k-timeline-bar");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Timeline controls");

    const rulerRow = el("div", "t3k-timeline-rulerrow");
    const corner = el("div", "t3k-timeline-corner");
    const rulerWrap = el("div", "t3k-timeline-rulerwrap");
    const rulerCanvas = el("canvas", "t3k-timeline-canvas");
    const capEl = el("div", "t3k-timeline-ph t3k-timeline-phcap");
    capEl.style.height = `${RULER_H}px`;
    rulerWrap.append(rulerCanvas, capEl);
    rulerRow.append(corner, rulerWrap);

    const body = el("div", "t3k-timeline-body");
    const gutter = el("div", "t3k-timeline-gutter");
    const viewport = el("div", "t3k-timeline-viewport");
    viewport.tabIndex = 0;
    viewport.setAttribute("role", "application");
    viewport.setAttribute(
      "aria-label",
      "Timeline tracks. Space plays, S splits, Delete ripple deletes.",
    );
    const trackCanvas = el("canvas", "t3k-timeline-canvas");
    const lineEl = el("div", "t3k-timeline-ph");
    viewport.append(trackCanvas, lineEl);
    body.append(gutter, viewport);

    const hrow = el("div", "t3k-timeline-hrow");
    const hscroll = el("div", "t3k-timeline-hscroll");
    const hinner = el("div", "t3k-timeline-hinner");
    hscroll.append(hinner);
    hrow.append(el("div", "t3k-timeline-hpad"), hscroll);

    const footer = el("div", "t3k-timeline-footer");
    footer.setAttribute("role", "status");
    footer.setAttribute("aria-live", "polite");
    root.append(bar, rulerRow, body, hrow, footer);
    container.append(root);
    const rctx = rulerCanvas.getContext("2d");
    const tctx = trackCanvas.getContext("2d");

    // Toolbar
    let group = null;
    const newGroup = (extra) => {
      group = el("div", `t3k-timeline-group${extra ? ` ${extra}` : ""}`);
      bar.append(group);
    };
    const sep = () => group.append(el("div", "t3k-timeline-sep"));
    const button = (label, title, onClick, icon) => {
      const b = el("button");
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-label", title);
      if (icon) b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICON[icon]}</svg>`;
      else b.textContent = label;
      b.addEventListener("click", () => {
        onClick();
        viewport.focus({ preventScroll: true });
      });
      group.append(b);
      return b;
    };
    newGroup();
    const undoBtn = button("Undo", "Undo (Cmd/Ctrl+Z)", () => undo());
    const redoBtn = button("Redo", "Redo (Shift+Cmd/Ctrl+Z)", () => redo());
    sep();
    const revBtn = button("", "Reverse (J, repeat to speed up)", () => transport(-1), "reverse");
    button("", "Pause (K)", () => userPause(), "pause");
    const fwdBtn = button("", "Play (L, repeat to speed up)", () => transport(1), "play");
    const tcEl = el("output", "t3k-timeline-tc");
    const tcNow = el("span");
    const tcDur = el("span", "t3k-timeline-dur");
    tcEl.append(tcNow, tcDur);
    group.append(tcEl);
    sep();
    button("In", "Range in at playhead (I)", () => setRangeEdge("in"));
    button("Out", "Range out at playhead (O)", () => setRangeEdge("out"));
    button("Split", "Split at playhead (S)", () => splitAtPlayhead());
    button("Ripple Delete", "Ripple delete (Delete; Alt = lift)", () => deleteSelection(true));
    button("Marker", "Add marker at playhead (M)", () => addMarker());
    newGroup("t3k-timeline-push");
    const snapBtn = button("Snap", "Toggle snapping (N)", () => toggleSnap());
    sep();
    button("−", "Zoom out (-)", () => zoomAround(0.8));
    const zoomInput = el("input", "t3k-timeline-zoom");
    zoomInput.type = "range";
    zoomInput.min = "0";
    zoomInput.max = "1000";
    zoomInput.setAttribute("aria-label", "Zoom");
    group.append(zoomInput);
    button("+", "Zoom in (+)", () => zoomAround(1.25));
    button("Fit", "Fit timeline (\\)", () => fit());
    sep();
    button("+ Video", "Add video track", () => addTrack("video"));
    button("+ Audio", "Add audio track", () => addTrack("audio"));

    // ---- Selection, history, commits
    function setSelection(ids) {
      const next = [...new Set(ids)];
      if (sameIds(next, selected)) return;
      selected = next;
      emit("select", [...selected]);
      invalidate();
    }

    function pruneSelection() {
      const ids = new Set(allClipIds());
      setSelection(selected.filter((id) => ids.has(id)));
      if (selMarker !== null && !edl.markers.some((m) => m.id === selMarker)) selMarker = null;
    }

    function settle(label) {
      pruneSelection();
      lastMsg = label;
      invalidate();
      emit("change", get());
    }

    function commit(before, label) {
      if (serial() === before) return false;
      undoStack.push(before);
      if (undoStack.length > HISTORY_MAX) undoStack.shift();
      redoStack.length = 0;
      settle(label);
      return true;
    }

    function undo() {
      if (!undoStack.length) return false;
      redoStack.push(serial());
      applySerial(undoStack.pop());
      settle("Undo");
      return true;
    }

    function redo() {
      if (!redoStack.length) return false;
      undoStack.push(serial());
      applySerial(redoStack.pop());
      settle("Redo");
      return true;
    }

    // ---- Playhead and transport. Playhead moves are a DOM transform; tracks repaint only on scroll.
    function placeHead() {
      const x = timeToX(edl.playhead);
      const visible = x >= -2 && x <= cssW + 2;
      for (const n of [capEl, lineEl]) {
        n.style.visibility = visible ? "visible" : "hidden";
        n.style.transform = `translateX(${Math.round(x)}px)`;
      }
      tcNow.textContent = fmtTC(edl.playhead);
    }

    function follow(page) {
      const x = timeToX(edl.playhead);
      if (x >= LEFT_PAD && x <= cssW - 24) return;
      scrollX = edl.playhead * pps - (page ? cssW * 0.1 : cssW * 0.3);
      clampScroll();
      invalidate();
    }

    function setPlayhead(t) {
      const v = Math.max(0, round(t));
      if (v === edl.playhead) return false;
      edl.playhead = v;
      emit("playhead", v);
      placeHead();
      return true;
    }

    function userSeek(t) {
      userPause();
      if (setPlayhead(q(t))) {
        follow(false);
        emit("change", get());
      }
    }

    function startPlayback(r, byUser) {
      const end = timelineEnd();
      if (r > 0 && end > 0 && edl.playhead >= end - EPS) setPlayhead(0);
      if (external) {
        const was = playing;
        if (!was) playFrom = edl.playhead;
        playing = true;
        playByUser = playByUser || byUser;
        rate = r;
        lastMsg = "Playing";
        if (!was) external.play(r);
        emit("play", { playing: true, rate });
        invalidate();
        return;
      }
      if (!playing) {
        playing = true;
        playFrom = edl.playhead;
        lastTs = 0;
        rafId = requestAnimationFrame(tick);
      }
      playByUser = playByUser || byUser;
      rate = r;
      lastMsg = r < 0 ? `Reverse ${-r}x` : `Playing ${r}x`;
      emit("play", { playing: true, rate });
      invalidate();
    }

    function stopPlayback() {
      if (!playing) return false;
      playing = false;
      rate = 0;
      if (external) {
        external.pause();
        emit("play", { playing: false, rate: 0 });
        lastMsg = "Paused";
        invalidate();
        return true;
      }
      cancelAnimationFrame(rafId);
      rafId = 0;
      setPlayhead(q(edl.playhead));
      emit("play", { playing: false, rate: 0 });
      lastMsg = "Paused";
      invalidate();
      return true;
    }

    function userPause() {
      const byUser = playByUser;
      playByUser = false;
      if (stopPlayback() && byUser && edl.playhead !== playFrom) emit("change", get());
    }

    function transport(dir) {
      if (external) {
        if (dir > 0) startPlayback(1, true);
        return;
      }
      const cur = playing ? rate : 0;
      const next =
        dir > 0
          ? cur > 0
            ? Math.min(cur * 2, MAX_RATE)
            : 1
          : cur < 0
            ? Math.max(cur * 2, -MAX_RATE)
            : -1;
      startPlayback(next, true);
    }

    function tick(ts) {
      rafId = 0;
      if (!playing) return;
      const dt = lastTs ? Math.min(0.5, (ts - lastTs) / 1000) : 0;
      lastTs = ts;
      const end = timelineEnd();
      const next = edl.playhead + dt * rate;
      if (next <= 0 || (rate > 0 && next >= end)) {
        setPlayhead(clamp(next, 0, end));
        userPause();
        return;
      }
      setPlayhead(next);
      follow(true);
      rafId = requestAnimationFrame(tick);
    }

    function editPoints() {
      const pts = [0];
      for (const t of edl.tracks) for (const c of t.clips) pts.push(c.start, clipEnd(c));
      for (const m of edl.markers) pts.push(m.time);
      return [...new Set(pts.map(round))].sort((a, b) => a - b);
    }

    function jumpEdit(dir) {
      const pts = editPoints();
      const t = edl.playhead;
      const target =
        dir > 0 ? pts.find((p) => p > t + EPS) : [...pts].reverse().find((p) => p < t - EPS);
      if (target !== undefined) userSeek(target);
    }

    // ---- Range, snap, markers, tracks
    function setRangeEdge(which) {
      const t = q(edl.playhead);
      const cur = edl.range;
      if (which === "in") {
        const out = cur && cur.out > t + EPS ? cur.out : Math.max(timelineEnd(), t + frame);
        edl.range = { in: t, out: round(out) };
      } else {
        if (t <= EPS) return;
        const inn = cur && cur.in < t - EPS ? cur.in : 0;
        edl.range = { in: inn, out: t };
      }
      lastMsg = `Range ${fmtTC(edl.range.in)} to ${fmtTC(edl.range.out)}`;
      invalidate();
      emit("change", get());
    }

    function clearRange() {
      if (!edl.range) return;
      edl.range = null;
      lastMsg = "Range cleared";
      invalidate();
      emit("change", get());
    }

    function toggleSnap() {
      snapOn = !snapOn;
      lastMsg = `Snapping ${snapOn ? "on" : "off"}`;
      invalidate();
    }

    function addMarker() {
      const t = q(edl.playhead);
      if (edl.markers.some((m) => Math.abs(m.time - t) < EPS)) {
        lastMsg = "A marker is already here";
        invalidate();
        return;
      }
      const before = serial();
      const marker = { id: newId("m"), time: t, label: `Marker ${edl.markers.length + 1}` };
      edl.markers.push(marker);
      edl.markers.sort((a, b) => a.time - b.time);
      selMarker = marker.id;
      setSelection([]);
      commit(before, `Marker added at ${fmtTC(t)}`);
    }

    function toggleFlag(trackId, flag) {
      const track = edl.tracks.find((t) => t.id === trackId);
      const before = serial();
      track[flag] = !track[flag];
      commit(
        before,
        `${track.name ?? track.id} ${flag === "muted" ? "mute" : "lock"} ${track[flag] ? "on" : "off"}`,
      );
    }

    function addTrack(kind) {
      const before = serial();
      const count = edl.tracks.filter((t) => t.kind === kind).length + 1;
      const name = `${kind === "video" ? "V" : "A"}${count}`;
      const track = { id: newId(kind === "video" ? "v" : "a"), kind, name, clips: [] };
      // Video tracks stack upward (new on top); audio tracks stack downward.
      const at = kind === "video" ? 0 : edl.tracks.length;
      edl.tracks.splice(at, 0, track);
      commit(before, `Added track ${name}`);
    }

    // ---- Snapping
    function snapPoints(excluded, withPlayhead) {
      const pts = [0];
      for (const m of edl.markers) if (!excluded.has(m.id)) pts.push(m.time);
      for (const t of edl.tracks)
        for (const c of t.clips) if (!excluded.has(c.id)) pts.push(c.start, clipEnd(c));
      if (edl.range) pts.push(edl.range.in, edl.range.out);
      if (withPlayhead) pts.push(edl.playhead);
      return pts;
    }

    // Smallest adjustment that puts any of `positions` on a snap point, or null.
    function bestSnap(positions, pts) {
      if (!snapOn) return null;
      let best = null;
      for (const p of pts) {
        for (const pos of positions) {
          const adj = p - pos;
          if (Math.abs(adj) <= SNAP_PX / pps && (!best || Math.abs(adj) < Math.abs(best.adj)))
            best = { adj, at: p };
        }
      }
      return best;
    }

    function snapTime(t, pts) {
      const s = bestSnap([t], pts);
      guide = s ? s.at : null;
      return s ? round(s.at) : q(t);
    }

    // ---- Edit operations
    function splitClip(track, clip, t) {
      const right = {
        ...clip,
        id: newId("c"),
        start: round(t),
        in: round(clip.in + (t - clip.start)),
      };
      clip.out = right.in;
      track.clips.push(right);
      track.clips.sort((a, b) => a.start - b.start);
      if (thumbs.has(clip.id)) thumbs.set(right.id, thumbs.get(clip.id));
      if (peaks.has(clip.id)) peaks.set(right.id, peaks.get(clip.id));
      return right;
    }

    const covers = (c, t) => c.start + EPS < t && clipEnd(c) - EPS > t;

    function splitTrackAt(track, t) {
      const c = track.clips.find((x) => covers(x, t));
      if (c) splitClip(track, c, t);
    }

    function cutRange(track, a, b, ripple) {
      splitTrackAt(track, a);
      splitTrackAt(track, b);
      track.clips = track.clips.filter((c) => !(c.start >= a - EPS && clipEnd(c) <= b + EPS));
      if (ripple)
        for (const c of track.clips) if (c.start >= b - EPS) c.start = round(c.start - (b - a));
    }

    function splitAtPlayhead() {
      const t = q(edl.playhead);
      const targets = [];
      for (const track of edl.tracks) {
        if (track.locked) continue;
        for (const c of track.clips)
          if (covers(c, t) && (!selected.length || selected.includes(c.id)))
            targets.push({ track, c });
      }
      if (!targets.length) {
        lastMsg = "Nothing under the playhead to split";
        invalidate();
        return;
      }
      const before = serial();
      for (const { track, c } of targets) splitClip(track, c, t);
      commit(before, `Split ${targets.length} clip${targets.length > 1 ? "s" : ""} at ${fmtTC(t)}`);
    }

    function deleteSelection(ripple) {
      if (selMarker !== null) {
        const before = serial();
        edl.markers = edl.markers.filter((m) => m.id !== selMarker);
        selMarker = null;
        commit(before, "Marker deleted");
        return;
      }
      if (selected.length) {
        const items = selected
          .map(findClip)
          .filter((f) => f && !f.track.locked)
          .sort((p, r) => r.clip.start - p.clip.start);
        if (!items.length) {
          lastMsg = "Selected clips are on locked tracks";
          invalidate();
          return;
        }
        const before = serial();
        for (const { track, clip } of items) cutRange(track, clip.start, clipEnd(clip), ripple);
        commit(
          before,
          `${ripple ? "Ripple deleted" : "Lifted"} ${items.length} clip${items.length > 1 ? "s" : ""}`,
        );
        return;
      }
      if (edl.range) {
        const { in: a, out: b } = edl.range;
        const before = serial();
        for (const track of edl.tracks) if (!track.locked) cutRange(track, a, b, ripple);
        edl.range = null;
        if (ripple && edl.playhead > a) setPlayhead(edl.playhead >= b ? edl.playhead - (b - a) : a);
        commit(before, ripple ? "Extracted range" : "Lifted range");
        return;
      }
      lastMsg = "Select a clip or set a range (I/O) first";
      invalidate();
    }

    // ---- Zoom
    function setZoom(next, anchorX) {
      if (cssW <= 0) return;
      const t = xToTime(anchorX);
      pps = clamp(next, MIN_PPS, MAX_PPS);
      scrollX = t * pps - anchorX + LEFT_PAD;
      clampScroll();
      invalidate();
    }

    const zoomAround = (factor) => setZoom(pps * factor, clamp(timeToX(edl.playhead), 0, cssW));

    function fit() {
      if (cssW <= 0) return;
      pps = clamp((cssW - LEFT_PAD - 24) / Math.max(1, extent() * 1.04), MIN_PPS, MAX_PPS);
      scrollX = 0;
      invalidate();
    }

    const zoomToSlider = (v) =>
      Math.round((Math.log(v / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 1000);
    const sliderToZoom = (s) => MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, s / 1000);

    // ---- Hit testing and pointer input
    function markerChip(m) {
      const x = timeToX(m.time);
      const w = m.label ? Math.min(140, rctx.measureText(m.label).width + 12) : 8;
      return { x0: x - 1, x1: x + w };
    }

    function hitRuler(x) {
      for (let i = edl.markers.length - 1; i >= 0; i--) {
        const m = edl.markers[i];
        const chip = markerChip(m);
        if (x >= chip.x0 - 3 && x <= chip.x1) return { type: "marker", id: m.id };
      }
      return { type: "ruler" };
    }

    function hitTracks(x, y) {
      const ti = trackAt(y);
      if (ti < 0) return { type: "empty" };
      for (const c of edl.tracks[ti].clips) {
        const x0 = timeToX(c.start);
        const x1 = timeToX(clipEnd(c));
        if (x < x0 || x > x1) continue;
        let zone = "body";
        if (x1 - x0 >= EDGE_PX * 3) {
          if (x - x0 <= EDGE_PX) zone = "left";
          else if (x1 - x <= EDGE_PX) zone = "right";
        }
        return { type: "clip", clipId: c.id, zone };
      }
      return { type: "empty" };
    }

    const localXY = (e, target) => {
      const r = target.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    function beginScrub(x, target) {
      userPause();
      drag = { kind: "scrub", startHead: edl.playhead, pts: snapPoints(new Set(), false), target };
      scrubTo(x);
    }

    function scrubTo(x) {
      setPlayhead(snapTime(Math.max(0, xToTime(x)), drag.pts));
      invalidate();
    }

    function beginMove(id, x, y, keepGroup) {
      const ids = new Set(selected);
      const members = [];
      for (const track of edl.tracks) {
        if (track.locked) continue;
        for (const c of track.clips)
          if (ids.has(c.id)) members.push({ clip: c, track, start: c.start, end: clipEnd(c) });
      }
      let lo = -Infinity;
      let hi = Infinity;
      for (const m of members) {
        const gap = pickGap(gapsOf(m.track, ids), m.start, m.end - m.start);
        lo = Math.max(lo, gap.lo - m.start);
        hi = Math.min(hi, gap.hi - m.end);
      }
      return {
        kind: "move",
        id,
        x0: x,
        y0: y,
        moved: false,
        collapse: keepGroup,
        members,
        lo,
        hi,
        minStart: Math.min(...members.map((m) => m.start)),
        maxEnd: Math.max(...members.map((m) => m.end)),
        pts: snapPoints(ids, true),
        before: serial(),
      };
    }

    function onPointerDown(e, area) {
      if (e.button !== 0 || cssW <= 0) return;
      const target = area === "ruler" ? rulerCanvas : trackCanvas;
      viewport.focus({ preventScroll: true });
      target.setPointerCapture(e.pointerId);
      const { x, y } = localXY(e, target);
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      if (area === "ruler") {
        const hit = hitRuler(x);
        if (hit.type === "marker") {
          selMarker = hit.id;
          setSelection([]);
          drag = {
            kind: "marker",
            id: hit.id,
            target,
            before: serial(),
            pts: snapPoints(new Set([hit.id]), true),
          };
          invalidate();
          return;
        }
        beginScrub(x, target);
        return;
      }
      const hit = hitTracks(x, y);
      if (hit.type !== "clip") {
        if (!additive) setSelection([]);
        selMarker = null;
        beginScrub(x, target);
        return;
      }
      const id = hit.clipId;
      selMarker = null;
      if (additive) {
        setSelection(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
        drag = null;
        invalidate();
        return;
      }
      const wasGroup = selected.includes(id) && selected.length > 1;
      if (!selected.includes(id) || hit.zone !== "body") setSelection([id]);
      const found = findClip(id);
      if (found.track.locked) {
        drag = null;
        lastMsg = `${found.track.name ?? found.track.id} is locked`;
        invalidate();
        return;
      }
      const c = found.clip;
      if (hit.zone === "body") {
        drag = { ...beginMove(id, x, y, wasGroup), target };
      } else {
        const others = found.track.clips.filter((o) => o.id !== id);
        drag = {
          kind: hit.zone === "left" ? "trimL" : "trimR",
          id,
          target,
          before: serial(),
          pts: snapPoints(new Set([id]), true),
          origStart: c.start,
          origIn: c.in,
          origOut: c.out,
          prevEnd: others.reduce(
            (m, o) => (clipEnd(o) <= c.start + EPS ? Math.max(m, clipEnd(o)) : m),
            0,
          ),
          nextStart: others.reduce(
            (m, o) => (o.start >= clipEnd(c) - EPS ? Math.min(m, o.start) : m),
            Infinity,
          ),
        };
        hover = { clipId: id, zone: hit.zone };
      }
      invalidate();
    }

    function moveDrag(x, y) {
      const d = drag;
      if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < DRAG_PX) return;
      d.moved = true;
      const reqDt = (x - d.x0) / pps;
      if (d.members.length > 1) {
        let dt = clamp(q(reqDt), d.lo, d.hi);
        const s = bestSnap([d.minStart + dt, d.maxEnd + dt], d.pts);
        guide = s ? s.at : null;
        if (s) dt = clamp(dt + s.adj, d.lo, d.hi);
        for (const m of d.members) m.clip.start = round(m.start + dt);
        return;
      }
      const m = d.members[0];
      const len = m.end - m.start;
      const ti = trackAt(y);
      const over = ti >= 0 ? edl.tracks[ti] : null;
      const target = over && over.kind === m.track.kind && !over.locked ? over : m.track;
      let start = m.start + reqDt;
      const s = bestSnap([start, start + len], d.pts);
      guide = s ? s.at : null;
      start = s ? start + s.adj : m.start + q(reqDt);
      const gap = pickGap(gapsOf(target, new Set([m.clip.id])), start, len);
      start = clamp(start, gap.lo, gap.hi - len);
      if (target !== m.track) {
        m.track.clips = m.track.clips.filter((c) => c !== m.clip);
        target.clips.push(m.clip);
        m.track = target;
      }
      m.clip.start = round(Math.max(0, start));
      target.clips.sort((a, b) => a.start - b.start);
    }

    function trimDrag(x) {
      const d = drag;
      const c = findClip(d.id).clip;
      const t = snapTime(xToTime(x), d.pts);
      const origEnd = d.origStart + (d.origOut - d.origIn);
      if (d.kind === "trimL") {
        const lo = Math.max(d.prevEnd, d.origStart - d.origIn, 0);
        const s = clamp(t, lo, Math.max(lo, origEnd - frame));
        c.start = round(s);
        c.in = round(d.origIn + (s - d.origStart));
      } else {
        let hi = d.nextStart;
        if (isNum(c.srcDuration)) hi = Math.min(hi, d.origStart + (c.srcDuration - d.origIn));
        const lo = d.origStart + frame;
        const e = clamp(t, lo, Math.max(lo, hi));
        c.out = round(d.origIn + (e - d.origStart));
      }
    }

    function onPointerMove(e, area) {
      if (!drag) {
        if (area === "tracks") {
          const { x, y } = localXY(e, trackCanvas);
          updateHover(hitTracks(x, y));
        } else {
          const hit = hitRuler(localXY(e, rulerCanvas).x);
          rulerCanvas.style.cursor = hit.type === "marker" ? "grab" : "default";
        }
        return;
      }
      if (!drag.kind) return;
      // Drags apply once per animation frame with the newest pointer position, never per pointermove.
      pendingMove = { clientX: e.clientX, clientY: e.clientY };
      if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
    }

    function flushMove() {
      if (moveFrame) cancelAnimationFrame(moveFrame);
      moveFrame = 0;
      const e = pendingMove;
      pendingMove = null;
      if (!e || !drag || !drag.kind) return;
      const { x, y } = localXY(e, drag.target);
      if (drag.kind === "scrub") {
        scrubTo(x);
        return;
      }
      if (drag.kind === "marker") {
        const m = edl.markers.find((mk) => mk.id === drag.id);
        m.time = Math.max(0, snapTime(xToTime(x), drag.pts));
      } else if (drag.kind === "move") moveDrag(x, y);
      else trimDrag(x);
      invalidate();
    }

    function onPointerUp() {
      flushMove();
      if (!drag) return;
      const d = drag;
      drag = null;
      guide = null;
      if (!d.kind) return;
      if (d.kind === "scrub") {
        if (edl.playhead !== d.startHead) emit("change", get());
        invalidate();
        return;
      }
      if (d.kind === "move" && !d.moved) {
        if (d.collapse) setSelection([d.id]);
        invalidate();
        return;
      }
      if (d.kind === "marker") edl.markers.sort((a, b) => a.time - b.time);
      const labels = {
        marker: "Moved marker",
        move: d.members && d.members.length > 1 ? `Moved ${d.members.length} clips` : "Moved clip",
        trimL: "Trimmed start",
        trimR: "Trimmed end",
      };
      commit(d.before, labels[d.kind]);
      invalidate();
    }

    function cancelDrag() {
      pendingMove = null;
      flushMove();
      const d = drag;
      drag = null;
      guide = null;
      if (d.kind === "scrub") setPlayhead(d.startHead);
      else if (d.before) applySerial(d.before);
      lastMsg = "Cancelled";
      invalidate();
    }

    function updateHover(hit) {
      const next = hit.type === "clip" ? { clipId: hit.clipId, zone: hit.zone } : null;
      const changed = `${next?.clipId}${next?.zone}` !== `${hover?.clipId}${hover?.zone}`;
      hover = next;
      trackCanvas.style.cursor =
        hit.type === "clip" ? (hit.zone === "body" ? "grab" : "ew-resize") : "default";
      if (changed) invalidate();
    }

    function onPointerLeave() {
      if (drag || !hover) return;
      hover = null;
      invalidate();
    }

    function onWheel(e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom(pps * Math.exp(-e.deltaY * 0.0015), clamp(localXY(e, trackCanvas).x, 0, cssW));
        return;
      }
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      if (!dx) return;
      e.preventDefault();
      scrollX += dx;
      clampScroll();
      invalidate();
    }

    function onKeyDown(e) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.target instanceof HTMLButtonElement && (e.key === " " || e.key === "Enter")) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (mod) {
        if (key === "z") {
          if (e.shiftKey) redo();
          else undo();
        } else if (key === "y") redo();
        else if (key === "a") setSelection(allClipIds());
        else return;
        e.preventDefault();
        return;
      }
      if (drag && drag.kind && key !== "Escape") return;
      switch (key) {
        case " ":
          if (playing) userPause();
          else startPlayback(1, true);
          break;
        case "j":
          transport(-1);
          break;
        case "k":
          userPause();
          break;
        case "l":
          transport(1);
          break;
        case "ArrowLeft":
          userSeek(edl.playhead - (e.shiftKey ? 1 : frame));
          break;
        case "ArrowRight":
          userSeek(edl.playhead + (e.shiftKey ? 1 : frame));
          break;
        case "Home":
          userSeek(0);
          break;
        case "End":
          userSeek(timelineEnd());
          break;
        case "ArrowUp":
          jumpEdit(-1);
          break;
        case "ArrowDown":
          jumpEdit(1);
          break;
        case "i":
          setRangeEdge("in");
          break;
        case "o":
          setRangeEdge("out");
          break;
        case "x":
          clearRange();
          break;
        case "s":
          splitAtPlayhead();
          break;
        case "Delete":
        case "Backspace":
          deleteSelection(!(e.altKey || e.shiftKey));
          break;
        case "m":
          addMarker();
          break;
        case "n":
          toggleSnap();
          break;
        case "=":
        case "+":
          zoomAround(1.25);
          break;
        case "-":
        case "_":
          zoomAround(0.8);
          break;
        case "\\":
          fit();
          break;
        case "Escape":
          if (drag && drag.kind) cancelDrag();
          else {
            selMarker = null;
            setSelection([]);
            lastMsg = "";
            invalidate();
          }
          break;
        default:
          return;
      }
      e.preventDefault();
    }

    // ---- Gutter, toolbar, status (DOM)
    function flagButton(track, flag, label) {
      const b = el("button", null, label);
      b.type = "button";
      b.title = `${label} ${track.name ?? track.id}`;
      b.setAttribute("aria-pressed", String(!!track[flag]));
      b.addEventListener("click", () => toggleFlag(track.id, flag));
      return b;
    }

    function syncGutter() {
      const sig = edl.tracks
        .map((t) => [t.id, t.kind, t.name, !!t.muted, !!t.locked].join("|"))
        .join(";");
      if (sig === gutterSig) return;
      gutterSig = sig;
      gutter.replaceChildren();
      for (const t of edl.tracks) {
        const head = el("div", "t3k-timeline-head");
        head.style.height = `${TRACK_H[t.kind]}px`;
        const name = el("div", "t3k-timeline-hname");
        name.append(el("b", null, t.name ?? t.id), el("span", null, t.kind));
        const btns = el("div", "t3k-timeline-hbtns");
        btns.append(flagButton(t, "muted", "Mute"), flagButton(t, "locked", "Lock"));
        head.append(name, btns);
        gutter.append(head);
      }
    }

    function syncChrome() {
      undoBtn.disabled = !undoStack.length;
      redoBtn.disabled = !redoStack.length;
      revBtn.setAttribute("aria-pressed", String(playing && rate < 0));
      fwdBtn.setAttribute("aria-pressed", String(playing && rate > 0));
      snapBtn.setAttribute("aria-pressed", String(snapOn));
      tcDur.textContent = ` / ${fmtTC(timelineEnd())}`;
      zoomInput.value = String(zoomToSlider(pps));
      corner.textContent = `${edl.tracks.length} tracks · ${allClipIds().length} clips`;
      let info = "";
      if (selMarker !== null) {
        const m = edl.markers.find((mk) => mk.id === selMarker);
        info = `${m.label ?? m.id} at ${fmtTC(m.time)}`;
      } else if (selected.length === 1) {
        const f = findClip(selected[0]);
        info = `${f.clip.label ?? f.clip.id}: ${fmtTC(f.clip.start)} to ${fmtTC(clipEnd(f.clip))} (source ${f.clip.in.toFixed(2)} to ${f.clip.out.toFixed(2)} s)`;
      } else if (selected.length > 1) info = `${selected.length} clips selected`;
      footer.textContent = [lastMsg, info].filter(Boolean).join(" · ") || HINT;
    }

    function sizeCanvas(c, w, h, dpr) {
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
    }

    function layout() {
      const w = Math.floor(viewport.clientWidth);
      const h = Math.max(tracksHeight(), body.clientHeight);
      const dpr = window.devicePixelRatio || 1;
      if (w !== cssW || h !== cssH || dpr !== dprNow) {
        cssW = w;
        cssH = h;
        dprNow = dpr;
        sizeCanvas(rulerCanvas, w, RULER_H, dpr);
        sizeCanvas(trackCanvas, w, h, dpr);
        lineEl.style.height = `${h}px`;
      }
      if (!fitted && cssW > 0) {
        fitted = true;
        fit();
      }
      clampScroll();
      hinner.style.width = `${Math.ceil(contentDur() * pps + LEFT_PAD)}px`;
      if (Math.abs(hscroll.scrollLeft - scrollX) >= 1) hscroll.scrollLeft = scrollX;
    }

    // ---- Canvas painting
    function drawThumbs(ctx, c, entry, x0, w, top, h) {
      const tileW = Math.max(16, h * entry.aspect);
      const span = entry.out - entry.in;
      const n = entry.items.length;
      let x = x0;
      if (x0 < 0) x += Math.floor(-x0 / tileW) * tileW;
      for (; x < x0 + w && x < cssW; x += tileW) {
        const srcT = c.in + (x + tileW / 2 - x0) / pps;
        const img =
          entry.items[entry.fill[Math.floor(clamp((srcT - entry.in) / span, 0, 0.99999) * n)]];
        ctx.drawImage(img, x, top, tileW, h);
      }
    }

    function drawWave(ctx, c, entry, x0, w, top, h, color) {
      const mid = top + h / 2;
      const amp = h / 2 - 2;
      const n = entry.data.length;
      const perSec = n / (entry.out - entry.in);
      ctx.fillStyle = color;
      ctx.globalAlpha *= 0.85;
      const from = Math.max(0, Math.floor(-x0));
      const to = Math.min(w, cssW - x0);
      for (let px = from - (from % 2); px < to; px += 2) {
        const a = (c.in + px / pps - entry.in) * perSec;
        const b = (c.in + (px + 2) / pps - entry.in) * perSec;
        let peak = 0;
        for (let i = Math.max(0, Math.floor(a)); i <= Math.min(n - 1, Math.floor(b)); i++)
          peak = Math.max(peak, entry.data[i]);
        const v = Math.max(0.5, peak * amp);
        ctx.fillRect(x0 + px, mid - v, 1.5, v * 2);
      }
    }

    function drawClip(ctx, p, track, c, rowY, rowH) {
      const x0 = timeToX(c.start);
      const x1 = timeToX(clipEnd(c));
      if (x1 < 0 || x0 > cssW) return;
      const top = rowY + CLIP_PAD;
      const h = rowH - CLIP_PAD * 2;
      const w = Math.max(2, x1 - x0);
      const base = track.muted ? 0.4 : track.locked ? 0.65 : 1;
      const isAudio = track.kind === "audio";
      const color = isAudio ? p.audio : p.video;
      const isSel = selected.includes(c.id);
      ctx.save();
      rr(ctx, x0, top, w, h, 4);
      ctx.globalAlpha = base * (isSel ? 0.34 : 0.2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.clip();
      ctx.globalAlpha = base;
      const th = thumbs.get(c.id);
      if (!isAudio && th) drawThumbs(ctx, c, th, x0, w, top, h);
      const wave = peaks.get(c.id);
      if (isAudio && wave) drawWave(ctx, c, wave, x0, w, top + LABEL_H - 2, h - LABEL_H + 2, color);
      if (!isAudio) {
        ctx.globalAlpha = base * 0.62;
        ctx.fillStyle = p.bg;
        ctx.fillRect(x0, top, w, LABEL_H);
      }
      ctx.globalAlpha = base;
      ctx.textBaseline = "middle";
      ctx.font = `600 11px ${p.sans}`;
      ctx.fillStyle = p.fg;
      const label = c.label ?? c.id;
      const durText = fmtDur(c.out - c.in);
      ctx.font = `10px ${p.mono}`;
      const durW = ctx.measureText(durText).width;
      ctx.font = `600 11px ${p.sans}`;
      const showDur = w > ctx.measureText(label).width + durW + 28;
      ctx.fillText(label, x0 + 6, top + LABEL_H / 2 + 0.5, Math.max(0, w - 12));
      if (showDur) {
        ctx.font = `10px ${p.mono}`;
        ctx.fillStyle = p.mfg;
        ctx.fillText(durText, x1 - durW - 6, top + LABEL_H / 2 + 0.5);
      }
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = base;
      if (isSel) {
        rr(ctx, x0 + 1, top + 1, w - 2, h - 2, 4);
        ctx.strokeStyle = p.fg;
        ctx.lineWidth = 2;
      } else {
        rr(ctx, x0 + 0.5, top + 0.5, w - 1, h - 1, 4);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
      }
      ctx.stroke();
      const active =
        drag && drag.id === c.id && (drag.kind === "trimL" || drag.kind === "trimR")
          ? drag.kind === "trimL"
            ? "left"
            : "right"
          : hover && hover.clipId === c.id && hover.zone !== "body"
            ? hover.zone
            : null;
      if (active) {
        ctx.fillStyle = p.trim;
        rr(ctx, active === "left" ? x0 : x1 - 4, top, 4, h, 2);
        ctx.fill();
      }
      ctx.restore();
    }

    function drawTracks(p) {
      const ctx = tctx;
      ctx.setTransform(dprNow, 0, 0, dprNow, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = p.bg;
      ctx.fillRect(0, 0, cssW, cssH);
      edl.tracks.forEach((track, i) => {
        const y = rowTop(i);
        const h = TRACK_H[track.kind];
        ctx.fillStyle = track.kind === "audio" ? p.muted : p.card;
        ctx.fillRect(0, y, cssW, h);
        ctx.fillStyle = p.border;
        ctx.fillRect(0, y + h - 1, cssW, 1);
        for (const c of track.clips) drawClip(ctx, p, track, c, y, h);
      });
      if (!allClipIds().length) {
        ctx.fillStyle = p.mfg;
        ctx.font = `12px ${p.sans}`;
        ctx.textBaseline = "middle";
        ctx.fillText("No clips yet", LEFT_PAD + 8, Math.min(tracksHeight(), cssH) / 2);
      }
      if (edl.range) {
        const x0 = timeToX(edl.range.in);
        const x1 = timeToX(edl.range.out);
        ctx.fillStyle = p.primary;
        ctx.globalAlpha = 0.1;
        ctx.fillRect(x0, 0, x1 - x0, cssH);
        ctx.globalAlpha = 0.8;
        ctx.fillRect(Math.round(x0), 0, 1, cssH);
        ctx.fillRect(Math.round(x1) - 1, 0, 1, cssH);
        ctx.globalAlpha = 1;
      }
      for (const m of edl.markers) {
        const x = timeToX(m.time);
        if (x < -2 || x > cssW + 2) continue;
        ctx.globalAlpha = m.id === selMarker ? 0.9 : 0.5;
        ctx.fillStyle = p.marker;
        ctx.fillRect(Math.round(x), 0, 1, cssH);
      }
      ctx.globalAlpha = 1;
      if (guide !== null) {
        ctx.strokeStyle = p.fg;
        ctx.globalAlpha = 0.75;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(timeToX(guide)) + 0.5, 0);
        ctx.lineTo(Math.round(timeToX(guide)) + 0.5, cssH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    function drawRuler(p) {
      const ctx = rctx;
      ctx.setTransform(dprNow, 0, 0, dprNow, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = p.card;
      ctx.fillRect(0, 0, cssW, RULER_H);
      const [step, minor] = STEPS.find(([s]) => s * pps >= 80) ?? STEPS[STEPS.length - 1];
      const t0 = Math.max(0, xToTime(0));
      const t1 = xToTime(cssW);
      ctx.fillStyle = p.mfg;
      if (minor * pps >= 6) {
        ctx.globalAlpha = 0.6;
        for (let k = Math.floor(t0 / minor); k * minor <= t1; k++)
          ctx.fillRect(Math.round(timeToX(k * minor)), RULER_H - 4, 1, 4);
        ctx.globalAlpha = 1;
      }
      ctx.font = `10px ${p.mono}`;
      ctx.textBaseline = "middle";
      for (let k = Math.floor(t0 / step); k * step <= t1 + step; k++) {
        const t = round(k * step);
        const x = Math.round(timeToX(t));
        ctx.fillRect(x, RULER_H - 9, 1, 9);
        ctx.fillText(fmtRuler(t, step), x + 4, 9);
      }
      if (edl.range) {
        const x0 = timeToX(edl.range.in);
        const x1 = timeToX(edl.range.out);
        ctx.fillStyle = p.primary;
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x0, RULER_H - 5, x1 - x0, 5);
        ctx.globalAlpha = 1;
        ctx.fillRect(Math.round(x0), 16, 1, RULER_H - 16);
        ctx.fillRect(Math.round(x1) - 1, 16, 1, RULER_H - 16);
      }
      ctx.font = `600 10px ${p.sans}`;
      for (const m of edl.markers) {
        const chip = markerChip(m);
        if (chip.x1 < 0 || chip.x0 > cssW) continue;
        const sel = m.id === selMarker;
        ctx.fillStyle = p.marker;
        ctx.globalAlpha = sel ? 0.5 : 0.22;
        rr(ctx, chip.x0, 17, chip.x1 - chip.x0, 13, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillRect(Math.round(timeToX(m.time)), 17, 2, RULER_H - 17);
        if (m.label) {
          ctx.fillStyle = p.fg;
          ctx.fillText(m.label, chip.x0 + 6, 24, chip.x1 - chip.x0 - 9);
        }
      }
      ctx.fillStyle = p.border;
      ctx.fillRect(0, RULER_H - 1, cssW, 1);
      if (guide !== null) {
        ctx.fillStyle = p.fg;
        ctx.globalAlpha = 0.75;
        ctx.fillRect(Math.round(timeToX(guide)), 0, 1, RULER_H);
        ctx.globalAlpha = 1;
      }
    }

    function paint() {
      if (destroyed) return;
      syncGutter();
      layout();
      if (cssW > 0) {
        if (!theme) theme = readTheme();
        drawRuler(theme);
        drawTracks(theme);
      }
      placeHead();
      syncChrome();
    }

    function invalidate() {
      if (frameQueued || destroyed) return;
      frameQueued = true;
      requestAnimationFrame(() => {
        frameQueued = false;
        paint();
      });
    }

    // ---- Observers and listeners
    const onTheme = () => {
      theme = null;
      invalidate();
    };
    const resizeObserver = new ResizeObserver(() => invalidate());
    resizeObserver.observe(body);
    resizeObserver.observe(viewport);
    const themeObserver = new MutationObserver(onTheme);
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
    const colorQuery = window.matchMedia("(prefers-color-scheme: light)");
    colorQuery.addEventListener("change", onTheme);

    for (const [cv, area] of [
      [rulerCanvas, "ruler"],
      [trackCanvas, "tracks"],
    ]) {
      cv.addEventListener("pointerdown", (e) => onPointerDown(e, area));
      cv.addEventListener("pointermove", (e) => onPointerMove(e, area));
      cv.addEventListener("pointerup", onPointerUp);
      cv.addEventListener("pointercancel", onPointerUp);
      cv.addEventListener("wheel", onWheel, { passive: false });
    }
    trackCanvas.addEventListener("pointerleave", onPointerLeave);
    root.addEventListener("keydown", onKeyDown);
    hscroll.addEventListener("scroll", () => {
      if (Math.abs(hscroll.scrollLeft - scrollX) < 1) return;
      scrollX = hscroll.scrollLeft;
      clampScroll();
      invalidate();
    });
    zoomInput.addEventListener("input", () =>
      setZoom(sliderToZoom(Number(zoomInput.value)), clamp(timeToX(edl.playhead), 0, cssW)),
    );

    // ---- Public instance
    function on(name, cb) {
      if (!listeners[name]) fail(`unknown event "${name}" (use ${EVENTS.join(", ")})`);
      listeners[name].add(cb);
      return () => listeners[name].delete(cb);
    }

    function set(partial) {
      if (!partial || typeof partial !== "object") fail("set() expects an object");
      for (const key of Object.keys(partial))
        if (!VALUE_KEYS.includes(key)) fail(`set(): unknown key "${key}"`);
      if (drag && drag.kind) cancelDrag();
      edl = normalise({ ...get(), ...clone(partial) });
      undoStack.length = 0;
      redoStack.length = 0;
      const ids = new Set(allClipIds());
      for (const key of [...thumbs.keys()]) if (!ids.has(key)) thumbs.delete(key);
      for (const key of [...peaks.keys()]) if (!ids.has(key)) peaks.delete(key);
      pruneSelection();
      if ("playhead" in partial) emit("playhead", edl.playhead);
      invalidate();
    }

    function spanFor(clipId, given) {
      if (given) {
        if (!isNum(given.in) || !isNum(given.out) || given.out <= given.in)
          fail("span must be {in, out} with out > in");
        return given;
      }
      const found = findClip(clipId);
      if (!found) fail(`no clip "${clipId}"; pass a span {in, out}`);
      return { in: found.clip.in, out: found.clip.out };
    }

    async function setThumbnails(clipId, frames, given) {
      if (!Array.isArray(frames)) fail("setThumbnails(clipId, frames[]) needs an array");
      const s = spanFor(clipId, given);
      const token = (thumbSeq.get(clipId) ?? 0) + 1;
      thumbSeq.set(clipId, token);
      const items = await Promise.all(frames.map(decodeFrame));
      if (destroyed || thumbSeq.get(clipId) !== token) return;
      const loaded = items.map((it, i) => (it ? i : -1)).filter((i) => i >= 0);
      if (!loaded.length) {
        thumbs.delete(clipId);
        invalidate();
        return;
      }
      const fill = items.map((it, i) =>
        it ? i : loaded.reduce((b, j) => (Math.abs(j - i) < Math.abs(b - i) ? j : b), loaded[0]),
      );
      const first = items[loaded[0]];
      thumbs.set(clipId, { items, fill, in: s.in, out: s.out, aspect: first.width / first.height });
      invalidate();
    }

    function setWaveform(clipId, data, given) {
      if (!data || typeof data.length !== "number")
        fail("setWaveform(clipId, peaks) needs an array of 0..1 numbers");
      const s = spanFor(clipId, given);
      peaks.set(clipId, {
        data: Float32Array.from(data, (v) => clamp(v, 0, 1)),
        in: s.in,
        out: s.out,
      });
      invalidate();
    }

    function destroy() {
      if (destroyed) return;
      stopPlayback();
      destroyed = true;
      cancelAnimationFrame(moveFrame);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      colorQuery.removeEventListener("change", onTheme);
      Object.values(listeners).forEach((s) => s.clear());
      thumbs.clear();
      peaks.clear();
      root.remove();
    }

    invalidate();
    return {
      get,
      set,
      on,
      destroy,
      setThumbnails,
      setWaveform,
      selection: () => [...selected],
      select(ids) {
        if (!Array.isArray(ids)) fail("select(ids) needs an array of clip ids");
        for (const id of ids) if (!findClip(id)) fail(`select(): no clip "${id}"`);
        selMarker = null;
        setSelection(ids);
      },
      seek(t) {
        if (!isNum(t) || t < 0) fail("seek(t) needs a number >= 0");
        if (setPlayhead(t)) follow(false);
      },
      play(r = 1) {
        if (!isNum(r) || r === 0) fail("play(rate) needs a non-zero number");
        if (external && r !== 1)
          fail("play(rate): with setTransport() the external engine plays forward at 1x only");
        startPlayback(clamp(r, -MAX_RATE, MAX_RATE), false);
      },
      pause: () => {
        stopPlayback();
      },
      setTransport(handler) {
        if (
          handler !== null &&
          (typeof handler?.play !== "function" || typeof handler?.pause !== "function")
        ) {
          fail("setTransport(handler) needs { play(rate), pause() } or null");
        }
        stopPlayback();
        external = handler;
        revBtn.disabled = Boolean(handler);
      },
      undo,
      redo,
      fit,
      zoom(v) {
        if (!isNum(v) || v <= 0) fail("zoom(pxPerSecond) needs a positive number");
        setZoom(v, clamp(timeToX(edl.playhead), 0, cssW));
      },
    };
  }

  t3kit.timeline = { create };
})();
