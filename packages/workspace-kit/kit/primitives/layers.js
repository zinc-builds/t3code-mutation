/**
 * layers: 2D compositing canvas. Image, text and shape layers with move/scale/rotate handles, opacity, 16 blend
 * modes, z-order, selection, undo, a compact layer list and an inspector. exportBlob flattens at full resolution.
 * create(container, options?) -> instance. options = any get() keys (width 1920, height 1080, background null,
 *   layers []) plus fit (0..1, default 0.8: image size relative to the artboard when w and h are omitted).
 * Value (plain JSON): { v:1, width, height, background (CSS colour | null = transparent), layers: [bottom..top] }
 *   every layer: id, type 'image'|'text'|'shape', name, visible, locked, opacity 0..1, blend, x, y (artboard px
 *     of the centre), rotation (deg, clockwise), scaleX, scaleY. Omitted keys get defaults; unknown keys throw.
 *   image: src (Blob | blob: or data: URL; get() returns a URL string), w, h (unscaled px). Give w or h and the
 *     other follows the aspect ratio; give neither and it is fitted and centred. Both are null until it loads.
 *   text:  text ('\n' = line break), size (px), weight 100-900, family (CSS | null = theme sans), color,
 *     align 'left'|'center'|'right', lineHeight, tracking (letter spacing, thousandths of an em, default 0).
 *     The box follows the text.
 *   shape: kind 'rect'|'ellipse', w, h, radius, fill (CSS | null), stroke (CSS | null), strokeWidth.
 *     type 'rect' or 'ellipse' is accepted as shorthand for { type: 'shape', kind }.
 *   Colours: any CSS colour or a theme token like 'var(--primary)' (resolved at draw and export time).
 *   blend: normal multiply screen overlay darken lighten color-dodge color-burn hard-light soft-light
 *     difference exclusion hue saturation color luminosity
 * Instance (programmatic calls never emit 'change'; all but set are undoable):
 *   get() -> scene copy.   set(partial) -> merges width/height/background; layers replaces the list; clears undo.
 *   addImage(blob | url, props?) -> Promise<id>, once decoded. props: any image keys plus fit.
 *   addText(text, props?) -> id.   addShape('rect' | 'ellipse', props?) -> id.   New layers are selected.
 *   update(id, patch) (shallow merge; id and type are fixed).   remove(id).   duplicate(id) -> newId.
 *   reorder(id, index | 'up' | 'down' | 'front' | 'back') (index 0 = bottom).
 *   select(id | null).   selected() -> id | null.   undo(), redo(), canUndo(), canRedo().
 *   exportBlob({ type: 'image/png'|'image/jpeg'|'image/webp', quality: 0.92, scale: 1 }) -> Promise<Blob>.
 *     Renders width*scale x height*scale from the original images. JPEG with no background is white-filled.
 *   on('change', cb): user edits, payload get(); a drag emits once, on release. on('select', cb): id | null.
 *   on() returns an unsubscribe function.   destroy() removes DOM, listeners and object URLs it created.
 * Keys: arrows nudge (Shift x10), Delete removes, Esc deselects, Ctrl/Cmd+D duplicates, Ctrl/Cmd+Z undo,
 *   Ctrl/Cmd+Shift+Z redo, Ctrl/Cmd+] or [ raise or lower (Shift: to top or bottom). Pointer: drag moves (snaps
 *   to centre), corner handles scale uniformly, edge handles one axis (Shift keeps aspect), Alt scales from
 *   centre, the top knob rotates (Shift snaps to 15 deg). Renders on change only; previews cap images at 2048 px.
 * Example:
 *   const doc = t3kit.layers.create(el, { width: 1920, height: 1080 });
 *   await doc.addImage(photoBlob, { name: 'Photo' });
 *   doc.addText('Golden hour', { y: 900, size: 140, weight: 800, color: '#ffffff' });
 *   doc.on('change', (scene) => save(scene));
 *   const png = await doc.exportBlob({ type: 'image/png' });
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});

  const BLENDS = [
    ["normal", "Normal"],
    ["multiply", "Multiply"],
    ["screen", "Screen"],
    ["overlay", "Overlay"],
    ["darken", "Darken"],
    ["lighten", "Lighten"],
    ["color-dodge", "Color dodge"],
    ["color-burn", "Color burn"],
    ["hard-light", "Hard light"],
    ["soft-light", "Soft light"],
    ["difference", "Difference"],
    ["exclusion", "Exclusion"],
    ["hue", "Hue"],
    ["saturation", "Saturation"],
    ["color", "Color"],
    ["luminosity", "Luminosity"],
  ];
  const BLEND_IDS = BLENDS.map((b) => b[0]);
  const TYPES = ["image", "text", "shape"];
  const ALIGNS = ["left", "center", "right"];
  const SHAPE_KINDS = ["rect", "ellipse"];
  const EXPORT_TYPES = ["image/png", "image/jpeg", "image/webp"];
  const COMMON_KEYS = [
    "id",
    "type",
    "name",
    "visible",
    "locked",
    "opacity",
    "blend",
    "x",
    "y",
    "rotation",
    "scaleX",
    "scaleY",
  ];
  const LAYER_KEYS = {
    image: [...COMMON_KEYS, "src", "w", "h"],
    text: [
      ...COMMON_KEYS,
      "text",
      "family",
      "size",
      "weight",
      "color",
      "align",
      "lineHeight",
      "tracking",
    ],
    shape: [...COMMON_KEYS, "kind", "w", "h", "radius", "fill", "stroke", "strokeWidth"],
  };
  const SCENE_KEYS = ["v", "width", "height", "background", "layers"];
  const MAX_SIDE = 16384;
  const PREVIEW_MAX = 2048;
  const HANDLE_HIT = 8;
  const ROT_OFFSET = 26;
  const SNAP_PX = 6;
  const HISTORY_MAX = 100;
  const COALESCE_MS = 800;
  const MIN_SCALE = 0.01;
  const ROT_HANDLE = { id: "rot", rot: true, cursor: "grab" };
  const HANDLES = [
    { id: "nw", kx: -1, ky: -1, cursor: "nwse-resize" },
    { id: "n", kx: 0, ky: -1, cursor: "ns-resize" },
    { id: "ne", kx: 1, ky: -1, cursor: "nesw-resize" },
    { id: "e", kx: 1, ky: 0, cursor: "ew-resize" },
    { id: "se", kx: 1, ky: 1, cursor: "nwse-resize" },
    { id: "s", kx: 0, ky: 1, cursor: "ns-resize" },
    { id: "sw", kx: -1, ky: 1, cursor: "nesw-resize" },
    { id: "w", kx: -1, ky: 0, cursor: "ew-resize" },
    ROT_HANDLE,
  ];
  const CORNERS = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const DELTAS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const TOOLBAR = [
    ["addText", "Text", "Add a text layer"],
    ["addRect", "Rectangle", "Add a rectangle"],
    ["addEllipse", "Ellipse", "Add an ellipse"],
    ["|"],
    ["forward", "Forward", "Bring forward (Ctrl/Cmd+])"],
    ["backward", "Backward", "Send backward (Ctrl/Cmd+[)"],
    ["duplicate", "Duplicate", "Duplicate (Ctrl/Cmd+D)"],
    ["remove", "Delete", "Delete layer (Delete)"],
    ["|"],
    ["undo", "Undo", "Undo (Ctrl/Cmd+Z)"],
    ["redo", "Redo", "Redo (Ctrl/Cmd+Shift+Z)"],
  ];
  const FAMILIES = [
    ["", "Theme sans"],
    ['Georgia, "Times New Roman", serif', "Serif"],
    ['"SF Mono", Menlo, Consolas, monospace', "Mono"],
    ['Impact, "Arial Narrow", sans-serif', "Condensed"],
  ];
  const WEIGHTS = [
    ["300", "Light"],
    ["400", "Regular"],
    ["500", "Medium"],
    ["600", "Semibold"],
    ["700", "Bold"],
    ["800", "Extra bold"],
    ["900", "Black"],
  ];
  const ALIGN_OPTIONS = [
    ["left", "Left"],
    ["center", "Center"],
    ["right", "Right"],
  ];
  const ICON = {
    eye: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
    eyeOff:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 13.5 13.5 2.5" stroke="currentColor" stroke-width="1.4"/></svg>',
    lock: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    unlock:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 4.8-1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    image:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 12l3.2-3.4 2.3 2.2 1.7-1.6L13 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    text: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M8 4v9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    rect: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    ellipse:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="8" rx="5.5" ry="4.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  };
  const STYLE = `
.t3k-layers-root{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;width:100%;height:100%;min-height:360px;padding:8px;background:var(--background);color:var(--foreground);font:13px/1.4 var(--font-sans)}
.t3k-layers-root *{box-sizing:border-box}
.t3k-layers-root [hidden]{display:none!important}
.t3k-layers-toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.t3k-layers-sep{width:1px;align-self:stretch;background:var(--border);margin:2px 4px}
.t3k-layers-btn{font:inherit;font-size:12px;color:var(--foreground);background:var(--card);border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);padding:4px 10px;cursor:pointer;white-space:nowrap}
.t3k-layers-btn:hover:not(:disabled){border-color:var(--ring)}
.t3k-layers-btn:disabled{opacity:.45;cursor:default}
.t3k-layers-root :focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.t3k-layers-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px}
.t3k-layers-root[data-wide="1"] .t3k-layers-body{flex-direction:row}
.t3k-layers-stage{position:relative;flex:1 1 auto;min-width:0;min-height:240px;border:1px solid var(--border);border-radius:var(--radius);background:var(--muted);overflow:hidden}
.t3k-layers-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none}
.t3k-layers-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted-foreground);font-size:12px;pointer-events:none}
.t3k-layers-panel{display:flex;flex-direction:column;gap:8px;min-width:0}
.t3k-layers-root[data-wide="1"] .t3k-layers-panel{flex:0 0 268px;width:268px;min-height:0;overflow:auto}
.t3k-layers-section{display:flex;flex-direction:column;min-height:0;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);color:var(--card-foreground);overflow:hidden;flex:none}
.t3k-layers-head{display:flex;justify-content:space-between;padding:6px 10px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted-foreground);border-bottom:1px solid var(--border)}
.t3k-layers-count{font-family:var(--font-mono);font-weight:400;letter-spacing:0}
.t3k-layers-list{list-style:none;margin:0;padding:4px;display:flex;flex-direction:column;gap:1px;overflow:auto;max-height:240px}
.t3k-layers-row{display:flex;align-items:center;gap:6px;min-height:28px;padding:2px 4px;border-radius:calc(var(--radius) - 3px);cursor:default;user-select:none}
.t3k-layers-row:hover{background:color-mix(in srgb,var(--foreground) 6%,transparent)}
.t3k-layers-row[aria-selected="true"]{background:color-mix(in srgb,var(--primary) 22%,transparent)}
.t3k-layers-row[aria-selected="true"] .t3k-layers-name{font-weight:600}
.t3k-layers-row.is-off .t3k-layers-name{color:var(--muted-foreground);text-decoration:line-through}
.t3k-layers-row.is-drop-before{box-shadow:inset 0 2px 0 var(--ring)}
.t3k-layers-row.is-drop-after{box-shadow:inset 0 -2px 0 var(--ring)}
.t3k-layers-glyph{display:inline-flex;color:var(--muted-foreground);flex:none}
.t3k-layers-glyph svg,.t3k-layers-icon svg{width:14px;height:14px;display:block}
.t3k-layers-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3k-layers-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--muted-foreground);cursor:pointer}
.t3k-layers-icon[data-act="locked"][aria-pressed="false"]{opacity:.45}
.t3k-layers-icon[aria-pressed="true"]{color:var(--foreground)}
.t3k-layers-icon:hover{background:color-mix(in srgb,var(--foreground) 10%,transparent);opacity:1}
.t3k-layers-empty{padding:8px;color:var(--muted-foreground);font-size:12px;list-style:none}
.t3k-layers-inspector{display:grid;gap:8px;padding:10px}
.t3k-layers-note{margin:0;color:var(--muted-foreground);font-size:12px}
.t3k-layers-field{display:grid;grid-template-columns:88px minmax(0,1fr);gap:8px;align-items:center;font-size:12px}
.t3k-layers-field-label{color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3k-layers-field :is(input,select,textarea){min-width:0;width:100%;font:inherit;font-size:12px;color:var(--foreground);background:var(--background);border:1px solid var(--input);border-radius:calc(var(--radius) - 3px);padding:3px 6px}
.t3k-layers-field textarea{resize:vertical;min-height:52px}
.t3k-layers-range{display:flex;align-items:center;gap:8px;min-width:0}
.t3k-layers-range input{flex:1 1 auto;padding:0;border:0;accent-color:var(--primary)}
.t3k-layers-field output{flex:none;min-width:24px;text-align:right;font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground)}
.t3k-layers-color{display:flex;align-items:center;gap:8px;min-width:0}
.t3k-layers-field .t3k-layers-color input[type=color]{width:34px;height:24px;padding:0 2px;flex:none;cursor:pointer}
.t3k-layers-check{display:inline-flex;align-items:center;gap:4px;color:var(--muted-foreground);white-space:nowrap}
.t3k-layers-field .t3k-layers-check input{width:auto;margin:0;accent-color:var(--primary)}`;

  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const r1 = (v) => Math.round(v * 10) / 10;
  const num = (raw) => (String(raw).trim() === "" ? NaN : Number(raw));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const normalizeAngle = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
  const compositeOp = (blend) => (blend === "normal" ? "source-over" : blend);
  const numPatch =
    (key, ok = () => true, map = (n) => n) =>
    (raw) => {
      const n = num(raw);
      return isNum(n) && ok(n) ? { [key]: map(n) } : null;
    };

  function fail(message) {
    throw new TypeError(`layers: ${message}`);
  }

  const rootStyle = getComputedStyle(document.documentElement);
  const VAR_RE = /var\(\s*(--[\w-]+)\s*\)/g;
  function resolveCss(value) {
    if (!value.includes("var(")) return value;
    return value.replace(VAR_RE, (m, name) => rootStyle.getPropertyValue(name).trim());
  }
  const THEME_TOKENS = [
    "--background",
    "--foreground",
    "--muted",
    "--muted-foreground",
    "--card",
    "--card-foreground",
    "--popover",
    "--border",
    "--input",
    "--ring",
    "--primary",
    "--primary-foreground",
    "--accent",
    "--accent-foreground",
    "--destructive",
    "--warning",
    "--success",
    "--info",
    "--chart-1",
    "--chart-2",
    "--chart-3",
    "--chart-4",
    "--chart-5",
    "--chart-6",
  ];
  function checkColor(value, what) {
    if (typeof value !== "string" || !CSS.supports("color", resolveCss(value))) {
      fail(
        `${what} must be a CSS colour or a theme token like 'var(--primary)' (got ${JSON.stringify(value)})`,
      );
    }
    for (const [, name] of value.matchAll(VAR_RE)) {
      if (!THEME_TOKENS.includes(name))
        fail(
          `${what} uses ${name}, which is not a theme token (use one of ${THEME_TOKENS.join(" ")})`,
        );
    }
  }

  const SPEC = {
    name: {
      key: "name",
      label: "Name",
      kind: "text",
      get: (l) => l.name,
      patch: (v) => (v.trim() ? { name: v } : null),
    },
    opacity: {
      key: "opacity",
      label: "Opacity",
      kind: "range",
      min: 0,
      max: 100,
      step: 1,
      get: (l) => Math.round(l.opacity * 100),
      patch: numPatch(
        "opacity",
        () => true,
        (n) => clamp(n, 0, 100) / 100,
      ),
    },
    blend: {
      key: "blend",
      label: "Blend",
      kind: "select",
      options: BLENDS,
      get: (l) => l.blend,
      patch: (v) => ({ blend: v }),
    },
    x: { key: "x", label: "X", kind: "number", get: (l) => r1(l.x), patch: numPatch("x") },
    y: { key: "y", label: "Y", kind: "number", get: (l) => r1(l.y), patch: numPatch("y") },
    rotation: {
      key: "rotation",
      label: "Rotation (°)",
      kind: "number",
      get: (l) => r1(l.rotation),
      patch: numPatch("rotation", () => true, normalizeAngle),
    },
    scale: {
      key: "scale",
      label: "Scale (%)",
      kind: "number",
      get: (l) => r1(l.scaleX * 100),
      patch: (raw) => {
        const n = num(raw);
        return isNum(n) && n > 0 ? { scaleX: n / 100, scaleY: n / 100 } : null;
      },
    },
    text: {
      key: "text",
      label: "Text",
      kind: "textarea",
      get: (l) => l.text,
      patch: (v) => ({ text: v }),
    },
    family: {
      key: "family",
      label: "Font",
      kind: "select",
      options: FAMILIES,
      get: (l) => l.family ?? "",
      patch: (v) => ({ family: v === "" ? null : v }),
    },
    size: {
      key: "size",
      label: "Size (px)",
      kind: "number",
      get: (l) => r1(l.size),
      patch: numPatch("size", (n) => n > 0),
    },
    weight: {
      key: "weight",
      label: "Weight",
      kind: "select",
      options: WEIGHTS,
      get: (l) => String(l.weight),
      patch: (v) => ({ weight: Number(v) }),
    },
    tracking: {
      key: "tracking",
      label: "Tracking",
      kind: "number",
      get: (l) => r1(l.tracking),
      patch: numPatch("tracking", (n) => n >= -1000 && n <= 1000),
    },
    align: {
      key: "align",
      label: "Align",
      kind: "select",
      options: ALIGN_OPTIONS,
      get: (l) => l.align,
      patch: (v) => ({ align: v }),
    },
    color: {
      key: "color",
      label: "Colour",
      kind: "color",
      get: (l) => l.color,
      patch: (v) => ({ color: v }),
    },
    kind: {
      key: "kind",
      label: "Shape",
      kind: "select",
      options: [
        ["rect", "Rectangle"],
        ["ellipse", "Ellipse"],
      ],
      get: (l) => l.kind,
      patch: (v) => ({ kind: v }),
    },
    fill: {
      key: "fill",
      label: "Fill",
      kind: "color",
      nullLabel: "None",
      auto: "--primary",
      get: (l) => l.fill,
      patch: (v) => ({ fill: v }),
    },
    stroke: {
      key: "stroke",
      label: "Stroke",
      kind: "color",
      nullLabel: "None",
      auto: "--foreground",
      get: (l) => l.stroke,
      patch: (v) => ({ stroke: v }),
    },
    strokeWidth: {
      key: "strokeWidth",
      label: "Stroke width",
      kind: "number",
      get: (l) => r1(l.strokeWidth),
      patch: numPatch("strokeWidth", (n) => n >= 0),
    },
    radius: {
      key: "radius",
      label: "Radius (px)",
      kind: "number",
      get: (l) => r1(l.radius),
      patch: numPatch("radius", (n) => n >= 0),
    },
  };

  function specsFor(layer) {
    const common = [SPEC.name, SPEC.opacity, SPEC.blend, SPEC.x, SPEC.y, SPEC.rotation, SPEC.scale];
    if (layer.type === "text")
      return [
        ...common,
        SPEC.text,
        SPEC.family,
        SPEC.size,
        SPEC.weight,
        SPEC.tracking,
        SPEC.align,
        SPEC.color,
      ];
    if (layer.type === "shape") {
      const shape = [SPEC.kind, SPEC.fill, SPEC.stroke, SPEC.strokeWidth];
      return layer.kind === "rect" ? [...common, ...shape, SPEC.radius] : [...common, ...shape];
    }
    return common;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function injectStyle() {
    if (document.querySelector('style[data-t3kit="layers"]')) return;
    const style = document.createElement("style");
    style.dataset.t3kit = "layers";
    style.textContent = STYLE;
    document.head.append(style);
  }

  function readTheme() {
    const v = (name) => rootStyle.getPropertyValue(name).trim();
    return {
      fg: v("--foreground"),
      sans: v("--font-sans"),
      primary: v("--primary"),
      ring: v("--ring"),
      border: v("--border"),
      bg: v("--background"),
      muted: v("--muted"),
    };
  }

  const probeCtx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  function cssToHex(css) {
    probeCtx.fillStyle = "#000000";
    probeCtx.fillStyle = resolveCss(css);
    probeCtx.clearRect(0, 0, 1, 1);
    probeCtx.fillRect(0, 0, 1, 1);
    const d = probeCtx.getImageData(0, 0, 1, 1).data;
    return `#${[d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }

  const measureCtx = document.createElement("canvas").getContext("2d");
  let uidSeq = 0;
  function uid() {
    uidSeq += 1;
    return `L${uidSeq.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function checkLayer(l) {
    const where = `layer "${l.id}"`;
    const need = (ok, key, hint = "") => {
      if (!ok) fail(`${where} has invalid ${key}: ${JSON.stringify(l[key])}${hint}`);
    };
    need(typeof l.id === "string" && l.id.length > 0, "id", " (non-empty string)");
    need(typeof l.name === "string", "name");
    need(typeof l.visible === "boolean", "visible");
    need(typeof l.locked === "boolean", "locked");
    need(isNum(l.opacity), "opacity", " (0..1)");
    need(BLEND_IDS.includes(l.blend), "blend", `. Use one of: ${BLEND_IDS.join(", ")}`);
    need(isNum(l.x), "x");
    need(isNum(l.y), "y");
    need(isNum(l.rotation), "rotation", " (degrees)");
    need(isNum(l.scaleX) && l.scaleX > 0, "scaleX");
    need(isNum(l.scaleY) && l.scaleY > 0, "scaleY");
    l.opacity = clamp(l.opacity, 0, 1);
    l.scaleX = clamp(l.scaleX, MIN_SCALE, 100);
    l.scaleY = clamp(l.scaleY, MIN_SCALE, 100);
    if (l.type === "image") {
      need(typeof l.src === "string" && l.src.length > 0, "src", " (Blob, blob: URL or data: URL)");
      need(l.w === null || (isNum(l.w) && l.w > 0), "w");
      need(l.h === null || (isNum(l.h) && l.h > 0), "h");
    } else if (l.type === "text") {
      need(typeof l.text === "string", "text");
      need(l.family === null || typeof l.family === "string", "family");
      need(isNum(l.size) && l.size > 0, "size");
      need(isNum(l.weight) && l.weight >= 100 && l.weight <= 900, "weight", " (100..900)");
      checkColor(l.color, `${where} color`);
      need(ALIGNS.includes(l.align), "align", `. Use one of: ${ALIGNS.join(", ")}`);
      need(isNum(l.lineHeight) && l.lineHeight > 0, "lineHeight");
      need(
        isNum(l.tracking) && l.tracking >= -1000 && l.tracking <= 1000,
        "tracking",
        " (-1000..1000, thousandths of an em)",
      );
    } else {
      need(SHAPE_KINDS.includes(l.kind), "kind", `. Use one of: ${SHAPE_KINDS.join(", ")}`);
      need(isNum(l.w) && l.w > 0, "w");
      need(isNum(l.h) && l.h > 0, "h");
      need(isNum(l.radius) && l.radius >= 0, "radius");
      if (l.fill !== null) checkColor(l.fill, `${where} fill`);
      if (l.stroke !== null) checkColor(l.stroke, `${where} stroke`);
      need(isNum(l.strokeWidth) && l.strokeWidth >= 0, "strokeWidth");
    }
    return l;
  }

  function create(container, options = {}) {
    if (!(container instanceof HTMLElement)) fail("create: container must be an HTMLElement");
    if (!options || typeof options !== "object") fail("create: options must be an object");
    injectStyle();
    const { fit: fitOption, ...sceneOptions } = options;
    const fitRatio = fitOption ?? 0.8;
    if (!isNum(fitRatio) || fitRatio <= 0 || fitRatio > 1)
      fail(`fit must be a number in (0, 1] (got ${fitRatio})`);

    const abort = new AbortController();
    const opt = { signal: abort.signal };
    const listeners = new Map([
      ["change", new Set()],
      ["select", new Set()],
    ]);
    const imageCache = new Map();
    const ownedUrls = [];
    const history = [];
    const future = [];
    let scene = { v: 1, width: 1920, height: 1080, background: null, layers: [] };
    let theme = readTheme();
    let selectedId = null;
    let lastLabel = "";
    let lastEditAt = 0;
    let renderFrame = 0;
    let dragFrame = 0;
    let drag = null;
    let view = { s: 1, ox: 0, oy: 0, cw: 0, ch: 0 };
    const guides = { x: false, y: false };
    let inspectorKey = null;
    let fields = [];
    let listSignature = null;
    let listDrag = null;
    let userDepth = 0;
    let destroyed = false;

    const root = el("div", "t3k-layers-root");
    root.dataset.wide = "0";
    const toolbar = el("div", "t3k-layers-toolbar");
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Layer tools");
    const body = el("div", "t3k-layers-body");
    const stage = el("div", "t3k-layers-stage");
    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-label", "Layer canvas. Arrow keys nudge, Delete removes.");
    const hint = el("div", "t3k-layers-hint", "Add an image, text or shape to begin.");
    stage.append(canvas, hint);
    const panel = el("aside", "t3k-layers-panel");
    const listSection = el("section", "t3k-layers-section");
    const list = el("ol", "t3k-layers-list");
    list.setAttribute("aria-label", "Layers, front to back");
    const listHead = el("header", "t3k-layers-head", "Layers");
    const countEl = el("span", "t3k-layers-count");
    listHead.append(countEl);
    listSection.append(listHead, list);
    const inspSection = el("section", "t3k-layers-section");
    const insp = el("div", "t3k-layers-inspector");
    inspSection.append(el("header", "t3k-layers-head", "Inspector"), insp);
    panel.append(listSection, inspSection);
    body.append(stage, panel);
    const toolbarBtns = {};
    for (const [cmd, label, title] of TOOLBAR) {
      if (cmd === "|") {
        toolbar.append(el("span", "t3k-layers-sep"));
        continue;
      }
      const b = el("button", "t3k-layers-btn", label);
      b.type = "button";
      b.dataset.cmd = cmd;
      b.title = title;
      toolbarBtns[cmd] = b;
      toolbar.append(b);
    }
    root.append(toolbar, body);
    container.append(root);

    const findIndex = (id) => scene.layers.findIndex((l) => l.id === id);
    const findLayer = (id) => scene.layers.find((l) => l.id === id) ?? null;
    const selectedLayer = () => (selectedId ? findLayer(selectedId) : null);
    const snapshot = () => JSON.stringify(scene);
    const user =
      (fn) =>
      (...args) => {
        userDepth += 1;
        try {
          return fn(...args);
        } finally {
          userDepth -= 1;
        }
      };

    function ownUrl(blob) {
      const url = URL.createObjectURL(blob);
      ownedUrls.push(url);
      return url;
    }

    function defaultsFor(type, spec) {
      const W = scene.width;
      const H = scene.height;
      const base = {
        visible: true,
        locked: false,
        opacity: 1,
        blend: "normal",
        x: W / 2,
        y: H / 2,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
      };
      if (type === "image") return { ...base, name: "Image", src: "", w: null, h: null };
      if (type === "text") {
        const first =
          typeof spec.text === "string" ? spec.text.split("\n")[0].trim().slice(0, 24) : "";
        return {
          ...base,
          name: first || "Text",
          text: "Text",
          family: null,
          size: Math.round(H * 0.09),
          weight: 700,
          color: cssToHex(theme.fg),
          align: "center",
          lineHeight: 1.2,
          tracking: 0,
        };
      }
      const kind = spec.kind ?? "rect";
      return {
        ...base,
        name: kind === "ellipse" ? "Ellipse" : "Rectangle",
        kind,
        w: Math.round(W * 0.25),
        h: Math.round(H * 0.25),
        radius: 0,
        fill: cssToHex(theme.primary),
        stroke: null,
        strokeWidth: 0,
      };
    }

    // Turns a partial layer spec (or a patch onto prev) into a complete, validated layer.
    function normalizeLayer(raw, prev) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("a layer must be an object");
      const spec = {};
      for (const [k, v] of Object.entries(raw)) if (v !== undefined) spec[k] = v;
      if (spec.type === "rect" || spec.type === "ellipse") {
        if (spec.kind !== undefined && spec.kind !== spec.type)
          fail(`type "${spec.type}" conflicts with kind "${spec.kind}"`);
        spec.kind = spec.type;
        spec.type = "shape";
      }
      if (prev) {
        if ("id" in spec && spec.id !== prev.id) fail(`layer "${prev.id}": id cannot change`);
        if ("type" in spec && spec.type !== prev.type)
          fail(`layer "${prev.id}": type cannot change; remove it and add a new layer`);
      }
      const type = prev ? prev.type : spec.type;
      if (!TYPES.includes(type))
        fail(
          `unknown layer type ${JSON.stringify(raw.type)}. Use image, text, shape, rect or ellipse`,
        );
      const allowed = LAYER_KEYS[type];
      for (const k of Object.keys(spec)) {
        if (!allowed.includes(k))
          fail(`${type} layer has unknown key "${k}". Allowed: ${allowed.join(", ")}`);
      }
      if (spec.blend === "source-over") spec.blend = "normal";
      if (spec.src instanceof Blob) spec.src = ownUrl(spec.src);
      const layer = prev
        ? { ...clone(prev), ...spec }
        : { ...defaultsFor(type, spec), ...spec, type };
      if (!layer.id) layer.id = uid();
      return checkLayer(layer);
    }

    function normalizeScene(partial) {
      if (!partial || typeof partial !== "object" || Array.isArray(partial))
        fail("set: scene must be an object");
      for (const k of Object.keys(partial)) {
        if (!SCENE_KEYS.includes(k))
          fail(
            `scene has unknown key "${k}". Allowed: ${SCENE_KEYS.join(", ")}, plus fit in create()`,
          );
      }
      const next = { ...scene };
      for (const key of ["width", "height"]) {
        if (!(key in partial)) continue;
        const v = partial[key];
        if (!isNum(v) || v < 1 || v > MAX_SIDE)
          fail(`${key} must be a number from 1 to ${MAX_SIDE} (got ${JSON.stringify(v)})`);
        next[key] = Math.round(v);
      }
      if ("background" in partial) {
        if (partial.background !== null) checkColor(partial.background, "background");
        next.background = partial.background;
      }
      if ("layers" in partial) {
        if (!Array.isArray(partial.layers)) fail("layers must be an array (bottom to top)");
        const prevScene = scene;
        scene = next;
        try {
          const seen = new Set();
          next.layers = partial.layers.map((raw) => {
            const layer = normalizeLayer(raw);
            if (seen.has(layer.id)) fail(`duplicate layer id "${layer.id}"`);
            seen.add(layer.id);
            return layer;
          });
        } finally {
          scene = prevScene;
        }
      }
      return next;
    }

    function emitSelect() {
      for (const cb of [...listeners.get("select")]) cb(selectedId);
    }

    function emitChange() {
      if (!listeners.get("change").size) return;
      const value = get();
      for (const cb of [...listeners.get("change")]) cb(value);
    }

    function scheduleRender() {
      if (!renderFrame && !destroyed) {
        renderFrame = requestAnimationFrame(() => {
          renderFrame = 0;
          render();
        });
      }
    }

    function changed() {
      scheduleRender();
      syncChrome();
      if (userDepth) emitChange();
    }

    function setSelected(id) {
      if (id !== null && !findLayer(id)) fail(`select: no layer with id "${id}"`);
      if (id === selectedId) return;
      selectedId = id;
      emitSelect();
      scheduleRender();
      syncChrome();
    }

    function pushHistory(before) {
      history.push(before);
      if (history.length > HISTORY_MAX) history.shift();
      future.length = 0;
    }

    function edit(label, mutate) {
      const before = snapshot();
      mutate(scene);
      if (snapshot() === before) return false;
      const now = Date.now();
      if (label && label === lastLabel && now - lastEditAt < COALESCE_MS) future.length = 0;
      else pushHistory(before);
      lastLabel = label ?? "";
      lastEditAt = now;
      changed();
      return true;
    }

    function restore(json) {
      scene = JSON.parse(json);
      lastLabel = "";
      ensureSceneImages();
      if (selectedId && !findLayer(selectedId)) {
        selectedId = null;
        emitSelect();
      }
      changed();
    }

    function undo() {
      if (!history.length) return;
      future.push(snapshot());
      restore(history.pop());
    }

    function redo() {
      if (!future.length) return;
      history.push(snapshot());
      restore(future.pop());
    }

    function sizeImage(layer, rec, fit) {
      if (isNum(layer.w) && isNum(layer.h)) return false;
      const nw = rec.img.naturalWidth;
      const nh = rec.img.naturalHeight;
      if (isNum(layer.w)) layer.h = (layer.w * nh) / nw;
      else if (isNum(layer.h)) layer.w = (layer.h * nw) / nh;
      else {
        const k = Math.min((scene.width * fit) / nw, (scene.height * fit) / nh);
        layer.w = nw * k;
        layer.h = nh * k;
      }
      return true;
    }

    function sizePending(src, rec) {
      let any = false;
      for (const l of scene.layers)
        if (l.type === "image" && l.src === src && sizeImage(l, rec, fitRatio)) any = true;
      if (any) syncChrome();
    }

    function ensureImage(src) {
      let rec = imageCache.get(src);
      if (rec) return rec;
      const img = new Image();
      img.decoding = "async";
      rec = { img, ready: false, preview: null, promise: null };
      rec.promise = new Promise((resolve, reject) => {
        img.onload = () => {
          rec.ready = true;
          rec.preview = makePreview(img);
          if (!destroyed) {
            sizePending(src, rec);
            scheduleRender();
          }
          resolve(rec);
        };
        img.onerror = () => reject(new Error(`layers: could not load image ${src.slice(0, 80)}`));
      });
      imageCache.set(src, rec);
      img.src = src;
      return rec;
    }

    function ensureSceneImages() {
      for (const layer of scene.layers) {
        if (layer.type !== "image") continue;
        const rec = ensureImage(layer.src);
        if (rec.ready) sizeImage(layer, rec, fitRatio);
      }
    }

    function makePreview(img) {
      const long = Math.max(img.naturalWidth, img.naturalHeight);
      if (long <= PREVIEW_MAX) return null;
      const k = PREVIEW_MAX / long;
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      const cx = c.getContext("2d");
      cx.imageSmoothingQuality = "high";
      cx.drawImage(img, 0, 0, c.width, c.height);
      return c;
    }

    function textLayout(layer) {
      const font = `${layer.weight} ${layer.size}px ${layer.family ?? theme.sans}`;
      const spacing = `${(layer.tracking / 1000) * layer.size}px`;
      const lines = layer.text.split("\n");
      measureCtx.font = font;
      measureCtx.letterSpacing = spacing;
      let w = 0;
      for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width);
      measureCtx.letterSpacing = "0px";
      const lh = layer.size * layer.lineHeight;
      return { font, spacing, lines, lh, w: Math.max(w, 1), h: lines.length * lh };
    }

    function layerBox(layer) {
      if (layer.type === "text") return textLayout(layer);
      return { w: layer.w ?? 0, h: layer.h ?? 0 };
    }

    function localToArt(layer, lx, ly) {
      const r = (layer.rotation * Math.PI) / 180;
      const c = Math.cos(r);
      const s = Math.sin(r);
      const px = lx * layer.scaleX;
      const py = ly * layer.scaleY;
      return { x: layer.x + px * c - py * s, y: layer.y + px * s + py * c };
    }

    function artToLocal(layer, a) {
      const r = (layer.rotation * Math.PI) / 180;
      const c = Math.cos(r);
      const s = Math.sin(r);
      const dx = a.x - layer.x;
      const dy = a.y - layer.y;
      return { x: (dx * c + dy * s) / layer.scaleX, y: (-dx * s + dy * c) / layer.scaleY };
    }

    const toScreen = (a) => ({ x: view.ox + a.x * view.s, y: view.oy + a.y * view.s });
    const toArt = (p) => ({ x: (p.x - view.ox) / view.s, y: (p.y - view.oy) / view.s });

    function handleScreen(layer, box, h) {
      if (h.rot) {
        const top = toScreen(localToArt(layer, 0, -box.h / 2));
        const r = (layer.rotation * Math.PI) / 180;
        return { x: top.x + Math.sin(r) * ROT_OFFSET, y: top.y - Math.cos(r) * ROT_OFFSET };
      }
      return toScreen(localToArt(layer, (h.kx * box.w) / 2, (h.ky * box.h) / 2));
    }

    function hitHandle(layer, p) {
      const box = layerBox(layer);
      for (const h of HANDLES) {
        const q = handleScreen(layer, box, h);
        if (Math.hypot(p.x - q.x, p.y - q.y) <= HANDLE_HIT) return h;
      }
      return null;
    }

    function hitLayer(a) {
      for (let i = scene.layers.length - 1; i >= 0; i--) {
        const l = scene.layers[i];
        if (!l.visible || l.locked) continue;
        const box = layerBox(l);
        const p = artToLocal(l, a);
        if (Math.abs(p.x) <= box.w / 2 && Math.abs(p.y) <= box.h / 2) return l;
      }
      return null;
    }

    function localPoint(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function drawLayer(ctx, layer, quality) {
      if (!layer.visible) return;
      if (layer.type === "image") {
        const rec = imageCache.get(layer.src) ?? ensureImage(layer.src);
        if (!rec.ready || !isNum(layer.w) || !isNum(layer.h)) return;
      }
      const box = layerBox(layer);
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = compositeOp(layer.blend);
      ctx.translate(layer.x, layer.y);
      ctx.rotate((layer.rotation * Math.PI) / 180);
      ctx.scale(layer.scaleX, layer.scaleY);
      paint(ctx, layer, box, quality);
      ctx.restore();
    }

    function paint(ctx, layer, box, quality) {
      const hw = box.w / 2;
      const hh = box.h / 2;
      if (layer.type === "image") {
        const rec = imageCache.get(layer.src);
        const source = quality === "export" ? rec.img : (rec.preview ?? rec.img);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(source, -hw, -hh, box.w, box.h);
        return;
      }
      if (layer.type === "shape") {
        ctx.beginPath();
        if (layer.kind === "ellipse") ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
        else ctx.roundRect(-hw, -hh, box.w, box.h, Math.min(layer.radius, hw, hh));
        if (layer.fill) {
          ctx.fillStyle = resolveCss(layer.fill);
          ctx.fill();
        }
        if (layer.stroke && layer.strokeWidth > 0) {
          ctx.strokeStyle = resolveCss(layer.stroke);
          ctx.lineWidth = layer.strokeWidth;
          ctx.stroke();
        }
        return;
      }
      ctx.font = box.font;
      ctx.letterSpacing = box.spacing;
      ctx.fillStyle = resolveCss(layer.color);
      ctx.textBaseline = "middle";
      ctx.textAlign = layer.align;
      const ax = layer.align === "center" ? 0 : layer.align === "right" ? hw : -hw;
      box.lines.forEach((line, i) => ctx.fillText(line, ax, -hh + box.lh * (i + 0.5)));
    }

    function drawBackdrop(ctx) {
      const { s, ox, oy } = view;
      const w = scene.width * s;
      const h = scene.height * s;
      const cell = 10;
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, w, h);
      ctx.clip();
      ctx.fillStyle = theme.bg;
      ctx.fillRect(ox, oy, w, h);
      ctx.fillStyle = theme.border;
      for (let row = 0, y = 0; y < h; y += cell, row++) {
        for (let x = (row % 2) * cell; x < w; x += cell * 2)
          ctx.fillRect(ox + x, oy + y, cell, cell);
      }
      ctx.restore();
    }

    function drawOverlay(ctx) {
      const { s, ox, oy } = view;
      const W = scene.width;
      const H = scene.height;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = theme.border;
      ctx.strokeRect(ox - 0.5, oy - 0.5, W * s + 1, H * s + 1);
      if (guides.x || guides.y) {
        ctx.strokeStyle = theme.ring;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        if (guides.x) {
          ctx.moveTo(ox + (W / 2) * s, oy);
          ctx.lineTo(ox + (W / 2) * s, oy + H * s);
        }
        if (guides.y) {
          ctx.moveTo(ox, oy + (H / 2) * s);
          ctx.lineTo(ox + W * s, oy + (H / 2) * s);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const sel = selectedLayer();
      if (sel && sel.visible) {
        const box = layerBox(sel);
        const corners = CORNERS.map(([kx, ky]) =>
          toScreen(localToArt(sel, (kx * box.w) / 2, (ky * box.h) / 2)),
        );
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = theme.ring;
        ctx.beginPath();
        corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.stroke();
        if (!sel.locked) {
          const topMid = toScreen(localToArt(sel, 0, -box.h / 2));
          const rot = handleScreen(sel, box, ROT_HANDLE);
          ctx.beginPath();
          ctx.moveTo(topMid.x, topMid.y);
          ctx.lineTo(rot.x, rot.y);
          ctx.stroke();
          ctx.fillStyle = theme.bg;
          for (const h of HANDLES) {
            const p = handleScreen(sel, box, h);
            ctx.beginPath();
            if (h.rot) ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            else ctx.rect(p.x - 4, p.y - 4, 8, 8);
            ctx.fill();
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    function updateView() {
      const cw = stage.clientWidth;
      const ch = stage.clientHeight;
      const pad = 28;
      const s = Math.max(
        0.01,
        Math.min((cw - pad * 2) / scene.width, (ch - pad * 2) / scene.height),
      );
      view = {
        s,
        ox: Math.round((cw - scene.width * s) / 2),
        oy: Math.round((ch - scene.height * s) / 2),
        cw,
        ch,
      };
      return view;
    }

    function render() {
      if (destroyed) return;
      theme = readTheme();
      const dpr = window.devicePixelRatio || 1;
      updateView();
      const { cw, ch, s, ox, oy } = view;
      const pw = Math.max(1, Math.round(cw * dpr));
      const ph = Math.max(1, Math.round(ch * dpr));
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      hint.hidden = scene.layers.length > 0;
      drawBackdrop(ctx);
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, scene.width * s, scene.height * s);
      ctx.clip();
      ctx.translate(ox, oy);
      ctx.scale(s, s);
      if (scene.background) {
        ctx.fillStyle = resolveCss(scene.background);
        ctx.fillRect(0, 0, scene.width, scene.height);
      }
      for (const layer of scene.layers) drawLayer(ctx, layer, "preview");
      ctx.restore();
      drawOverlay(ctx);
    }

    function commitNew(layer) {
      if (findLayer(layer.id)) fail(`duplicate layer id "${layer.id}"`);
      edit(undefined, (s) => s.layers.push(layer));
      setSelected(layer.id);
      return layer.id;
    }

    async function addImage(source, props = {}) {
      if (typeof source !== "string" && !(source instanceof Blob))
        fail("addImage: source must be a Blob or a URL string");
      if (!props || typeof props !== "object") fail("addImage: props must be an object");
      const { fit, ...rest } = props;
      const ratio = fit ?? fitRatio;
      if (!isNum(ratio) || ratio <= 0 || ratio > 1)
        fail(`addImage: fit must be a number in (0, 1] (got ${fit})`);
      const layer = normalizeLayer({ ...rest, type: "image", src: source });
      const rec = ensureImage(layer.src);
      await rec.promise;
      if (destroyed) fail("addImage: instance was destroyed while the image loaded");
      sizeImage(layer, rec, ratio);
      return commitNew(layer);
    }

    function addText(text, props = {}) {
      if (typeof text !== "string") fail("addText: text must be a string");
      return commitNew(normalizeLayer({ ...props, type: "text", text }));
    }

    function addShape(kind, props = {}) {
      if (!SHAPE_KINDS.includes(kind))
        fail(`addShape: kind must be 'rect' or 'ellipse' (got ${JSON.stringify(kind)})`);
      return commitNew(normalizeLayer({ ...props, type: "shape", kind }));
    }

    function patchLayer(id, patch, label) {
      const idx = findIndex(id);
      if (idx < 0) fail(`update: no layer with id "${id}"`);
      const next = normalizeLayer(patch, scene.layers[idx]);
      edit(label, (s) => {
        s.layers[idx] = next;
      });
      const rec = next.type === "image" ? ensureImage(next.src) : null;
      if (rec && rec.ready && sizeImage(scene.layers[idx], rec, fitRatio)) syncChrome();
    }

    function remove(id) {
      const idx = findIndex(id);
      if (idx < 0) fail(`remove: no layer with id "${id}"`);
      edit(undefined, (s) => s.layers.splice(idx, 1));
      if (selectedId === id) setSelected(null);
    }

    function duplicate(id) {
      const idx = findIndex(id);
      if (idx < 0) fail(`duplicate: no layer with id "${id}"`);
      const copy = clone(scene.layers[idx]);
      copy.id = uid();
      copy.name = `${copy.name} copy`;
      copy.x += scene.width * 0.02;
      copy.y += scene.width * 0.02;
      edit(undefined, (s) => s.layers.splice(idx + 1, 0, copy));
      setSelected(copy.id);
      return copy.id;
    }

    function reorder(id, to) {
      const from = findIndex(id);
      if (from < 0) fail(`reorder: no layer with id "${id}"`);
      const last = scene.layers.length - 1;
      const named = { up: from + 1, down: from - 1, front: last, back: 0 };
      let index;
      if (typeof to === "string" && to in named) index = named[to];
      else if (isNum(to)) index = Math.round(to);
      else
        fail(
          `reorder: to must be an index or 'up' | 'down' | 'front' | 'back' (got ${JSON.stringify(to)})`,
        );
      index = clamp(index, 0, last);
      if (from === index) return;
      edit(undefined, (s) => {
        const [item] = s.layers.splice(from, 1);
        s.layers.splice(index, 0, item);
      });
    }

    function setScene(partial) {
      scene = normalizeScene(partial);
      history.length = 0;
      future.length = 0;
      lastLabel = "";
      ensureSceneImages();
      if (selectedId && !findLayer(selectedId)) {
        selectedId = null;
        emitSelect();
      }
      scheduleRender();
      syncChrome();
    }

    function get() {
      return clone(scene);
    }

    async function exportBlob(opts = {}) {
      const type = opts.type ?? "image/png";
      if (!EXPORT_TYPES.includes(type))
        fail(`exportBlob: type must be one of ${EXPORT_TYPES.join(", ")} (got ${type})`);
      const quality = opts.quality ?? 0.92;
      const scale = opts.scale ?? 1;
      if (!isNum(quality) || quality < 0 || quality > 1) fail("exportBlob: quality must be 0..1");
      if (!isNum(scale) || scale <= 0) fail("exportBlob: scale must be a positive number");
      const frame = clone(scene);
      const outW = Math.round(frame.width * scale);
      const outH = Math.round(frame.height * scale);
      if (outW < 1 || outH < 1 || outW > MAX_SIDE || outH > MAX_SIDE) {
        fail(`exportBlob: output ${outW} x ${outH} is outside 1..${MAX_SIDE} px per side`);
      }
      const recs = await Promise.all(
        frame.layers.filter((l) => l.type === "image").map((l) => ensureImage(l.src).promise),
      );
      for (const l of frame.layers)
        if (l.type === "image") sizeImage(l, imageCache.get(l.src), fitRatio);
      if (recs.length) await Promise.all(recs.map((r) => r.img.decode()));
      const out = document.createElement("canvas");
      out.width = outW;
      out.height = outH;
      const ctx = out.getContext("2d");
      if (frame.background) {
        ctx.fillStyle = resolveCss(frame.background);
        ctx.fillRect(0, 0, outW, outH);
      } else if (type === "image/jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, outW, outH);
      }
      ctx.setTransform(outW / frame.width, 0, 0, outH / frame.height, 0, 0);
      theme = readTheme();
      for (const layer of frame.layers) drawLayer(ctx, layer, "export");
      const blob = await new Promise((resolve) => out.toBlob(resolve, type, quality));
      out.width = 0;
      out.height = 0;
      if (!blob) fail("exportBlob: encoding failed");
      return blob;
    }

    function on(event, cb) {
      if (!listeners.has(event)) fail(`on: unknown event "${event}". Use 'change' or 'select'`);
      if (typeof cb !== "function") fail("on: callback must be a function");
      listeners.get(event).add(cb);
      return () => listeners.get(event).delete(cb);
    }

    function commitField(f, raw) {
      const layer = selectedLayer();
      if (!layer) return;
      const patch = f.spec.patch(raw);
      if (patch) patchLayer(layer.id, patch, `inspect:${layer.id}:${f.spec.key}`);
    }

    function buildField(spec) {
      const row = el("div", "t3k-layers-field");
      const label = el("label", "t3k-layers-field-label", spec.label);
      row.append(label);
      const f = { spec, control: null, check: null, out: null, row };
      const commit = user((raw) => commitField(f, raw));
      if (spec.kind === "color") {
        const wrap = el("span", "t3k-layers-color");
        const swatch = document.createElement("input");
        swatch.type = "color";
        wrap.append(swatch);
        f.control = swatch;
        swatch.addEventListener("input", () => commit(swatch.value), opt);
        if (spec.nullLabel) {
          const check = document.createElement("input");
          check.type = "checkbox";
          check.setAttribute("aria-label", `${spec.label}: ${spec.nullLabel}`);
          const toggle = el("label", "t3k-layers-check");
          toggle.append(check, document.createTextNode(spec.nullLabel));
          wrap.append(toggle);
          f.check = check;
          check.addEventListener(
            "change",
            () => {
              const layer = selectedLayer();
              if (!layer) return;
              commit(check.checked ? null : cssToHex(`var(${spec.auto})`));
            },
            opt,
          );
        }
        row.append(wrap);
      } else if (spec.kind === "select") {
        const sel = document.createElement("select");
        for (const [value, text] of spec.options) sel.append(new Option(text, value));
        row.append(sel);
        f.control = sel;
        sel.addEventListener("change", () => commit(sel.value), opt);
      } else if (spec.kind === "textarea") {
        const ta = document.createElement("textarea");
        ta.rows = 2;
        row.append(ta);
        f.control = ta;
        ta.addEventListener("input", () => commit(ta.value), opt);
      } else if (spec.kind === "range") {
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step);
        const out = el("output");
        const wrap = el("span", "t3k-layers-range");
        wrap.append(input, out);
        row.append(wrap);
        f.control = input;
        f.out = out;
        input.addEventListener("input", () => commit(input.value), opt);
      } else {
        const input = document.createElement("input");
        input.type = spec.kind === "number" ? "number" : "text";
        if (spec.kind === "number") input.step = "any";
        row.append(input);
        f.control = input;
        input.addEventListener("input", () => commit(input.value), opt);
      }
      const controlId = `t3k-layers-f${uid()}`;
      f.control.id = controlId;
      label.htmlFor = controlId;
      return f;
    }

    function refreshField(f, layer) {
      const { spec } = f;
      const active = document.activeElement === f.control;
      const v = spec.get(layer);
      if (spec.kind === "color") {
        if (f.check) f.check.checked = v === null;
        f.control.disabled = v === null;
        const hex = cssToHex(v ?? `var(${spec.auto})`);
        if (!active && f.control.value !== hex) f.control.value = hex;
        return;
      }
      const str = v === null || v === undefined ? "" : String(v);
      if (!active && f.control.value !== str) f.control.value = str;
      if (f.out) f.out.textContent = str;
    }

    function syncInspector() {
      const layer = selectedLayer();
      const key = layer ? `${layer.id}:${layer.type}:${layer.kind ?? ""}` : "";
      if (key !== inspectorKey) {
        inspectorKey = key;
        insp.textContent = "";
        fields = [];
        if (!layer) {
          insp.append(
            el(
              "p",
              "t3k-layers-note",
              "Select a layer to edit it. Drag on the canvas to move; use the handles to scale and rotate.",
            ),
          );
        } else {
          for (const spec of specsFor(layer)) {
            const f = buildField(spec);
            fields.push(f);
            insp.append(f.row);
          }
        }
      }
      if (layer) for (const f of fields) refreshField(f, layer);
    }

    function iconButton(act, label, pressed, svg) {
      const b = el("button", "t3k-layers-icon");
      b.type = "button";
      b.dataset.act = act;
      b.setAttribute("aria-label", label);
      b.setAttribute("aria-pressed", String(pressed));
      b.title = label;
      b.innerHTML = svg;
      return b;
    }

    function rowFor(layer) {
      const li = el("li", "t3k-layers-row");
      li.dataset.id = layer.id;
      li.draggable = true;
      li.tabIndex = 0;
      li.setAttribute("aria-selected", String(layer.id === selectedId));
      if (!layer.visible) li.classList.add("is-off");
      const eye = iconButton(
        "visible",
        `Show ${layer.name}`,
        layer.visible,
        layer.visible ? ICON.eye : ICON.eyeOff,
      );
      const glyph = el("span", "t3k-layers-glyph");
      glyph.innerHTML = ICON[layer.type === "shape" ? layer.kind : layer.type];
      const name = el("span", "t3k-layers-name", layer.name);
      name.title = layer.name;
      const lock = iconButton(
        "locked",
        `Lock ${layer.name}`,
        layer.locked,
        layer.locked ? ICON.lock : ICON.unlock,
      );
      li.append(eye, glyph, name, lock);
      return li;
    }

    function syncList() {
      const sig = `${scene.layers.map((l) => `${l.id}|${l.name}|${l.visible}|${l.locked}|${l.type}|${l.kind ?? ""}`).join("\n")}#${selectedId}`;
      if (sig === listSignature) return;
      listSignature = sig;
      const focusRow = list.contains(document.activeElement)
        ? document.activeElement.closest("li[data-id]")
        : null;
      const focusId = focusRow ? focusRow.dataset.id : null;
      const focusAct =
        document.activeElement && document.activeElement.dataset
          ? document.activeElement.dataset.act
          : undefined;
      list.textContent = "";
      countEl.textContent = String(scene.layers.length);
      if (!scene.layers.length) {
        list.append(el("li", "t3k-layers-empty", "No layers yet."));
        return;
      }
      for (let i = scene.layers.length - 1; i >= 0; i--) list.append(rowFor(scene.layers[i]));
      if (focusId) {
        const row = list.querySelector(`li[data-id="${CSS.escape(focusId)}"]`);
        const target = row && focusAct ? row.querySelector(`[data-act="${focusAct}"]`) : row;
        if (target) target.focus({ preventScroll: true });
      }
    }

    function syncToolbar() {
      const sel = selectedLayer();
      const idx = sel ? findIndex(sel.id) : -1;
      toolbarBtns.duplicate.disabled = !sel;
      toolbarBtns.remove.disabled = !sel;
      toolbarBtns.forward.disabled = !sel || idx === scene.layers.length - 1;
      toolbarBtns.backward.disabled = !sel || idx === 0;
      toolbarBtns.undo.disabled = !history.length;
      toolbarBtns.redo.disabled = !future.length;
    }

    function syncChrome() {
      if (destroyed) return;
      syncList();
      syncInspector();
      syncToolbar();
    }

    function onToolbarClick(e) {
      const b = e.target.closest("button[data-cmd]");
      if (!b) return;
      const sel = selectedLayer();
      switch (b.dataset.cmd) {
        case "addText":
          addText("Text");
          break;
        case "addRect":
          addShape("rect");
          break;
        case "addEllipse":
          addShape("ellipse");
          break;
        case "forward":
          if (sel) reorder(sel.id, "up");
          break;
        case "backward":
          if (sel) reorder(sel.id, "down");
          break;
        case "duplicate":
          if (sel) duplicate(sel.id);
          break;
        case "remove":
          if (sel) remove(sel.id);
          break;
        case "undo":
          undo();
          break;
        case "redo":
          redo();
          break;
        default:
          fail(`unknown toolbar command ${b.dataset.cmd}`);
      }
    }

    function onListClick(e) {
      const row = e.target.closest("li[data-id]");
      if (!row) return;
      const layer = findLayer(row.dataset.id);
      if (!layer) return;
      const act = e.target.closest("button[data-act]");
      if (act) {
        const key = act.dataset.act;
        patchLayer(layer.id, { [key]: !layer[key] });
        return;
      }
      setSelected(layer.id);
    }

    function onListKeyDown(e) {
      if (e.target.closest("button")) return;
      const row = e.target.closest("li[data-id]");
      if (!row || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      e.stopPropagation();
      setSelected(row.dataset.id);
    }

    function onListDoubleClick(e) {
      if (!e.target.closest(".t3k-layers-name")) return;
      const f = fields.find((x) => x.spec.key === "name");
      if (f) {
        f.control.focus();
        f.control.select();
      }
    }

    function onCanvasDoubleClick() {
      const sel = selectedLayer();
      if (!sel || sel.type !== "text") return;
      const f = fields.find((x) => x.spec.key === "text");
      if (f) f.control.focus();
    }

    function clearDrop() {
      for (const node of list.querySelectorAll(".is-drop-before,.is-drop-after")) {
        node.classList.remove("is-drop-before", "is-drop-after");
      }
    }

    function onDragStart(e) {
      const li = e.target.closest("li[data-id]");
      if (!li) return;
      listDrag = li.dataset.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", listDrag);
    }

    function onDragOver(e) {
      if (!listDrag) return;
      const li = e.target.closest("li[data-id]");
      if (!li) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      clearDrop();
      li.classList.add(e.clientY < r.top + r.height / 2 ? "is-drop-before" : "is-drop-after");
    }

    function onDrop(e) {
      if (!listDrag) return;
      e.preventDefault();
      const li = e.target.closest("li[data-id]");
      if (li && li.dataset.id !== listDrag) {
        const above = li.classList.contains("is-drop-before");
        const from = findIndex(listDrag);
        const targetIdx = findIndex(li.dataset.id);
        const desired = above ? targetIdx + 1 : targetIdx;
        reorder(listDrag, from < desired ? desired - 1 : desired);
      }
      clearDrop();
      listDrag = null;
    }

    function onDragEnd() {
      clearDrop();
      listDrag = null;
    }

    function onKeyDown(e) {
      if (e.target.closest && e.target.closest("input, textarea, select")) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const sel = selectedLayer();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && sel && key === "d") {
        e.preventDefault();
        duplicate(sel.id);
        return;
      }
      if (mod && sel && (e.code === "BracketRight" || e.code === "BracketLeft")) {
        e.preventDefault();
        const up = e.code === "BracketRight";
        reorder(sel.id, e.shiftKey ? (up ? "front" : "back") : up ? "up" : "down");
        return;
      }
      if (key === "Escape") {
        if (sel) setSelected(null);
        return;
      }
      if (!sel || e.target.closest("button")) return;
      if (key === "Delete" || key === "Backspace") {
        e.preventDefault();
        remove(sel.id);
        return;
      }
      const dir = Object.hasOwn(DELTAS, key) ? DELTAS[key] : null;
      if (dir && !sel.locked) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        patchLayer(
          sel.id,
          { x: sel.x + dir[0] * step, y: sel.y + dir[1] * step },
          `nudge:${sel.id}`,
        );
      }
    }

    function updateCursor(p) {
      updateView();
      const sel = selectedLayer();
      let cursor = "default";
      const handle = sel && sel.visible && !sel.locked ? hitHandle(sel, p) : null;
      if (handle) cursor = handle.cursor;
      else if (hitLayer(toArt(p))) cursor = "move";
      if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
    }

    function beginDrag(mode, layer, p, e, handle) {
      const a = toArt(p);
      drag = {
        mode,
        handle,
        id: layer.id,
        pointerId: e.pointerId,
        startX: p.x,
        startY: p.y,
        moved: false,
        pointer: p,
        art: a,
        shift: e.shiftKey,
        alt: e.altKey,
        box: layerBox(layer),
        orig: {
          x: layer.x,
          y: layer.y,
          rotation: layer.rotation,
          scaleX: layer.scaleX,
          scaleY: layer.scaleY,
        },
        startAngle: Math.atan2(a.y - layer.y, a.x - layer.x),
        before: snapshot(),
      };
      canvas.setPointerCapture(e.pointerId);
    }

    function onPointerDown(e) {
      if (e.button !== 0) return;
      updateView();
      const p = localPoint(e);
      canvas.focus({ preventScroll: true });
      const sel = selectedLayer();
      if (sel && sel.visible && !sel.locked) {
        const h = hitHandle(sel, p);
        if (h) {
          beginDrag(h.rot ? "rotate" : "resize", sel, p, e, h);
          return;
        }
      }
      const hit = hitLayer(toArt(p));
      if (hit) {
        setSelected(hit.id);
        beginDrag("move", hit, p, e, null);
      } else if (selectedId !== null) {
        setSelected(null);
      }
    }

    function onPointerMove(e) {
      const p = localPoint(e);
      if (!drag) {
        updateCursor(p);
        return;
      }
      if (e.pointerId !== drag.pointerId) return;
      drag.pointer = p;
      drag.shift = e.shiftKey;
      drag.alt = e.altKey;
      if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) > 2) drag.moved = true;
      if (drag.moved && !dragFrame) {
        dragFrame = requestAnimationFrame(() => {
          dragFrame = 0;
          applyDrag();
        });
      }
    }

    function onPointerEnd(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const d = drag;
      if (dragFrame) {
        cancelAnimationFrame(dragFrame);
        dragFrame = 0;
      }
      if (d.moved) applyDrag();
      drag = null;
      guides.x = false;
      guides.y = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      const didChange = d.moved && snapshot() !== d.before;
      if (didChange) {
        pushHistory(d.before);
        lastLabel = "";
      }
      scheduleRender();
      syncChrome();
      if (didChange) emitChange();
    }

    // Runs inside a frame callback: mutate the dragged layer, then paint immediately.
    function applyDrag() {
      const d = drag;
      if (!d || !d.moved) return;
      const layer = findLayer(d.id);
      if (!layer) return;
      updateView();
      const a = toArt(d.pointer);
      if (d.mode === "move") moveLayer(layer, d, a);
      else if (d.mode === "rotate") rotateLayer(layer, d, a);
      else resizeLayer(layer, d, a);
      render();
      syncChrome();
    }

    function moveLayer(layer, d, a) {
      const snap = SNAP_PX / view.s;
      let x = d.orig.x + (a.x - d.art.x);
      let y = d.orig.y + (a.y - d.art.y);
      guides.x = Math.abs(x - scene.width / 2) <= snap;
      if (guides.x) x = scene.width / 2;
      guides.y = Math.abs(y - scene.height / 2) <= snap;
      if (guides.y) y = scene.height / 2;
      layer.x = x;
      layer.y = y;
    }

    function rotateLayer(layer, d, a) {
      let angle =
        d.orig.rotation +
        ((Math.atan2(a.y - d.orig.y, a.x - d.orig.x) - d.startAngle) * 180) / Math.PI;
      if (d.shift) angle = Math.round(angle / 15) * 15;
      layer.rotation = normalizeAngle(angle);
    }

    function resizeLayer(layer, d, a) {
      const h = d.handle;
      const o = d.orig;
      const box = d.box;
      const r = (o.rotation * Math.PI) / 180;
      const c = Math.cos(r);
      const s = Math.sin(r);
      const dx = a.x - o.x;
      const dy = a.y - o.y;
      const qx = dx * c + dy * s;
      const qy = -dx * s + dy * c;
      const Hx = (box.w / 2) * o.scaleX;
      const Hy = (box.h / 2) * o.scaleY;
      const axisX = h.kx !== 0;
      const axisY = h.ky !== 0;
      const alt = d.alt;
      let hx = Hx;
      let hy = Hy;
      if (axisX) hx = alt ? Math.abs(qx) : (h.kx * qx + Hx) / 2;
      if (axisY) hy = alt ? Math.abs(qy) : (h.ky * qy + Hy) / 2;
      const proportional = layer.type === "text" || (axisX && axisY) || d.shift;
      if (proportional) {
        const ratios = [];
        if (axisX) ratios.push(hx / Hx);
        if (axisY) ratios.push(hy / Hy);
        const k = ratios.reduce(
          (best, v) => (Math.abs(v - 1) > Math.abs(best - 1) ? v : best),
          ratios[0],
        );
        hx = Hx * k;
        hy = Hy * k;
      }
      hx = Math.max(hx, 0.5);
      hy = Math.max(hy, 0.5);
      const cx = alt || !axisX ? 0 : -h.kx * Hx + h.kx * hx;
      const cy = alt || !axisY ? 0 : -h.ky * Hy + h.ky * hy;
      layer.x = o.x + cx * c - cy * s;
      layer.y = o.y + cx * s + cy * c;
      layer.scaleX = clamp(hx / (box.w / 2), MIN_SCALE, 100);
      layer.scaleY = clamp(hy / (box.h / 2), MIN_SCALE, 100);
      if (layer.type === "text") layer.scaleY = layer.scaleX;
    }

    const resizeObserver = new ResizeObserver(() => {
      root.dataset.wide = root.clientWidth >= 620 ? "1" : "0";
      scheduleRender();
    });
    resizeObserver.observe(root);
    resizeObserver.observe(stage);
    const themeObserver = new MutationObserver(() => {
      inspectorKey = null;
      scheduleRender();
      syncChrome();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme"],
    });
    const themeNode = document.getElementById("t3-theme");
    if (themeNode)
      themeObserver.observe(themeNode, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", () => scheduleRender(), opt);

    canvas.addEventListener("pointerdown", onPointerDown, opt);
    canvas.addEventListener("pointermove", onPointerMove, opt);
    canvas.addEventListener("pointerup", user(onPointerEnd), opt);
    canvas.addEventListener("pointercancel", user(onPointerEnd), opt);
    canvas.addEventListener("dblclick", onCanvasDoubleClick, opt);
    root.addEventListener("keydown", user(onKeyDown), opt);
    toolbar.addEventListener("click", user(onToolbarClick), opt);
    list.addEventListener("click", user(onListClick), opt);
    list.addEventListener("keydown", onListKeyDown, opt);
    list.addEventListener("dblclick", onListDoubleClick, opt);
    list.addEventListener("dragstart", onDragStart, opt);
    list.addEventListener("dragover", onDragOver, opt);
    list.addEventListener("drop", user(onDrop), opt);
    list.addEventListener("dragend", onDragEnd, opt);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      if (renderFrame) cancelAnimationFrame(renderFrame);
      if (dragFrame) cancelAnimationFrame(dragFrame);
      for (const u of ownedUrls) URL.revokeObjectURL(u);
      imageCache.clear();
      listeners.get("change").clear();
      listeners.get("select").clear();
      drag = null;
      root.remove();
    }

    setScene(sceneOptions);

    return {
      get,
      set: setScene,
      addImage,
      addText,
      addShape,
      update: (id, patch) => patchLayer(id, patch),
      remove,
      duplicate,
      reorder,
      select: setSelected,
      selected: () => selectedId,
      undo,
      redo,
      canUndo: () => history.length > 0,
      canRedo: () => future.length > 0,
      exportBlob,
      on,
      destroy,
    };
  }

  t3kit.layers = { create };
})();
