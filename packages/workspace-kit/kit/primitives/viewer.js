/**
 * t3kit.viewer: image/canvas viewport. Fit, 100%, wheel/pinch zoom, pan, before/after split and
 * side-by-side, crop overlay (aspect presets, straighten, 90° turns), rule-of-thirds grid, export.
 *
 * create(container, options?) → instance. Fills `container` and follows its size.
 *   options.value: partial value (shape of get()). options.toolbar = true. options.crop = true (crop tools).
 *
 * get() → { zoom, mode, split, center, cropping, grid, crop: { x, y, w, h, angle, aspect } }
 *   zoom: 'fit' | number (1 = one source px per CSS px). mode: 'single' | 'split' | 'side'.
 *   split: 0..1 divider (before on the left). center: frame px at the view centre (null = no image).
 *   cropping: true shows the crop overlay + tools; false shows the cropped, straightened result.
 *   grid: rule-of-thirds inside the crop. crop x/y/w/h: px in the frame (source size; w/h swap after
 *   an odd 90° turn); the photo turns under the frame. angle: degrees clockwise, -180..180.
 *   aspect: 'free' | '1:1' | '4:5' | '16:9' | '3:2' | any 'a:b'. The crop always stays inside the photo.
 *
 * instance:
 *   get() · set(partial) never emits 'change'. Forgiving: zoom 'fit' | 1 | '100%' | '2x'; aspect
 *     '16/9' | 1.5; top-level aspect / angle; mode 'before-after' | 'sbs'; crop: null resets. Bad keys throw.
 *   setSource(img | canvas | video | ImageBitmap | Blob | url) → Promise   the "after" (edited) image
 *   setBefore(same | null) → Promise   reference image, drawn scaled to the after image's size
 *   refresh()   redraw after drawing into a source canvas in place (playing videos redraw themselves)
 *   getSize() → { width, height }   fit() · actualSize() · rotate(+1 | -1) quarter turn · reset()
 *   exportCanvas() → canvas · exportBlob({ type = 'image/png', quality = 0.92 }) → Promise<Blob>
 *     the crop, straightened and turned, at full source resolution
 *   on('change' | 'load', cb) → unsubscribe   change: user edits, max 1 per frame, payload get();
 *     load: after image ready, payload getSize()
 *   destroy()
 * Input: wheel/pinch zooms at the cursor; drag pans (space- or middle-drag always pans); drag inside
 *   the crop moves it; handles resize (aspect locked); divider drags; double-click toggles fit/100%.
 *   Keys (stage focused): + - zoom, 0 fit, 1 100%, arrows pan, C crop, G grid, R rotate 90°.
 *
 * @example
 *   const v = t3kit.viewer.create(el, { value: { mode: 'split', cropping: true, crop: { aspect: '4:5' } } });
 *   await v.setSource(editedCanvas);
 *   await v.setBefore(originalBlob);
 *   v.on('change', (val) => save(val.crop));
 *   const jpg = await v.exportBlob({ type: 'image/jpeg', quality: 0.9 });
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});

  const MIN_ZOOM = 0.02;
  const MAX_ZOOM = 40;
  const PAD = 20;
  const GAP = 8;
  const MIN_CROP = 8;
  const HIT = 10;
  const EPS = 0.01;
  const STRAIGHTEN = 44.9;
  const PREVIEW_EDGE = 2048;
  const KEYS = ["zoom", "mode", "split", "center", "cropping", "grid", "crop", "aspect", "angle"];
  const CROP_KEYS = ["x", "y", "w", "h", "angle", "aspect"];
  const MODE_ALIASES = {
    single: "single",
    view: "single",
    split: "split",
    slider: "split",
    "before-after": "split",
    side: "side",
    "side-by-side": "side",
    sbs: "side",
  };
  const ASPECT_PRESETS = ["free", "1:1", "4:5", "16:9", "3:2"];
  const CORNERS = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const HANDLES = [
    { id: "nw", hx: -1, hy: -1 },
    { id: "n", hx: 0, hy: -1 },
    { id: "ne", hx: 1, hy: -1 },
    { id: "e", hx: 1, hy: 0 },
    { id: "se", hx: 1, hy: 1 },
    { id: "s", hx: 0, hy: 1 },
    { id: "sw", hx: -1, hy: 1 },
    { id: "w", hx: -1, hy: 0 },
  ];
  const CURSORS = {
    n: "ns-resize",
    s: "ns-resize",
    e: "ew-resize",
    w: "ew-resize",
    nw: "nwse-resize",
    se: "nwse-resize",
    ne: "nesw-resize",
    sw: "nesw-resize",
    move: "move",
  };
  const svg = (d) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICONS = {
    crop: svg('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>'),
    rotL: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    rotR: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
    swap: svg(
      '<path d="M7 4h11a2 2 0 0 1 2 2v4"/><path d="m17 7 3 3 3-3"/><rect x="2" y="10" width="12" height="10" rx="2"/>',
    ),
    grid: svg(
      '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
    ),
  };
  const CSS = `
.t3k-viewer-root{position:relative;display:flex;flex-direction:column;box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--background);color:var(--foreground);font:13px/1.4 var(--font-sans);}
.t3k-viewer-root *,.t3k-viewer-root *::before,.t3k-viewer-root *::after{box-sizing:border-box;}
.t3k-viewer-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:6px 8px;border-bottom:1px solid var(--border);background:var(--card);color:var(--card-foreground);}
.t3k-viewer-bar[hidden],.t3k-viewer-empty[hidden],.t3k-viewer-chip[hidden]{display:none;}
.t3k-viewer-group{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--border);border-radius:var(--radius);background:var(--background);}
.t3k-viewer-field{display:inline-flex;align-items:center;gap:8px;color:var(--muted-foreground);font-size:12px;white-space:nowrap;}
.t3k-viewer-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:28px;height:26px;padding:0 9px;border:0;border-radius:calc(var(--radius) - 3px);background:transparent;color:var(--muted-foreground);font:inherit;font-weight:500;white-space:nowrap;cursor:pointer;}
.t3k-viewer-btn:hover{color:var(--foreground);background:var(--muted);}
.t3k-viewer-btn[aria-pressed="true"]{background:var(--input);color:var(--foreground);}
.t3k-viewer-btn:focus-visible,.t3k-viewer-range:focus-visible{outline:2px solid var(--ring);outline-offset:-2px;}
.t3k-viewer-btn svg{width:15px;height:15px;flex:none;}
.t3k-viewer-icon{padding:0;width:28px;}
.t3k-viewer-solo{height:32px;border:1px solid var(--border);background:var(--background);}
.t3k-viewer-solo[aria-pressed="true"]{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground);}
.t3k-viewer-readout{min-width:66px;text-align:center;font:12px var(--font-mono);font-variant-numeric:tabular-nums;color:var(--foreground);}
.t3k-viewer-deg{min-width:48px;text-align:right;font:12px var(--font-mono);font-variant-numeric:tabular-nums;color:var(--foreground);}
.t3k-viewer-info{margin-left:auto;font:12px var(--font-mono);font-variant-numeric:tabular-nums;color:var(--muted-foreground);white-space:nowrap;}
.t3k-viewer-range{width:150px;margin:0;accent-color:var(--primary);cursor:pointer;}
.t3k-viewer-stage{position:relative;flex:1 1 auto;min-height:120px;overflow:hidden;touch-action:none;outline:none;user-select:none;-webkit-user-select:none;background:var(--muted);}
.t3k-viewer-stage:focus-visible{box-shadow:inset 0 0 0 2px var(--ring);}
.t3k-viewer-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}
.t3k-viewer-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted-foreground);pointer-events:none;}
.t3k-viewer-chip{position:absolute;top:10px;padding:2px 8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);color:var(--card-foreground);font-size:11px;font-weight:500;pointer-events:none;}
`;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rad = (deg) => (deg * Math.PI) / 180;
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const pct = (z) => `${Math.round(z * 100)}%`;
  const normAngle = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
  const clampZoom = (z) => clamp(z, MIN_ZOOM, MAX_ZOOM);
  const quarterOf = (a) => Math.round(a / 90);
  const mod4 = (n) => ((n % 4) + 4) % 4;

  // ---- parsing (forgiving inputs, loud failures) ---------------------------------------------

  function finite(v, name) {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new TypeError(`viewer: ${name} must be a finite number, got ${JSON.stringify(v)}`);
    }
    return n;
  }

  function bool(v, name) {
    if (typeof v !== "boolean")
      throw new TypeError(`viewer: ${name} must be true or false, got ${JSON.stringify(v)}`);
    return v;
  }

  function parseZoom(v) {
    if (typeof v === "number") return clampZoom(finite(v, "zoom"));
    const s = String(v).trim().toLowerCase();
    if (s === "fit") return "fit";
    const m = /^(\d*\.?\d+)\s*(%|x)?$/.exec(s);
    if (!m)
      throw new Error(
        `viewer: zoom must be 'fit', a number (1 = 100%), '100%' or '2x'; got ${JSON.stringify(v)}`,
      );
    const n = Number(m[1]);
    return clampZoom(m[2] === "%" ? n / 100 : n);
  }

  function ratioOf(aspect) {
    if (aspect === "free") return null;
    const [a, b] = aspect.split(":").map(Number);
    return a / b;
  }

  function parseAspect(v) {
    if (v == null) return "free";
    if (typeof v === "number") {
      if (!(v > 0) || !Number.isFinite(v)) throw new Error(`viewer: invalid aspect ${v}`);
      return parseAspect(`${v}:1`);
    }
    const s = String(v).trim().toLowerCase();
    if (s === "" || s === "free" || s === "none" || s === "original") return "free";
    const parts = s.split(/[:/x×]/);
    if (parts.length > 2)
      throw new Error(
        `viewer: aspect must look like "16:9", "1:1" or "free"; got ${JSON.stringify(v)}`,
      );
    const a = Number(parts[0]);
    const b = parts.length === 2 ? Number(parts[1]) : 1;
    if (!(a > 0) || !(b > 0)) throw new Error(`viewer: invalid aspect ${JSON.stringify(v)}`);
    for (const name of ASPECT_PRESETS) {
      const r = ratioOf(name);
      if (r !== null && Math.abs(r - a / b) < 1e-3) return name;
    }
    return `${+a.toFixed(3)}:${+b.toFixed(3)}`;
  }

  function swapAspect(aspect) {
    if (aspect === "free") return "free";
    const [a, b] = aspect.split(":");
    return parseAspect(`${b}:${a}`);
  }

  function parseMode(v) {
    const mode = MODE_ALIASES[String(v).trim().toLowerCase()];
    if (!mode)
      throw new Error(`viewer: mode must be 'single', 'split' or 'side'; got ${JSON.stringify(v)}`);
    return mode;
  }

  function parseSplit(v) {
    if (typeof v === "string" && v.trim().endsWith("%"))
      return clamp(finite(v.trim().slice(0, -1), "split") / 100, 0, 1);
    return clamp(finite(v, "split"), 0, 1);
  }

  function parseCenter(v) {
    if (v === null) return null;
    const [x, y] = Array.isArray(v) ? v : [v && v.x, v && v.y];
    return { x: finite(x, "center.x"), y: finite(y, "center.y") };
  }

  // ---- crop geometry (pure) -------------------------------------------------------------------
  // Frame F: the output canvas (source size, w/h swapped after an odd quarter turn). The source S is
  // drawn centred in F and rotated by `angle`; a crop is valid when every corner lies on the photo.

  const emptyCrop = (aspect = "free", angle = 0) => ({ x: 0, y: 0, w: 0, h: 0, angle, aspect });

  function frameOf(S, angle) {
    return quarterOf(angle) % 2 ? { W: S.h, H: S.w } : { W: S.w, H: S.h };
  }

  function fits(c, F, S) {
    const th = rad(c.angle);
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    const dx = c.x + c.w / 2 - F.W / 2;
    const dy = c.y + c.h / 2 - F.H / 2;
    return CORNERS.every(([sx, sy]) => {
      const vx = dx + (sx * c.w) / 2;
      const vy = dy + (sy * c.h) / 2;
      return (
        Math.abs(cs * vx + sn * vy) <= S.w / 2 + EPS &&
        Math.abs(-sn * vx + cs * vy) <= S.h / 2 + EPS
      );
    });
  }

  // Shrinks about centre (dx, dy) (offset from the frame centre) until the crop fits; returns the rect.
  function shrinkAbout(c, w, h, dx, dy, F, S) {
    const at = (k) => ({
      x: F.W / 2 + dx - (w * k) / 2,
      y: F.H / 2 + dy - (h * k) / 2,
      w: w * k,
      h: h * k,
      angle: c.angle,
      aspect: c.aspect,
    });
    if (fits(at(1), F, S)) return at(1);
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(at(mid), F, S)) lo = mid;
      else hi = mid;
    }
    return at(lo);
  }

  // Keeps the crop on the photo with the aspect intact. Two candidates: shrink about the current
  // centre (clamped onto the photo), or push the box inside first and then shrink. The larger wins;
  // ties keep the centre, so straightening a centred crop stays centred.
  function constrainCrop(c, F, S) {
    const hw = S.w / 2;
    const hh = S.h / 2;
    const th = rad(c.angle);
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    const w = Math.max(MIN_CROP, c.w);
    const h = Math.max(MIN_CROP, c.h);
    const onPhoto = (dx, dy) => {
      const ux = clamp(cs * dx + sn * dy, -hw, hw);
      const uy = clamp(-sn * dx + cs * dy, -hh, hh);
      return [cs * ux - sn * uy, sn * ux + cs * uy];
    };
    const [kx, ky] = onPhoto(c.x + w / 2 - F.W / 2, c.y + h / 2 - F.H / 2);
    const kept = shrinkAbout(c, w, h, kx, ky, F, S);
    if (kept.w >= w - EPS) return kept;
    let dx = kx;
    let dy = ky;
    for (let i = 0; i < 24; i++) {
      for (const [sx, sy] of CORNERS) {
        const vx = dx + (sx * w) / 2;
        const vy = dy + (sy * h) / 2;
        const ux = cs * vx + sn * vy;
        const uy = -sn * vx + cs * vy;
        const ex = ux > hw ? ux - hw : ux < -hw ? ux + hw : 0;
        const ey = uy > hh ? uy - hh : uy < -hh ? uy + hh : 0;
        dx -= cs * ex - sn * ey;
        dy -= sn * ex + cs * ey;
      }
    }
    [dx, dy] = onPhoto(dx, dy);
    const pushed = shrinkAbout(c, w, h, dx, dy, F, S);
    return pushed.w > kept.w * 1.001 ? pushed : kept;
  }

  // Largest centred crop of the aspect on the (straightened) photo.
  function fullCrop(F, S, aspect, angle) {
    const r = ratioOf(aspect);
    let w = F.W;
    let h = F.H;
    if (r) {
      if (w / h > r) w = h * r;
      else h = w / r;
    }
    return constrainCrop({ x: (F.W - w) / 2, y: (F.H - h) / 2, w, h, angle, aspect }, F, S);
  }

  const lerpRect = (a, b, t) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
    angle: b.angle,
    aspect: b.aspect,
  });

  // Goes as far from `start` toward `target` as the photo allows (anchors stay put).
  function fitAlong(start, target, F, S) {
    if (fits(target, F, S)) return target;
    if (!fits(start, F, S)) return constrainCrop(target, F, S);
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (fits(lerpRect(start, target, mid), F, S)) lo = mid;
      else hi = mid;
    }
    return lerpRect(start, target, lo);
  }

  // Moves without shrinking, sliding along edges.
  function moveWithin(start, dx, dy, F, S) {
    let c = fitAlong(start, { ...start, x: start.x + dx, y: start.y + dy }, F, S);
    c = fitAlong(c, { ...c, x: start.x + dx }, F, S);
    return fitAlong(c, { ...c, y: start.y + dy }, F, S);
  }

  function resizeWithin(start, target, F, S, locked) {
    let c = fitAlong(start, target, F, S);
    if (locked) return c;
    c = fitAlong(c, { ...c, x: target.x, w: target.w }, F, S);
    return fitAlong(c, { ...c, y: target.y, h: target.h }, F, S);
  }

  // Moves one handle; aspect-locked when `r` is set.
  function resizeCrop(s, h, q, r) {
    let x0 = s.x;
    let y0 = s.y;
    let x1 = s.x + s.w;
    let y1 = s.y + s.h;
    if (!r) {
      if (h.hx < 0) x0 = Math.min(q.x, x1 - MIN_CROP);
      if (h.hx > 0) x1 = Math.max(q.x, x0 + MIN_CROP);
      if (h.hy < 0) y0 = Math.min(q.y, y1 - MIN_CROP);
      if (h.hy > 0) y1 = Math.max(q.y, y0 + MIN_CROP);
    } else if (h.hx && h.hy) {
      const ax = h.hx < 0 ? x1 : x0;
      const ay = h.hy < 0 ? y1 : y0;
      let w = Math.max(MIN_CROP, h.hx > 0 ? q.x - ax : ax - q.x);
      let hh = Math.max(MIN_CROP, h.hy > 0 ? q.y - ay : ay - q.y);
      if (w / r >= hh) hh = w / r;
      else w = hh * r;
      x0 = h.hx > 0 ? ax : ax - w;
      x1 = x0 + w;
      y0 = h.hy > 0 ? ay : ay - hh;
      y1 = y0 + hh;
    } else if (h.hx) {
      const ax = h.hx < 0 ? x1 : x0;
      const w = Math.max(MIN_CROP, h.hx > 0 ? q.x - ax : ax - q.x);
      const cy = (y0 + y1) / 2;
      x0 = h.hx > 0 ? ax : ax - w;
      x1 = x0 + w;
      y0 = cy - w / r / 2;
      y1 = cy + w / r / 2;
    } else {
      const ay = h.hy < 0 ? y1 : y0;
      const hh = Math.max(MIN_CROP, h.hy > 0 ? q.y - ay : ay - q.y);
      const cx = (x0 + x1) / 2;
      y0 = h.hy > 0 ? ay : ay - hh;
      y1 = y0 + hh;
      x0 = cx - (hh * r) / 2;
      x1 = cx + (hh * r) / 2;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, angle: s.angle, aspect: s.aspect };
  }

  // Maps a point / rect of frame F0 through d clockwise quarter turns.
  function turnPoint(p, d, F0) {
    if (d === 1) return { x: F0.H - p.y, y: p.x };
    if (d === 2) return { x: F0.W - p.x, y: F0.H - p.y };
    return { x: p.y, y: F0.W - p.x };
  }

  function turnRect(c, d, F0) {
    const a = turnPoint({ x: c.x, y: c.y }, d, F0);
    const b = turnPoint({ x: c.x + c.w, y: c.y + c.h }, d, F0);
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    };
  }

  // ---- sources ----------------------------------------------------------------------------------

  function dimsOf(d) {
    if (d instanceof HTMLImageElement) return { w: d.naturalWidth, h: d.naturalHeight };
    if (d instanceof HTMLVideoElement) return { w: d.videoWidth, h: d.videoHeight };
    return { w: d.width, h: d.height };
  }

  function isDrawable(src) {
    return (
      src instanceof HTMLImageElement ||
      src instanceof HTMLCanvasElement ||
      src instanceof HTMLVideoElement ||
      src instanceof ImageBitmap ||
      (typeof OffscreenCanvas !== "undefined" && src instanceof OffscreenCanvas)
    );
  }

  function videoReady(v) {
    if (v.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      v.addEventListener("loadeddata", () => resolve(), { once: true });
      v.addEventListener("error", () => reject(new Error("viewer: video failed to load")), {
        once: true,
      });
    });
  }

  async function prepare(src) {
    if (src == null) return null;
    let draw = src;
    if (typeof src === "string") {
      draw = new Image();
      draw.src = src;
      await draw.decode();
    } else if (src instanceof Blob) {
      draw = await createImageBitmap(src);
    } else if (!isDrawable(src)) {
      throw new TypeError(
        "viewer: source must be an image, canvas, video, ImageBitmap, Blob/File or URL string",
      );
    } else if (src instanceof HTMLImageElement) {
      await src.decode();
    } else if (src instanceof HTMLVideoElement) {
      await videoReady(src);
    }
    const { w, h } = dimsOf(draw);
    if (!(w > 0 && h > 0)) throw new Error("viewer: source has no pixels (is it loaded?)");
    return { draw, w, h, video: draw instanceof HTMLVideoElement, preview: null, unbind: null };
  }

  function preview(src) {
    const edge = Math.max(src.w, src.h);
    if (src.video || edge <= PREVIEW_EDGE) return null;
    if (!src.preview) {
      const k = PREVIEW_EDGE / edge;
      const c = document.createElement("canvas");
      c.width = Math.round(src.w * k);
      c.height = Math.round(src.h * k);
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(src.draw, 0, 0, c.width, c.height);
      src.preview = { canvas: c, ratio: k };
    }
    return src.preview;
  }

  // ---- DOM helpers ------------------------------------------------------------------------------

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function btn({ label = "", icon = "", title, cls = "", onClick }) {
    const b = el("button", `t3k-viewer-btn ${cls}`.trim());
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = icon;
    if (label) b.append(document.createTextNode(label));
    b.addEventListener("click", onClick);
    return b;
  }

  function group(...nodes) {
    const g = el("div", "t3k-viewer-group");
    g.append(...nodes);
    return g;
  }

  function ensureStyles() {
    if (document.querySelector('style[data-t3kit="viewer"]')) return;
    const style = el("style");
    style.setAttribute("data-t3kit", "viewer");
    style.textContent = CSS;
    document.head.append(style);
  }

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const token = (name) => cs.getPropertyValue(name).trim();
    return { background: token("--background"), foreground: token("--foreground") };
  }

  // ---- instance ---------------------------------------------------------------------------------

  function create(container, options = {}) {
    if (!(container instanceof HTMLElement))
      throw new TypeError("viewer.create: container must be an HTMLElement");
    ensureStyles();
    const opts = { toolbar: true, crop: true, ...options };
    const st = {
      zoom: "fit",
      mode: "single",
      split: 0.5,
      center: null,
      cropping: false,
      grid: true,
      crop: emptyCrop(),
    };
    const sources = { after: null, before: null };
    const tokens = { after: 0, before: 0 };
    const listeners = { change: new Set(), load: new Set() };
    const pointers = new Map();
    const ui = { modes: {}, aspects: {} };
    const pending = { crop: false, center: false };
    let drag = null;
    let pinch = null;
    let spaceDown = false;
    let angleBase = null;
    let colors = null;
    let raf = 0;
    let syncPending = false; // toolbar text waits for the next frame, like the canvas
    let emitPending = false;
    let destroyed = false;

    // ---- geometry -------------------------------------------------------------------------------

    const frame = (angle = st.crop.angle) => frameOf(sources.after, angle);

    function layout() {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (st.mode === "side") {
        const pw = Math.max(0, (w - GAP) / 2);
        const before = { role: "before", rect: { x: 0, y: 0, w: pw, h }, cx: pw / 2, cy: h / 2 };
        const after = {
          role: "after",
          rect: { x: pw + GAP, y: 0, w: pw, h },
          cx: pw + GAP + pw / 2,
          cy: h / 2,
        };
        return { mode: "side", w, h, vps: [before, after], interact: after, divX: null };
      }
      const after = { role: "after", rect: { x: 0, y: 0, w, h }, cx: w / 2, cy: h / 2 };
      if (st.mode === "split") {
        const divX = st.split * w;
        const before = { role: "before", rect: { x: 0, y: 0, w: divX, h }, cx: w / 2, cy: h / 2 };
        return { mode: "split", w, h, vps: [after, before], interact: after, divX };
      }
      return { mode: "single", w, h, vps: [after], interact: after, divX: null };
    }

    const vpAt = (p, L) => (L.mode === "side" && p.x < L.vps[1].rect.x ? L.vps[0] : L.interact);

    // What "fit" frames: the whole frame while cropping, else the crop (the exported result).
    function fitTarget() {
      const F = frame();
      const c = st.crop;
      return st.cropping || !(c.w > 0) ? { x: 0, y: 0, w: F.W, h: F.H } : c;
    }

    function fitZoom() {
      const t = fitTarget();
      const r = layout().interact.rect;
      return clampZoom(
        Math.min(Math.max(1, r.w - 2 * PAD) / t.w, Math.max(1, r.h - 2 * PAD) / t.h),
      );
    }

    const effZoom = () => (!sources.after ? 1 : st.zoom === "fit" ? fitZoom() : st.zoom);

    function effCenter() {
      if (!sources.after) return null;
      if (st.zoom !== "fit" && st.center) return st.center;
      const t = fitTarget();
      return { x: t.x + t.w / 2, y: t.y + t.h / 2 };
    }

    function clampCenter(c) {
      const F = frame();
      return { x: clamp(c.x, 0, F.W), y: clamp(c.y, 0, F.H) };
    }

    function toFrame(p, vp) {
      const z = effZoom();
      const C = effCenter();
      return { x: C.x + (p.x - vp.cx) / z, y: C.y + (p.y - vp.cy) / z };
    }

    function screenRect(vp, z, C, c) {
      return { x: vp.cx + z * (c.x - C.x), y: vp.cy + z * (c.y - C.y), w: z * c.w, h: z * c.h };
    }

    const handlePoint = (f, h) => ({
      x: f.x + (f.w * (h.hx + 1)) / 2,
      y: f.y + (f.h * (h.hy + 1)) / 2,
    });
    const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

    function movable() {
      const F = frame();
      return st.crop.w < F.W - 0.5 || st.crop.h < F.H - 0.5;
    }

    function hitTest(p, L) {
      if (st.cropping && inRect(p, L.interact.rect)) {
        const f = screenRect(L.interact, effZoom(), effCenter(), st.crop);
        for (const h of HANDLES) {
          const q = handlePoint(f, h);
          if (Math.abs(p.x - q.x) <= HIT && Math.abs(p.y - q.y) <= HIT)
            return { kind: "crop", id: h.id };
        }
      }
      if (L.divX !== null && sources.before && Math.abs(p.x - L.divX) <= 8)
        return { kind: "split" };
      if (st.cropping && movable()) {
        const f = screenRect(L.interact, effZoom(), effCenter(), st.crop);
        if (inRect(p, f) && inRect(p, L.interact.rect)) return { kind: "crop", id: "move" };
      }
      return { kind: "pan" };
    }

    // ---- state changes ----------------------------------------------------------------------------

    function setZoomNumber(z) {
      if (st.zoom === "fit") st.center = effCenter();
      st.zoom = clampZoom(z);
    }

    function applyFit() {
      st.zoom = "fit";
      st.center = null;
    }

    function zoomAt(factor, p, vp) {
      const q = toFrame(p, vp);
      const z1 = clampZoom(effZoom() * factor);
      st.zoom = z1;
      st.center = clampCenter({ x: q.x - (p.x - vp.cx) / z1, y: q.y - (p.y - vp.cy) / z1 });
    }

    function zoomCenter(factor) {
      const vp = layout().interact;
      zoomAt(factor, { x: vp.cx, y: vp.cy }, vp);
    }

    function panBy(dx, dy) {
      const z = effZoom();
      const C = effCenter();
      st.zoom = z;
      st.center = clampCenter({ x: C.x - dx / z, y: C.y - dy / z });
    }

    function commitCrop(next) {
      const S = sources.after;
      st.crop = S ? constrainCrop(next, frame(next.angle), S) : next;
    }

    function resetCrop() {
      const S = sources.after;
      st.crop = S ? fullCrop(frameOf(S, 0), S, "free", 0) : emptyCrop();
    }

    function mergeCrop(patch) {
      for (const k of Object.keys(patch)) {
        if (!CROP_KEYS.includes(k))
          throw new Error(`viewer: unknown crop key "${k}". Valid: ${CROP_KEYS.join(", ")}`);
      }
      const S = sources.after;
      const cur = st.crop;
      let next = { ...cur };
      const geo = ["x", "y", "w", "h"].some((k) => k in patch);
      for (const k of ["x", "y", "w", "h"]) if (k in patch) next[k] = finite(patch[k], `crop.${k}`);
      if ("angle" in patch) next.angle = normAngle(finite(patch.angle, "crop.angle"));
      const d = mod4(quarterOf(next.angle) - quarterOf(cur.angle));
      if (S && d && !geo && cur.w > 0) {
        const F0 = frameOf(S, cur.angle);
        next = {
          ...turnRect(cur, d, F0),
          angle: next.angle,
          aspect: d % 2 ? swapAspect(cur.aspect) : cur.aspect,
        };
        if (st.zoom !== "fit" && st.center) st.center = turnPoint(st.center, d, F0);
      }
      let aspectChanged = false;
      if ("aspect" in patch) {
        const a = parseAspect(patch.aspect);
        aspectChanged = a !== next.aspect;
        next.aspect = a;
      }
      const r = ratioOf(next.aspect);
      if (r && "w" in patch) next.h = next.w / r;
      else if (r && "h" in patch) next.w = next.h * r;
      else if (r && aspectChanged && S) {
        const full = fullCrop(frameOf(S, next.angle), S, next.aspect, next.angle);
        const cx = next.w > 0 ? next.x + next.w / 2 : full.x + full.w / 2;
        const cy = next.h > 0 ? next.y + next.h / 2 : full.y + full.h / 2;
        next = { ...next, x: cx - full.w / 2, y: cy - full.h / 2, w: full.w, h: full.h };
      }
      if (!S && geo) pending.crop = true;
      commitCrop(next);
    }

    function swapOrientation() {
      const c = st.crop;
      if (c.aspect !== "free") {
        mergeCrop({ aspect: swapAspect(c.aspect) });
        return;
      }
      commitCrop({ ...c, x: c.x + (c.w - c.h) / 2, y: c.y + (c.h - c.w) / 2, w: c.h, h: c.w });
    }

    function straighten(value) {
      const S = sources.after;
      if (!angleBase) angleBase = { crop: { ...st.crop }, q: quarterOf(st.crop.angle) };
      const angle = normAngle(angleBase.q * 90 + clamp(value, -STRAIGHTEN, STRAIGHTEN));
      const base = { ...angleBase.crop, angle };
      st.crop = S && base.w > 0 ? constrainCrop(base, frame(angle), S) : base;
    }

    function rotate(dir) {
      angleBase = null;
      mergeCrop({ angle: st.crop.angle + 90 * Math.sign(dir || 1) });
    }

    function adoptAfter(prev, next) {
      if (!next) {
        st.center = null;
        st.crop = emptyCrop(st.crop.aspect, st.crop.angle);
        return;
      }
      if (prev && prev.w === next.w && prev.h === next.h) {
        commitCrop(st.crop);
        return;
      }
      // A replacement picture of another size starts level and uncropped (aspect kept); the first
      // picture honours a crop / angle set before it loaded; same-size updates keep the crop.
      const angle = prev ? 0 : st.crop.angle;
      st.crop = pending.crop
        ? constrainCrop(st.crop, frameOf(next, st.crop.angle), next)
        : fullCrop(frameOf(next, angle), next, st.crop.aspect, angle);
      if (!pending.center) st.center = null;
      pending.crop = false;
      pending.center = false;
    }

    // ---- rendering --------------------------------------------------------------------------------

    function invalidate() {
      if (!raf && !destroyed) raf = requestAnimationFrame(onFrame);
    }

    function onFrame() {
      raf = 0;
      if (destroyed) return;
      if (syncPending) {
        syncPending = false;
        sync();
      }
      render();
      if (emitPending) {
        emitPending = false;
        const value = get();
        for (const cb of [...listeners.change]) cb(value);
      }
    }

    function drawSource(src, vp, z, C, dpr) {
      const S = sources.after;
      const F = frame();
      const k = src === S ? 1 : Math.min(S.w / src.w, S.h / src.h);
      const pv = preview(src);
      const img = pv && z * k * dpr <= pv.ratio ? pv.canvas : src.draw;
      const ox = vp.cx + z * (F.W / 2 - C.x);
      const oy = vp.cy + z * (F.H / 2 - C.y);
      ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * ox, dpr * oy);
      ctx.rotate(rad(st.crop.angle));
      ctx.imageSmoothingEnabled = st.zoom === "fit" || z < 2;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, (-src.w * k) / 2, (-src.h * k) / 2, src.w * k, src.h * k);
    }

    function drawOverlay(vp, z, C, interactive, dpr) {
      const f = screenRect(vp, z, C, st.crop);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      ctx.rect(vp.rect.x, vp.rect.y, vp.rect.w, vp.rect.h);
      ctx.clip();
      ctx.globalAlpha = 0.62;
      ctx.fillStyle = colors.background;
      ctx.beginPath();
      ctx.rect(vp.rect.x, vp.rect.y, vp.rect.w, vp.rect.h);
      ctx.rect(f.x, f.y, f.w, f.h);
      ctx.fill("evenodd");
      ctx.strokeStyle = colors.foreground;
      if (st.grid) {
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const t of [1 / 3, 2 / 3]) {
          ctx.moveTo(Math.round(f.x + f.w * t) + 0.5, f.y);
          ctx.lineTo(Math.round(f.x + f.w * t) + 0.5, f.y + f.h);
          ctx.moveTo(f.x, Math.round(f.y + f.h * t) + 0.5);
          ctx.lineTo(f.x + f.w, Math.round(f.y + f.h * t) + 0.5);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.round(f.x) + 0.5,
        Math.round(f.y) + 0.5,
        Math.round(f.w) - 1,
        Math.round(f.h) - 1,
      );
      if (interactive) {
        const len = Math.max(6, Math.min(18, f.w / 4, f.h / 4));
        const path = new Path2D();
        for (const h of HANDLES) {
          const p = handlePoint(f, h);
          if (h.hx && h.hy) {
            path.moveTo(p.x, p.y - h.hy * len);
            path.lineTo(p.x, p.y);
            path.lineTo(p.x - h.hx * len, p.y);
          } else if (h.hx) {
            path.moveTo(p.x, p.y - len / 2);
            path.lineTo(p.x, p.y + len / 2);
          } else {
            path.moveTo(p.x - len / 2, p.y);
            path.lineTo(p.x + len / 2, p.y);
          }
        }
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = colors.background;
        ctx.lineWidth = 6;
        ctx.stroke(path);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colors.foreground;
        ctx.lineWidth = 3;
        ctx.stroke(path);
      }
      ctx.restore();
    }

    function drawDivider(L, dpr) {
      const x = Math.round(L.divX) + 0.5;
      const mid = L.h / 2;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = colors.background;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, L.h);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.foreground;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, mid, 15, 0, Math.PI * 2);
      ctx.fillStyle = colors.background;
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(x - 3, mid - 5);
      ctx.lineTo(x - 8, mid);
      ctx.lineTo(x - 3, mid + 5);
      ctx.moveTo(x + 3, mid - 5);
      ctx.lineTo(x + 8, mid);
      ctx.lineTo(x + 3, mid + 5);
      ctx.stroke();
      ctx.restore();
    }

    function updateChips(L) {
      const showing = Boolean(sources.after) && L.mode !== "single";
      chipBefore.hidden = !showing;
      chipAfter.hidden = !showing;
      if (!showing) return;
      chipBefore.textContent = sources.before ? "Before" : "No before image";
      chipAfter.textContent = "After";
      const left = L.mode === "split" ? 10 : L.vps[0].rect.x + 10;
      chipBefore.style.left = `${left}px`;
      chipBefore.style.right = "auto";
      if (L.mode === "split") {
        chipAfter.style.left = "auto";
        chipAfter.style.right = "10px";
      } else {
        chipAfter.style.left = `${L.vps[1].rect.x + 10}px`;
        chipAfter.style.right = "auto";
      }
    }

    function render() {
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(stage.clientWidth * dpr);
      const ph = Math.round(stage.clientHeight * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pw, ph);
      const L = layout();
      empty.hidden = Boolean(sources.after);
      updateChips(L);
      if (!sources.after) return;
      colors = colors || readColors();
      const z = effZoom();
      const C = effCenter();
      for (const vp of L.vps) {
        const src = vp.role === "before" ? sources.before : sources.after;
        if (!src) continue;
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.beginPath();
        ctx.rect(vp.rect.x, vp.rect.y, vp.rect.w, vp.rect.h);
        ctx.clip();
        if (!st.cropping) {
          const f = screenRect(vp, z, C, st.crop);
          ctx.beginPath();
          ctx.rect(f.x, f.y, f.w, f.h);
          ctx.clip();
        }
        drawSource(src, vp, z, C, dpr);
        ctx.restore();
      }
      if (st.cropping) {
        if (L.mode === "side") {
          for (const vp of L.vps)
            if (vp.role === "after" || sources.before)
              drawOverlay(vp, z, C, vp === L.interact, dpr);
        } else drawOverlay(L.interact, z, C, true, dpr);
      }
      if (L.divX !== null && sources.before) drawDivider(L, dpr);
    }

    function sync() {
      const S = sources.after;
      if (!ui.readout) return;
      ui.readout.textContent = S
        ? st.zoom === "fit"
          ? `Fit ${pct(effZoom())}`
          : pct(st.zoom)
        : "—";
      ui.fit.setAttribute("aria-pressed", String(st.zoom === "fit"));
      ui.actual.setAttribute("aria-pressed", String(st.zoom === 1));
      for (const [key, b] of Object.entries(ui.modes))
        b.setAttribute("aria-pressed", String(st.mode === key));
      const c = st.crop;
      ui.info.textContent = !S
        ? ""
        : c.w > 0 && (Math.round(c.w) !== S.w || Math.round(c.h) !== S.h || c.angle)
          ? `${S.w} × ${S.h}  →  ${Math.round(c.w)} × ${Math.round(c.h)}`
          : `${S.w} × ${S.h}`;
      if (!ui.cropBtn) return;
      ui.cropBtn.setAttribute("aria-pressed", String(st.cropping));
      ui.cropBar.hidden = !st.cropping;
      for (const [preset, b] of Object.entries(ui.aspects)) {
        const on = c.aspect === preset || (preset !== "free" && swapAspect(c.aspect) === preset);
        b.setAttribute("aria-pressed", String(on));
        b.textContent = on && preset !== "free" ? c.aspect : preset === "free" ? "Free" : preset;
      }
      const residual = c.angle - quarterOf(c.angle) * 90;
      ui.angle.value = String(round3(residual));
      ui.angleOut.textContent = `${residual.toFixed(1)}°`;
      ui.grid.setAttribute("aria-pressed", String(st.grid));
    }

    // Toolbar text and canvas both update on the next frame, so a drag costs one redraw per frame.
    function redraw() {
      syncPending = true;
      invalidate();
    }

    function changed() {
      redraw();
      emitPending = true;
    }

    const edit = (fn) => () => {
      fn();
      changed();
    };

    // ---- public surface ---------------------------------------------------------------------------

    function get() {
      const c = st.crop;
      const C = effCenter();
      return {
        zoom: st.zoom === "fit" ? "fit" : round3(st.zoom),
        mode: st.mode,
        split: round3(st.split),
        center: C ? { x: round3(C.x), y: round3(C.y) } : null,
        cropping: st.cropping,
        grid: st.grid,
        crop: {
          x: round3(c.x),
          y: round3(c.y),
          w: round3(c.w),
          h: round3(c.h),
          angle: round3(c.angle),
          aspect: c.aspect,
        },
      };
    }

    function set(partial) {
      if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
        throw new TypeError(
          'viewer.set expects an object, e.g. set({ zoom: "fit", mode: "split" })',
        );
      }
      for (const key of Object.keys(partial)) {
        if (!KEYS.includes(key))
          throw new Error(`viewer.set: unknown key "${key}". Valid keys: ${KEYS.join(", ")}`);
      }
      if ("mode" in partial) st.mode = parseMode(partial.mode);
      if ("split" in partial) st.split = parseSplit(partial.split);
      if ("cropping" in partial) st.cropping = bool(partial.cropping, "cropping");
      if ("grid" in partial) st.grid = bool(partial.grid, "grid");
      const patch = {};
      if ("crop" in partial) {
        if (partial.crop === null) resetCrop();
        else if (typeof partial.crop === "object" && !Array.isArray(partial.crop))
          Object.assign(patch, partial.crop);
        else throw new TypeError("viewer.set: crop must be an object or null");
      }
      if ("aspect" in partial) patch.aspect = partial.aspect;
      if ("angle" in partial) patch.angle = partial.angle;
      if (Object.keys(patch).length > 0) {
        angleBase = null;
        mergeCrop(patch);
      }
      if ("zoom" in partial) {
        const z = parseZoom(partial.zoom);
        if (z === "fit") applyFit();
        else setZoomNumber(z);
      }
      if ("center" in partial) {
        const c = parseCenter(partial.center);
        if (c && st.zoom === "fit" && sources.after) st.zoom = effZoom();
        st.center = c && sources.after ? clampCenter(c) : c;
        pending.center = Boolean(c) && !sources.after;
      }
      redraw();
    }

    function unbindVideo(src) {
      if (src && src.unbind) src.unbind();
    }

    function bindVideo(src) {
      if (!src || !src.video) return;
      const v = src.draw;
      let handle = 0;
      const loop = () => {
        invalidate();
        if (!v.paused && !v.ended) handle = v.requestVideoFrameCallback(loop);
      };
      const onPlay = () => {
        if (typeof v.requestVideoFrameCallback === "function")
          handle = v.requestVideoFrameCallback(loop);
      };
      const onTick = () => invalidate();
      const hasRvfc = typeof v.requestVideoFrameCallback === "function";
      v.addEventListener("play", onPlay);
      v.addEventListener("seeked", onTick);
      if (!hasRvfc) v.addEventListener("timeupdate", onTick);
      if (!v.paused) onPlay();
      src.unbind = () => {
        v.removeEventListener("play", onPlay);
        v.removeEventListener("seeked", onTick);
        v.removeEventListener("timeupdate", onTick);
        if (handle && hasRvfc) v.cancelVideoFrameCallback(handle);
      };
    }

    async function loadSource(kind, src) {
      const token = ++tokens[kind];
      const next = await prepare(src);
      if (destroyed || token !== tokens[kind]) return;
      const prev = sources[kind];
      unbindVideo(prev);
      sources[kind] = next;
      bindVideo(next);
      if (kind === "after") {
        angleBase = null;
        adoptAfter(prev && { w: prev.w, h: prev.h }, next);
      }
      redraw();
      if (kind === "after" && next) {
        const size = getSize();
        for (const cb of [...listeners.load]) cb(size);
      }
    }

    function getSize() {
      const S = sources.after;
      return S ? { width: S.w, height: S.h } : { width: 0, height: 0 };
    }

    function refresh() {
      for (const kind of ["after", "before"]) {
        const s = sources[kind];
        if (!s) continue;
        const prev = { w: s.w, h: s.h };
        const d = dimsOf(s.draw);
        if (!(d.w > 0 && d.h > 0)) throw new Error(`viewer.refresh: ${kind} source has no pixels`);
        s.w = d.w;
        s.h = d.h;
        s.preview = null;
        if (kind === "after") adoptAfter(prev, s);
      }
      redraw();
    }

    function reset() {
      st.mode = "single";
      st.split = 0.5;
      st.grid = true;
      st.cropping = false;
      angleBase = null;
      applyFit();
      resetCrop();
      redraw();
    }

    function exportCanvas() {
      const S = sources.after;
      if (!S) throw new Error("viewer.exportCanvas: no source image set");
      const c = st.crop;
      const F = frame();
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(c.w));
      out.height = Math.max(1, Math.round(c.h));
      const g = out.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.translate(F.W / 2 - c.x, F.H / 2 - c.y);
      g.rotate(rad(c.angle));
      g.drawImage(S.draw, -S.w / 2, -S.h / 2, S.w, S.h);
      return out;
    }

    function exportBlob({ type = "image/png", quality = 0.92 } = {}) {
      const out = exportCanvas();
      return new Promise((resolve, reject) => {
        out.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error(`viewer.exportBlob: could not encode ${type}`)),
          type,
          quality,
        );
      });
    }

    function on(name, cb) {
      const bucket = listeners[name];
      if (!bucket) throw new Error(`viewer.on: unknown event "${name}". Use 'change' or 'load'.`);
      if (typeof cb !== "function") throw new TypeError("viewer.on: callback must be a function");
      bucket.add(cb);
      return () => bucket.delete(cb);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      unbindVideo(sources.after);
      unbindVideo(sources.before);
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", onTheme);
      listeners.change.clear();
      listeners.load.clear();
      root.remove();
    }

    // ---- pointer, wheel and keyboard --------------------------------------------------------------

    function pt(e) {
      const r = stage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function updateCursor(p) {
      if (!sources.after) stage.style.cursor = "";
      else if (drag && drag.kind === "pan") stage.style.cursor = "grabbing";
      else if (spaceDown) stage.style.cursor = "grab";
      else {
        const hit = hitTest(p, layout());
        stage.style.cursor =
          hit.kind === "crop" ? CURSORS[hit.id] : hit.kind === "split" ? "ew-resize" : "grab";
      }
    }

    function startPinch() {
      drag = null;
      const [a, b] = [...pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const vp = vpAt(mid, layout());
      pinch = {
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        z0: effZoom(),
        vp,
        anchor: toFrame(mid, vp),
      };
    }

    function movePinch() {
      const [a, b] = [...pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = clampZoom((pinch.z0 * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / pinch.d0);
      st.zoom = z;
      st.center = clampCenter({
        x: pinch.anchor.x - (mid.x - pinch.vp.cx) / z,
        y: pinch.anchor.y - (mid.y - pinch.vp.cy) / z,
      });
      changed();
    }

    function startDrag(p, L, forcePan) {
      const hit = forcePan ? { kind: "pan" } : hitTest(p, L);
      if (hit.kind === "crop") {
        return {
          kind: "crop",
          id: hit.id,
          start: { ...st.crop },
          q0: toFrame(p, L.interact),
          ratio: ratioOf(st.crop.aspect),
        };
      }
      if (hit.kind === "split") return { kind: "split" };
      return { kind: "pan", start: p, C: effCenter(), z: effZoom() };
    }

    function onPointerDown(e) {
      if (destroyed || !sources.after || (e.button !== 0 && e.button !== 1)) return;
      e.preventDefault();
      stage.focus({ preventScroll: true, focusVisible: false });
      stage.setPointerCapture(e.pointerId);
      const p = pt(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        startPinch();
        return;
      }
      if (pointers.size > 2) return;
      angleBase = null;
      drag = startDrag(p, layout(), e.button === 1 || spaceDown);
      updateCursor(p);
    }

    function onPointerMove(e) {
      const p = pt(e);
      if (!pointers.has(e.pointerId)) {
        updateCursor(p);
        return;
      }
      pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        movePinch();
        return;
      }
      if (!drag) return;
      const L = layout();
      if (drag.kind === "pan") {
        st.zoom = drag.z;
        st.center = clampCenter({
          x: drag.C.x - (p.x - drag.start.x) / drag.z,
          y: drag.C.y - (p.y - drag.start.y) / drag.z,
        });
      } else if (drag.kind === "split") {
        st.split = clamp(p.x / Math.max(1, L.w), 0, 1);
      } else {
        const S = sources.after;
        const F = frame();
        const q = toFrame(p, L.interact);
        if (drag.id === "move") {
          st.crop = moveWithin(drag.start, q.x - drag.q0.x, q.y - drag.q0.y, F, S);
        } else {
          const h = HANDLES.find((v) => v.id === drag.id);
          st.crop = resizeWithin(
            drag.start,
            resizeCrop(drag.start, h, q, drag.ratio),
            F,
            S,
            Boolean(drag.ratio),
          );
        }
      }
      changed();
    }

    function onPointerUp(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) drag = null;
      updateCursor(pt(e));
    }

    function onWheel(e) {
      if (!sources.after) return;
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      const p = pt(e);
      zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), p, vpAt(p, layout()));
      changed();
    }

    function onDblClick(e) {
      if (!sources.after) return;
      const p = pt(e);
      if (st.zoom === "fit") zoomAt(1 / effZoom(), p, vpAt(p, layout()));
      else applyFit();
      changed();
    }

    function onKey(e) {
      if (!sources.after || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") {
        e.preventDefault();
        spaceDown = true;
        stage.style.cursor = drag ? stage.style.cursor : "grab";
        return;
      }
      const step = e.shiftKey ? 160 : 40;
      const actions = {
        "+": () => zoomCenter(1.25),
        "=": () => zoomCenter(1.25),
        "-": () => zoomCenter(1 / 1.25),
        _: () => zoomCenter(1 / 1.25),
        0: applyFit,
        f: applyFit,
        1: () => setZoomNumber(1),
        ArrowLeft: () => panBy(step, 0),
        ArrowRight: () => panBy(-step, 0),
        ArrowUp: () => panBy(0, step),
        ArrowDown: () => panBy(0, -step),
        c: () => {
          st.cropping = !st.cropping;
        },
        g: () => {
          st.grid = !st.grid;
        },
        r: () => rotate(1),
        R: () => rotate(-1),
      };
      const action = actions[e.key];
      if (!action) return;
      e.preventDefault();
      action();
      changed();
    }

    function onKeyUp(e) {
      if (e.key === " ") spaceDown = false;
    }

    function onTheme() {
      colors = null;
      invalidate();
    }

    // ---- DOM --------------------------------------------------------------------------------------

    function buildToolbar() {
      const bar = el("div", "t3k-viewer-bar");
      ui.readout = el("output", "t3k-viewer-readout");
      ui.readout.setAttribute("aria-live", "polite");
      ui.fit = btn({ label: "Fit", title: "Fit to view (0)", onClick: edit(applyFit) });
      ui.actual = btn({
        label: "100%",
        title: "Actual pixels (1)",
        onClick: edit(() => setZoomNumber(1)),
      });
      bar.append(
        group(
          ui.fit,
          ui.actual,
          btn({
            label: "−",
            title: "Zoom out (-)",
            cls: "t3k-viewer-icon",
            onClick: edit(() => zoomCenter(1 / 1.25)),
          }),
          ui.readout,
          btn({
            label: "+",
            title: "Zoom in (+)",
            cls: "t3k-viewer-icon",
            onClick: edit(() => zoomCenter(1.25)),
          }),
        ),
      );
      const modes = group();
      for (const [key, label] of [
        ["single", "Single"],
        ["split", "Split"],
        ["side", "Side by side"],
      ]) {
        ui.modes[key] = btn({
          label,
          title: key === "split" ? "Before / after split" : `${label} view`,
          onClick: edit(() => {
            st.mode = key;
          }),
        });
        modes.append(ui.modes[key]);
      }
      bar.append(modes);
      if (opts.crop) {
        ui.cropBtn = btn({
          label: "Crop",
          icon: ICONS.crop,
          title: "Crop and straighten (C)",
          cls: "t3k-viewer-solo",
          onClick: edit(() => {
            st.cropping = !st.cropping;
          }),
        });
        bar.append(ui.cropBtn);
      }
      ui.info = el("span", "t3k-viewer-info");
      bar.append(ui.info);
      root.append(bar);
      if (!opts.crop) return;

      const cropBar = el("div", "t3k-viewer-bar");
      ui.cropBar = cropBar;
      const aspects = group();
      for (const preset of ASPECT_PRESETS) {
        ui.aspects[preset] = btn({
          label: preset === "free" ? "Free" : preset,
          title: preset === "free" ? "Free aspect" : `Aspect ${preset}`,
          onClick: edit(() => {
            const a = st.crop.aspect;
            if (a === preset || (preset !== "free" && swapAspect(a) === preset)) return;
            mergeCrop({ aspect: preset });
          }),
        });
        aspects.append(ui.aspects[preset]);
      }
      aspects.append(
        btn({
          icon: ICONS.swap,
          title: "Swap portrait / landscape",
          cls: "t3k-viewer-icon",
          onClick: edit(swapOrientation),
        }),
      );

      ui.angle = el("input", "t3k-viewer-range");
      ui.angle.type = "range";
      ui.angle.min = "-45";
      ui.angle.max = "45";
      ui.angle.step = "0.1";
      ui.angle.setAttribute("aria-label", "Straighten angle in degrees");
      ui.angle.title = "Straighten (double-click to level)";
      ui.angle.addEventListener(
        "input",
        edit(() => straighten(Number(ui.angle.value))),
      );
      ui.angle.addEventListener("change", () => {
        angleBase = null;
      });
      ui.angle.addEventListener(
        "dblclick",
        edit(() => {
          straighten(0);
          angleBase = null;
        }),
      );
      ui.angleOut = el("output", "t3k-viewer-deg");
      const straightenField = el("label", "t3k-viewer-field", "Straighten");
      straightenField.append(ui.angle, ui.angleOut);

      ui.grid = btn({
        icon: ICONS.grid,
        title: "Rule-of-thirds grid (G)",
        cls: "t3k-viewer-icon",
        onClick: edit(() => {
          st.grid = !st.grid;
        }),
      });
      cropBar.append(
        el("span", "t3k-viewer-field", "Aspect"),
        aspects,
        straightenField,
        group(
          btn({
            icon: ICONS.rotL,
            title: "Rotate 90° left (Shift+R)",
            cls: "t3k-viewer-icon",
            onClick: edit(() => rotate(-1)),
          }),
          btn({
            icon: ICONS.rotR,
            title: "Rotate 90° right (R)",
            cls: "t3k-viewer-icon",
            onClick: edit(() => rotate(1)),
          }),
          ui.grid,
        ),
        group(
          btn({
            label: "Reset crop",
            title: "Reset crop and rotation",
            onClick: edit(() => {
              angleBase = null;
              resetCrop();
            }),
          }),
        ),
      );
      root.append(cropBar);
    }

    const root = el("div", "t3k-viewer-root");
    if (opts.toolbar) buildToolbar();
    const stage = el("div", "t3k-viewer-stage");
    stage.tabIndex = 0;
    stage.setAttribute("role", "group");
    stage.setAttribute(
      "aria-label",
      "Image viewer. Plus and minus zoom, 0 fits, 1 shows 100 percent, arrow keys pan, C crops.",
    );
    const canvas = el("canvas", "t3k-viewer-canvas");
    const ctx = canvas.getContext("2d");
    const empty = el("div", "t3k-viewer-empty", "No image loaded");
    const chipBefore = el("div", "t3k-viewer-chip");
    const chipAfter = el("div", "t3k-viewer-chip");
    stage.append(canvas, empty, chipBefore, chipAfter);
    root.append(stage);
    container.append(root);

    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("pointercancel", onPointerUp);
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("dblclick", onDblClick);
    stage.addEventListener("keydown", onKey);
    stage.addEventListener("keyup", onKeyUp);
    stage.addEventListener("blur", () => {
      spaceDown = false;
    });

    const ro = new ResizeObserver(redraw);
    ro.observe(stage);
    const mo = new MutationObserver(onTheme);
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
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", onTheme);

    const api = {
      get,
      set,
      setSource: (src) => loadSource("after", src),
      setBefore: (src) => loadSource("before", src),
      refresh,
      getSize,
      fit: () => {
        applyFit();
        redraw();
      },
      actualSize: () => {
        setZoomNumber(1);
        redraw();
      },
      rotate: (dir) => {
        rotate(dir);
        redraw();
      },
      reset,
      exportCanvas,
      exportBlob,
      on,
      destroy,
    };

    if (opts.value) set(opts.value);
    redraw();
    return api;
  }

  t3kit.viewer = { create };
})();
