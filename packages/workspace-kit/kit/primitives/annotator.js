/**
 * t3kit.annotator: design-review layer over an image, a canvas or a web page. Pin comments, boxes, ellipses,
 * arrows, freehand and an element picker (pages: hover box + tag/classes/size chip, click to pick). Numbered
 * markers, an editable change list (note, resolve, reorder, delete), undo/redo, keys, agent export, PNG crops.
 *
 * create(container, options?) → instance. Fills `container` and follows its size.
 *   options.value: { annotations }. options.tool = 'select' (not 'element': no page yet). options.list = true.
 *   options.screenshot({ x, y, width, height }) → Promise<Blob | canvas | ImageBitmap>: that region of the page
 *     in page CSS px. Needed only by cropImage() on a page target (a DOM page cannot be rasterised here).
 * Targets (one at a time; each resolves { width, height } and emits 'load'):
 *   setImage(Blob | url | img | canvas | ImageBitmap)   coordinates = source pixels. Shows a downscaled
 *     preview; crops read full resolution. Call again after redrawing a canvas.
 *   setPage(html | Document | Element | same-origin iframe, { viewport = { width: 1280, height: 800 } })
 *     Renders a static snapshot in a shadow root (works in the opaque-origin sandbox, where iframes are
 *     unreadable), scaled to fit. Coordinates = page CSS px from the document top; marks follow scrolling.
 *     Scripts do not run; media queries and vw/vh follow the workspace window; :root rules map to html.
 * get() → { annotations: [{ id, kind, rect?, points?, note, element?, status }] }
 *   kind: pin (points[1]) | arrow (points[2]) | freehand (points[2+]) | rect | ellipse | element (rect).
 *   rect { x, y, width, height }, points [{ x, y }] in target coordinates. status: 'open' | 'resolved'.
 *   element { selector, tag, id, classes, text, box, styles } captured at pick time (styles: computed).
 * set({ annotations }) validates, replaces, clears undo; never emits. addElement(selector, { note }) → copy.
 * setTool(name) · getTool()   select | pin | rect | ellipse | arrow | freehand | element (pages only)
 * select(id | null) · move(id, toIndex) · remove(id) · undo() · redo() · refresh() (re-find picked elements)
 * exportChangeList({ onlyOpen }) → { json: { target, counts, annotations[+number, bounds] }, markdown }
 * cropImage(annotation | id, { pad = 12, pinSize = 0.2 }) → Promise<Blob> PNG; pinSize × target width square.
 * on('change' | 'select' | 'load', cb) → unsubscribe   change: user edits, payload get(); select: id | null.
 * destroy()
 * Keys (focus the annotator): V select · P pin · R box · O ellipse · A arrow · F freehand · E element ·
 *   Esc cancel/back · Del remove · X resolve · Up/Down step · Alt+Up/Down reorder · ⌘Z / ⇧⌘Z undo/redo.
 *   Element tool: Up picks the parent, Down goes back, Enter picks. Wheel scrolls a page.
 *
 * @example
 *   const a = t3kit.annotator.create(el, { screenshot: (r) => host.capture(r) });
 *   await a.setPage(html, { viewport: { width: 1280, height: 800 } });
 *   a.setTool('element');
 *   a.on('change', () => send(a.exportChangeList({ onlyOpen: true }).markdown));
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});
  const NAME = "annotator";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const TOOLS = ["select", "pin", "rect", "ellipse", "arrow", "freehand", "element"];
  const KINDS = ["pin", "rect", "ellipse", "arrow", "freehand", "element"];
  const TOOL_LABEL = {
    select: "Select",
    pin: "Pin",
    rect: "Box",
    ellipse: "Ellipse",
    arrow: "Arrow",
    freehand: "Draw",
    element: "Element",
  };
  const TOOL_KEY = {
    select: "V",
    pin: "P",
    rect: "R",
    ellipse: "O",
    arrow: "A",
    freehand: "F",
    element: "E",
  };
  const TOOL_FOR_KEY = {
    v: "select",
    p: "pin",
    r: "rect",
    o: "ellipse",
    a: "arrow",
    f: "freehand",
    e: "element",
  };
  const KIND_LABEL = {
    pin: "Pin comment",
    rect: "Box",
    ellipse: "Ellipse",
    arrow: "Arrow",
    freehand: "Freehand",
    element: "Element",
  };
  const SHAPE_TAG = {
    pin: "circle",
    rect: "rect",
    element: "rect",
    ellipse: "ellipse",
    arrow: "path",
    freehand: "polyline",
  };
  const STYLE_PROPS = [
    "display",
    "position",
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
    "text-align",
    "padding",
    "margin",
    "border",
    "border-radius",
    "gap",
    "opacity",
  ];
  const MD_STYLES = [
    "font-size",
    "font-weight",
    "line-height",
    "color",
    "background-color",
    "padding",
    "border-radius",
  ];
  const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
  const PAD = 16; // px between the view edge and the target
  const MIN_DRAG = 4; // px on screen; smaller drafts count as clicks
  const STROKE_STEP = 3; // px on screen between kept freehand samples
  const HISTORY_LIMIT = 100;
  const PREVIEW_MAX = 2048; // px; longest edge of the downscaled display copy of an image
  const STYLE_TEXT = `
.t3k-annotator-root{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;font:12px/1.4 var(--font-sans);color:var(--foreground);outline:none}
.t3k-annotator-root:focus-visible{box-shadow:0 0 0 2px var(--ring);border-radius:var(--radius)}
.t3k-annotator-root [hidden]{display:none!important}
.t3k-annotator-bar{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.t3k-annotator-tool,.t3k-annotator-action{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);background:var(--card);color:var(--muted-foreground);font:inherit;cursor:pointer;white-space:nowrap}
.t3k-annotator-tool:hover,.t3k-annotator-action:hover,.t3k-annotator-row button:hover,.t3k-annotator-filter:hover{color:var(--foreground)}
.t3k-annotator-tool[aria-pressed="true"]{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}
.t3k-annotator-tool:disabled,.t3k-annotator-action:disabled,.t3k-annotator-row button:disabled{opacity:.4;cursor:default}
.t3k-annotator-tool kbd,.t3k-annotator-action kbd{font:500 10px/1 var(--font-mono);opacity:.7}
.t3k-annotator-sep{width:1px;height:18px;margin:0 4px;background:var(--border)}
.t3k-annotator-main{display:flex;flex:1 1 auto;gap:12px;min-width:0;min-height:0}
.t3k-annotator-root[data-narrow="true"] .t3k-annotator-main{flex-direction:column}
.t3k-annotator-root[data-narrow="true"] .t3k-annotator-tool kbd,.t3k-annotator-root[data-narrow="true"] .t3k-annotator-action kbd{display:none}
.t3k-annotator-root[data-narrow="true"] .t3k-annotator-list{flex:0 1 42%;min-width:0}
.t3k-annotator-view{position:relative;flex:1 1 0;min-width:0;min-height:200px;overflow:hidden;border:1px solid var(--border);border-radius:var(--radius);background:var(--muted)}
.t3k-annotator-target,.t3k-annotator-svg,.t3k-annotator-markers,.t3k-annotator-stage{position:absolute}
.t3k-annotator-target{display:block;border:0}
.t3k-annotator-page{all:initial;position:absolute;display:block;overflow:auto;scrollbar-width:thin;transform-origin:0 0;color-scheme:light;background:Canvas;color:CanvasText;box-shadow:0 0 0 1px var(--border)}
.t3k-annotator-svg{overflow:visible;pointer-events:none}
.t3k-annotator-markers{pointer-events:none}
.t3k-annotator-view[data-kind="page"] .t3k-annotator-svg,.t3k-annotator-view[data-kind="page"] .t3k-annotator-markers{clip-path:inset(0)}
.t3k-annotator-stage{touch-action:none;cursor:crosshair}
.t3k-annotator-stage[data-tool="select"]{cursor:default}
.t3k-annotator-stage[data-tool="element"]{cursor:pointer}
.t3k-annotator-empty{position:absolute;inset:0;margin:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;color:var(--muted-foreground)}
.t3k-annotator-shape{fill:none;stroke:var(--primary);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.t3k-annotator-fill{fill:color-mix(in srgb,var(--primary) 12%,transparent)}
.t3k-annotator-kind-element{stroke:var(--chart-2);stroke-dasharray:5 3}
.t3k-annotator-kind-element.t3k-annotator-fill{fill:color-mix(in srgb,var(--chart-2) 10%,transparent)}
.t3k-annotator-dot{fill:var(--background);stroke:var(--primary);stroke-width:2}
.t3k-annotator-resolved{stroke:var(--success)}
.t3k-annotator-resolved.t3k-annotator-fill{fill:color-mix(in srgb,var(--success) 10%,transparent)}
.t3k-annotator-missing{stroke:var(--destructive)}
.t3k-annotator-sel{stroke-width:3.5}
.t3k-annotator-hover{fill:color-mix(in srgb,var(--info) 14%,transparent);stroke:var(--info);stroke-width:1.5;pointer-events:none}
.t3k-annotator-chip{position:absolute;padding:2px 6px;border:1px solid var(--border);border-radius:calc(var(--radius) - 4px);background:var(--popover);color:var(--foreground);font:500 11px/1.4 var(--font-mono);white-space:nowrap;max-width:80%;overflow:hidden;text-overflow:ellipsis}
.t3k-annotator-chip span{color:var(--muted-foreground)}
.t3k-annotator-marker{position:absolute;box-sizing:border-box;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:var(--primary);color:var(--primary-foreground);font:600 11px/20px var(--font-sans);text-align:center;white-space:nowrap;transform:translate(-50%,-50%);box-shadow:0 0 0 2px var(--background)}
.t3k-annotator-marker.t3k-annotator-resolved{background:var(--success)}
.t3k-annotator-marker.t3k-annotator-missing{background:var(--destructive)}
.t3k-annotator-marker.t3k-annotator-sel{outline:2px solid var(--ring);outline-offset:2px}
.t3k-annotator-list{display:flex;flex:0 0 270px;flex-direction:column;gap:8px;min-width:0;min-height:0}
.t3k-annotator-list-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.t3k-annotator-list-head h3{margin:0;font-size:12px;font-weight:600}
.t3k-annotator-count{font-size:11px;font-weight:400;color:var(--muted-foreground);margin-left:6px}
.t3k-annotator-filter{appearance:none;height:22px;padding:0 8px;border:1px solid var(--border);border-radius:calc(var(--radius) - 4px);background:transparent;color:var(--muted-foreground);font:inherit;font-size:11px;cursor:pointer}
.t3k-annotator-filter[aria-pressed="true"]{color:var(--foreground);background:var(--accent)}
.t3k-annotator-items{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;min-height:0;overflow:auto}
.t3k-annotator-item{display:flex;gap:8px;padding:8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);color:var(--card-foreground);cursor:pointer}
.t3k-annotator-item[aria-selected="true"]{border-color:var(--ring)}
.t3k-annotator-item-body{display:flex;flex:1 1 auto;flex-direction:column;gap:6px;min-width:0}
.t3k-annotator-badge{flex:0 0 auto;min-width:20px;height:20px;padding:0 5px;box-sizing:border-box;border-radius:999px;background:var(--primary);color:var(--primary-foreground);font:600 11px/20px var(--font-sans);text-align:center}
.t3k-annotator-item[data-status="resolved"] .t3k-annotator-badge{background:var(--success)}
.t3k-annotator-item[data-missing="true"] .t3k-annotator-badge{background:var(--destructive)}
.t3k-annotator-item-meta{font-size:11px;color:var(--muted-foreground)}
.t3k-annotator-warn{font-size:11px;color:var(--destructive)}
.t3k-annotator-selector{font:10px/1.4 var(--font-mono);color:var(--muted-foreground);overflow-wrap:anywhere}
.t3k-annotator-note{box-sizing:border-box;width:100%;min-height:44px;padding:5px 8px;border:1px solid var(--input);border-radius:calc(var(--radius) - 2px);background:var(--background);color:var(--foreground);font:inherit;resize:vertical}
.t3k-annotator-note:focus{outline:none;border-color:var(--ring)}
.t3k-annotator-item[data-status="resolved"] .t3k-annotator-note{opacity:.6}
.t3k-annotator-row{display:flex;flex-wrap:wrap;gap:4px}
.t3k-annotator-row button{appearance:none;height:24px;padding:0 8px;border:1px solid var(--border);border-radius:calc(var(--radius) - 4px);background:transparent;color:var(--muted-foreground);font:inherit;font-size:11px;cursor:pointer}
.t3k-annotator-row button[aria-pressed="true"]{color:var(--success)}
.t3k-annotator-hint{font-size:11px;color:var(--muted-foreground);list-style:none;padding:4px 2px}
`;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const r1 = (v) => Math.round(v * 10) / 10;
  const f2 = (v) => Math.round(v * 100) / 100;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
  const TRANSPARENT = "rgba(0, 0, 0, 0)";
  const EMPTY_STYLE = new Set([TRANSPARENT, "0px", "normal", "none", ""]);

  function injectStyle() {
    if (document.querySelector(`style[data-t3kit="${NAME}"]`)) return;
    const style = document.createElement("style");
    style.setAttribute("data-t3kit", NAME);
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svgNode(tag) {
    return document.createElementNS(SVG_NS, tag);
  }

  // Writes only attributes that changed, so an unchanged frame touches no DOM.
  function setAttrs(node, attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      const text = String(value);
      if (node.getAttribute(key) !== text) node.setAttribute(key, text);
    }
  }

  function segmentDistance(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function distanceToPath(p, points) {
    if (points.length === 1) return dist(p, points[0]);
    let best = Infinity;
    for (let i = 1; i < points.length; i++)
      best = Math.min(best, segmentDistance(p, points[i - 1], points[i]));
    return best;
  }

  function arrowPath(p, q) {
    const angle = Math.atan2(q.y - p.y, q.x - p.x);
    const head = 12;
    const spread = 0.45;
    const h1 = {
      x: q.x - head * Math.cos(angle - spread),
      y: q.y - head * Math.sin(angle - spread),
    };
    const h2 = {
      x: q.x - head * Math.cos(angle + spread),
      y: q.y - head * Math.sin(angle + spread),
    };
    return `M${f2(p.x)} ${f2(p.y)}L${f2(q.x)} ${f2(q.y)}M${f2(h1.x)} ${f2(h1.y)}L${f2(q.x)} ${f2(q.y)}L${f2(h2.x)} ${f2(h2.y)}`;
  }

  const SAFE_IDENT = /^-?[A-Za-z_][\w-]*$/;

  // One selector step: tag plus up to two plain class names, with :nth-of-type when siblings still collide.
  function stepFor(node) {
    const tag = node.localName;
    const classes = [...node.classList].filter((c) => SAFE_IDENT.test(c)).slice(0, 2);
    let step = tag + classes.map((c) => `.${c}`).join("");
    const parent = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.matches(step));
      if (same.length > 1) {
        const ofType = [...parent.children].filter((c) => c.localName === tag);
        step += `:nth-of-type(${ofType.indexOf(node) + 1})`;
      }
    }
    return step;
  }

  // Shortest stable selector inside `scope` (a shadow root or document): a unique id, else steps upward
  // until the chain matches exactly one element.
  function selectorFor(node, scope) {
    const steps = [];
    for (let cur = node; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.id && SAFE_IDENT.test(cur.id) && scope.querySelectorAll(`#${cur.id}`).length === 1) {
        steps.unshift(`#${cur.id}`);
        return steps.join(" > ");
      }
      steps.unshift(stepFor(cur));
      const sel = steps.join(" > ");
      if (scope.querySelectorAll(sel).length === 1 && scope.querySelector(sel) === node) return sel;
    }
    return steps.join(" > ");
  }

  function canvasToPng(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
        "image/png",
      );
    });
  }

  // Copies one region of the full-resolution source into a new canvas. A Blob is decoded for that region only.
  async function cropSource(source, sx, sy, sw, sh) {
    const out = el("canvas");
    out.width = sw;
    out.height = sh;
    const g = out.getContext("2d");
    if (source instanceof Blob) {
      const bitmap = await createImageBitmap(source, sx, sy, sw, sh);
      g.drawImage(bitmap, 0, 0);
      bitmap.close();
    } else {
      g.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    }
    return out;
  }

  function boundsOf(rect, points) {
    if (rect) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const q of points) {
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x);
      y1 = Math.max(y1, q.y);
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  const roundBox = (b) => ({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  });

  function toMarkdown(json) {
    const { kind, width, height } = json.target;
    const what =
      kind === "page"
        ? `web page, ${width} × ${height} px viewport`
        : `${kind}, ${width} × ${height} px`;
    const lines = [
      "# Change List",
      "",
      `Target: ${what}. ${json.counts.open} open, ${json.counts.resolved} resolved.`,
    ];
    lines.push(
      "Coordinates are target px from the top-left" + (kind === "page" ? " of the document." : "."),
      "",
    );
    for (const r of json.annotations) {
      const label = r.element
        ? `${KIND_LABEL[r.kind]} \`${r.element.tag}${r.element.classes.length ? "." + r.element.classes.join(".") : ""}\``
        : KIND_LABEL[r.kind];
      lines.push(`${r.number}. **${label}** (${r.status}): ${r.note.trim() || "No note yet"}`);
      if (r.element) {
        lines.push(`   - Selector: \`${r.element.selector}\``);
        if (r.element.text) lines.push(`   - Text: "${r.element.text}"`);
        lines.push(
          `   - Box: ${r.bounds.x}, ${r.bounds.y}, ${r.bounds.width} × ${r.bounds.height} px`,
        );
        const styles = MD_STYLES.filter(
          (p) => r.element.styles[p] !== undefined && !EMPTY_STYLE.has(r.element.styles[p]),
        ).map((p) => `${p}: ${r.element.styles[p]}`);
        if (styles.length > 0) lines.push(`   - Styles: ${styles.join("; ")}`);
      } else if (r.kind === "pin") {
        lines.push(`   - At: ${r.bounds.x}, ${r.bounds.y} px`);
      } else if (r.kind === "arrow") {
        const [p, q] = r.points;
        lines.push(
          `   - From ${Math.round(p.x)}, ${Math.round(p.y)} to ${Math.round(q.x)}, ${Math.round(q.y)} px`,
        );
      } else {
        lines.push(
          `   - Region: ${r.bounds.x}, ${r.bounds.y}, ${r.bounds.width} × ${r.bounds.height} px`,
        );
      }
    }
    if (json.annotations.length === 0) lines.push("No annotations.");
    return `${lines.join("\n")}\n`;
  }

  // ---- page snapshots -----------------------------------------------------------------------------------
  // A page is rebuilt inside a shadow root: html > body with the source's attributes, its stylesheets first.
  function pageSource(source) {
    if (typeof source === "string")
      return { doc: new DOMParser().parseFromString(source, "text/html") };
    if (source instanceof HTMLIFrameElement) {
      if (!source.contentDocument) {
        throw new Error(
          "setPage: the iframe is not readable (cross-origin, or inside an opaque-origin sandbox, where every iframe is). Pass the page HTML instead.",
        );
      }
      return { doc: source.contentDocument };
    }
    if (source instanceof Document) return { doc: source };
    if (source instanceof Element) return { element: source };
    throw new TypeError(
      "setPage needs an HTML string, a Document, an Element or a same-origin iframe",
    );
  }

  function cleanClone(node) {
    const copy = document.importNode(node, true);
    if (copy.nodeType === 1) {
      if (copy.localName === "script") return null;
      for (const s of copy.querySelectorAll("script")) s.remove();
    }
    return copy;
  }

  function styleClone(node) {
    if (node.localName === "style") {
      const style = document.createElement("style");
      style.textContent = node.textContent.replace(/:root\b/g, "html");
      return style;
    }
    return document.importNode(node, false);
  }

  function copyAttrs(from, to) {
    for (const attr of from.attributes) to.setAttribute(attr.name, attr.value);
  }

  function buildPage(shadow, source) {
    const { doc, element } = pageSource(source);
    const html = document.createElement("html");
    const body = document.createElement("body");
    let sheets;
    if (doc) {
      sheets = [...doc.head.querySelectorAll('style, link[rel~="stylesheet"]')];
      copyAttrs(doc.documentElement, html);
      copyAttrs(doc.body, body);
      for (const child of doc.body.childNodes) {
        const copy = cleanClone(child);
        if (copy) body.appendChild(copy);
      }
    } else {
      sheets = [...document.querySelectorAll('style:not([data-t3kit]), link[rel~="stylesheet"]')];
      body.style.margin = "0";
      body.appendChild(cleanClone(element));
    }
    const styleNodes = sheets.map(styleClone);
    html.appendChild(body);
    shadow.replaceChildren(...styleNodes, html);
    const links = styleNodes.filter((n) => n.localName === "link");
    const loaded = links.map(
      (link) =>
        new Promise((resolve, reject) => {
          link.addEventListener("load", resolve, { once: true });
          link.addEventListener(
            "error",
            () => reject(new Error(`setPage: stylesheet failed to load: ${link.href}`)),
            { once: true },
          );
        }),
    );
    return { html, body, loaded: Promise.all(loaded) };
  }

  function build(container, options) {
    const screenshot = options.screenshot;
    let annotations = [];
    let counter = 0;
    let selectedId = null;
    let tool = "select";
    let target = null; // { kind: 'image' | 'canvas' | 'page', size, full?, display, shadow?, html? }
    let box = { x: 0, y: 0, width: 0, height: 0 };
    let scale = 1;
    let draft = null; // { kind, start, cur, points, node } in view px
    let drag = null; // { id, start, orig, before, moved }
    let hover = null; // page element under the picker
    let hoverTrail = []; // children left behind by Up in the picker, for Down
    let lastClient = null; // last pointer position over the stage
    let pendingPoints = []; // client-space pointer samples waiting for the next frame
    let frameQueued = false;
    let dirtyAnnotations = false;
    let dirtyDraft = false;
    let dirtyHover = false;
    let dirtyAnchors = false;
    let recheckHover = false;
    let focusNoteId = null;
    let noteBefore = null; // snapshot before the note edit in progress (one undo step per edit)
    let noteEditId = null;
    let hideResolved = false;
    let destroyed = false;
    let history = [];
    let future = [];
    const live = new Map(); // element annotation id -> current rect of its element in the page
    const missing = new Set(); // element annotation ids whose selector matches nothing now
    const nodes = new Map(); // annotation id -> { kind, shape, marker }
    const items = new Map(); // annotation id -> <li>
    const listeners = { change: new Set(), select: new Set(), load: new Set() };

    const root = el("div", "t3k-annotator-root");
    root.tabIndex = 0;
    root.setAttribute("aria-label", "Annotator");
    root.innerHTML = `
      <div class="t3k-annotator-bar" role="toolbar" aria-label="Annotation tools"></div>
      <div class="t3k-annotator-main">
        <div class="t3k-annotator-view"></div>
        <section class="t3k-annotator-list" aria-label="Change list">
          <div class="t3k-annotator-list-head"><h3>Changes<span class="t3k-annotator-count"></span></h3>
            <button type="button" class="t3k-annotator-filter" aria-pressed="false">Hide resolved</button></div>
          <ol class="t3k-annotator-items"></ol>
        </section>
      </div>`;
    const bar = root.querySelector(".t3k-annotator-bar");
    const view = root.querySelector(".t3k-annotator-view");
    const listSection = root.querySelector(".t3k-annotator-list");
    const list = root.querySelector(".t3k-annotator-items");
    const countLabel = root.querySelector(".t3k-annotator-count");
    const filterButton = root.querySelector(".t3k-annotator-filter");
    listSection.hidden = options.list === false;

    const empty = el("p", "t3k-annotator-empty", "Load an image, a canvas or a page to annotate.");
    const svg = svgNode("svg");
    svg.setAttribute("class", "t3k-annotator-svg");
    const hoverNode = svgNode("rect");
    hoverNode.setAttribute("class", "t3k-annotator-hover");
    hoverNode.style.display = "none";
    svg.appendChild(hoverNode);
    const markers = el("div", "t3k-annotator-markers");
    const chip = el("div", "t3k-annotator-chip");
    chip.hidden = true;
    markers.appendChild(chip);
    const stage = el("div", "t3k-annotator-stage");
    view.append(empty, svg, markers, stage);
    container.appendChild(root);

    const toolButtons = new Map();
    for (const name of TOOLS) {
      const button = el("button", "t3k-annotator-tool");
      button.type = "button";
      button.title = `${TOOL_LABEL[name]} (${TOOL_KEY[name]})`;
      button.append(`${TOOL_LABEL[name]} `, el("kbd", null, TOOL_KEY[name]));
      button.addEventListener("click", () => setTool(name));
      toolButtons.set(name, button);
      bar.appendChild(button);
    }
    bar.appendChild(el("span", "t3k-annotator-sep"));
    function barAction(label, key, onClick) {
      const button = el("button", "t3k-annotator-action");
      button.type = "button";
      button.append(`${label} `, el("kbd", null, key));
      button.addEventListener("click", onClick);
      bar.appendChild(button);
      return button;
    }
    const undoButton = barAction("Undo", "⌘Z", () => undo());
    const redoButton = barAction("Redo", "⇧⌘Z", () => redo());
    const deleteButton = barAction("Delete", "Del", () => remove(selectedId));
    filterButton.addEventListener("click", () => {
      hideResolved = !hideResolved;
      filterButton.setAttribute("aria-pressed", String(hideResolved));
      renderList();
      dirtyAnnotations = true;
      queueFrame();
    });

    const NARROW = 640; // px; below this the list stacks under the view
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === root) root.dataset.narrow = String(entry.contentRect.width < NARROW);
        else layout();
      }
    });
    observer.observe(root);
    observer.observe(view);
    // Page content that changes size (late images, fonts) moves picked elements: re-find them on the next frame.
    const pageObserver = new ResizeObserver(() => {
      dirtyAnchors = true;
      queueFrame();
    });

    // ---- events -------------------------------------------------------------------------------------------
    function on(name, callback) {
      if (!Object.hasOwn(listeners, name)) throw new RangeError(`Unknown event "${name}"`);
      listeners[name].add(callback);
      return () => listeners[name].delete(callback);
    }

    function emit(name, payload) {
      for (const callback of listeners[name]) callback(payload);
    }

    // ---- value --------------------------------------------------------------------------------------------
    function get() {
      return { annotations: structuredClone(annotations) };
    }

    const snapshot = () => JSON.stringify(annotations);

    // A note edit becomes one undo step when it ends: on blur, or before the next structural change.
    function commitNote() {
      if (noteBefore === null) return;
      history.push(noteBefore);
      if (history.length > HISTORY_LIMIT) history.shift();
      future = [];
      noteBefore = null;
      noteEditId = null;
    }

    function pushHistory(text) {
      commitNote();
      history.push(text);
      if (history.length > HISTORY_LIMIT) history.shift();
      future = [];
    }

    function indexOf(id) {
      const index = annotations.findIndex((a) => a.id === id);
      if (index < 0) throw new Error(`No annotation with id "${id}"`);
      return index;
    }

    const find = (id) => annotations[indexOf(id)];

    function pointsIn(points, min, index) {
      if (!Array.isArray(points) || points.length < min)
        throw new TypeError(`annotations[${index}] needs at least ${min} point(s)`);
      return points.map((p) => {
        if (!p || !isNumber(p.x) || !isNumber(p.y))
          throw new TypeError(`annotations[${index}] has a point without numeric x and y`);
        return { x: p.x, y: p.y };
      });
    }

    function rectIn(rect, index) {
      if (
        !rect ||
        ![rect.x, rect.y, rect.width, rect.height].every(isNumber) ||
        rect.width < 0 ||
        rect.height < 0
      ) {
        throw new TypeError(
          `annotations[${index}] needs rect {x, y, width, height} with numbers and non-negative size`,
        );
      }
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }

    function validate(a, index) {
      if (!a || typeof a !== "object")
        throw new TypeError(`annotations[${index}] must be an object`);
      if (typeof a.id !== "string" || a.id === "")
        throw new TypeError(`annotations[${index}].id must be a non-empty string`);
      if (!KINDS.includes(a.kind))
        throw new RangeError(`annotations[${index}].kind "${a.kind}" is not a known kind`);
      const status = a.status ?? "open";
      if (status !== "open" && status !== "resolved")
        throw new RangeError(`annotations[${index}].status must be open or resolved`);
      const out = { id: a.id, kind: a.kind, note: String(a.note ?? ""), status };
      if (a.kind === "pin") out.points = pointsIn(a.points, 1, index).slice(0, 1);
      else if (a.kind === "arrow") out.points = pointsIn(a.points, 2, index).slice(0, 2);
      else if (a.kind === "freehand") out.points = pointsIn(a.points, 2, index);
      else out.rect = rectIn(a.rect, index);
      if (a.kind === "element") {
        if (!a.element || typeof a.element.selector !== "string")
          throw new TypeError(`annotations[${index}] needs element.selector`);
        out.element = structuredClone(a.element);
      }
      return out;
    }

    function noteCounter(id) {
      const match = /^a(\d+)$/.exec(id);
      if (match) counter = Math.max(counter, Number(match[1]));
    }

    function set(partial) {
      if (!partial || typeof partial !== "object")
        throw new TypeError("set() takes an object, e.g. { annotations }");
      for (const key of Object.keys(partial)) {
        if (key !== "annotations") throw new RangeError(`set() does not take "${key}"`);
      }
      if (!("annotations" in partial)) return;
      if (!Array.isArray(partial.annotations)) throw new TypeError("annotations must be an array");
      const next = partial.annotations.map(validate);
      const ids = new Set(next.map((a) => a.id));
      if (ids.size !== next.length) throw new RangeError("annotation ids must be unique");
      annotations = next;
      for (const a of annotations) noteCounter(a.id);
      history = [];
      future = [];
      noteBefore = null;
      noteEditId = null;
      if (selectedId !== null && !ids.has(selectedId)) select(null);
      drag = null;
      cancelDraft();
      reanchor();
      syncAll();
    }

    // ---- change bookkeeping -------------------------------------------------------------------------------
    function syncAll() {
      dirtyAnnotations = true;
      renderList();
      syncToolbar();
      queueFrame();
    }

    function changed() {
      syncAll();
      if (listeners.change.size > 0) emit("change", get());
    }

    function remove(id) {
      if (id === null) return;
      const index = indexOf(id);
      pushHistory(snapshot());
      annotations.splice(index, 1);
      if (selectedId === id) {
        selectedId = null;
        emit("select", null);
      }
      changed();
    }

    function moveTo(id, toIndex) {
      const from = indexOf(id);
      if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= annotations.length) {
        throw new RangeError(`toIndex ${toIndex} is out of range`);
      }
      if (from === toIndex) return;
      pushHistory(snapshot());
      const [moved] = annotations.splice(from, 1);
      annotations.splice(toIndex, 0, moved);
      changed();
    }

    function toggleResolved(id) {
      const a = find(id);
      pushHistory(snapshot());
      a.status = a.status === "open" ? "resolved" : "open";
      changed();
    }

    function restore(text) {
      cancelDraft();
      drag = null;
      annotations = JSON.parse(text);
      if (selectedId !== null && !annotations.some((a) => a.id === selectedId)) {
        selectedId = null;
        emit("select", null);
      }
      reanchor();
      changed();
    }

    function undo() {
      commitNote();
      if (history.length === 0) return false;
      future.push(snapshot());
      restore(history.pop());
      return true;
    }

    function redo() {
      if (noteBefore !== null) return false;
      if (future.length === 0) return false;
      history.push(snapshot());
      restore(future.pop());
      return true;
    }

    function addAnnotation(partial, user) {
      pushHistory(snapshot());
      const a = {
        id: `a${++counter}`,
        kind: partial.kind,
        note: partial.note ?? "",
        status: partial.status ?? "open",
      };
      if (partial.rect) a.rect = partial.rect;
      if (partial.points) a.points = partial.points;
      if (partial.element) a.element = partial.element;
      annotations.push(a);
      if (a.kind === "element") reanchor();
      if (user) {
        selectedId = a.id;
        focusNoteId = a.id;
        changed();
        emit("select", a.id);
      } else {
        syncAll();
      }
      return a;
    }

    function select(id) {
      if (id !== null) find(id);
      if (selectedId === id) return;
      selectedId = id;
      dirtyAnnotations = true;
      for (const [itemId, li] of items)
        li.setAttribute("aria-selected", String(itemId === selectedId));
      if (id !== null && items.has(id)) reveal(items.get(id));
      syncToolbar();
      queueFrame();
      emit("select", id);
    }

    function visibleAnnotations() {
      return hideResolved ? annotations.filter((a) => a.status !== "resolved") : annotations;
    }

    function stepSelection(step) {
      const shown = visibleAnnotations();
      if (shown.length === 0) return;
      const current = shown.findIndex((a) => a.id === selectedId);
      const next = clamp(
        current < 0 ? (step > 0 ? 0 : shown.length - 1) : current + step,
        0,
        shown.length - 1,
      );
      select(shown[next].id);
    }

    // ---- tools and toolbar --------------------------------------------------------------------------------
    const isPage = () => target !== null && target.kind === "page";

    function setTool(name) {
      if (!TOOLS.includes(name)) throw new RangeError(`Unknown tool "${name}"`);
      if (name === "element" && !isPage())
        throw new Error("The element tool needs a page target (setPage)");
      cancelDraft();
      tool = name;
      hover = null;
      hoverTrail = [];
      dirtyHover = true;
      syncToolbar();
      queueFrame();
    }

    function syncToolbar() {
      for (const [name, button] of toolButtons) {
        button.setAttribute("aria-pressed", String(name === tool));
        button.hidden = name === "element" && !isPage();
      }
      stage.dataset.tool = tool;
      undoButton.disabled = history.length === 0 && noteBefore === null;
      redoButton.disabled = future.length === 0 || noteBefore !== null;
      deleteButton.disabled = selectedId === null;
    }

    // ---- the list -----------------------------------------------------------------------------------------
    function actionButton(label, onClick) {
      const button = el("button", null, label);
      button.type = "button";
      button.addEventListener("click", onClick);
      return button;
    }

    function buildItem(a, index) {
      const li = el("li", "t3k-annotator-item");
      li.dataset.id = a.id;
      li.dataset.status = a.status;
      li.dataset.missing = String(missing.has(a.id));
      li.setAttribute("aria-selected", String(a.id === selectedId));
      li.addEventListener("click", (event) => {
        if (!event.target.closest("textarea, button")) select(a.id);
      });
      const body = el("div", "t3k-annotator-item-body");
      body.appendChild(
        el(
          "span",
          "t3k-annotator-item-meta",
          `${KIND_LABEL[a.kind]} · ${a.status === "resolved" ? "Resolved" : "Open"}`,
        ),
      );
      if (a.element) body.appendChild(el("code", "t3k-annotator-selector", a.element.selector));
      if (missing.has(a.id))
        body.appendChild(el("span", "t3k-annotator-warn", "Element not found in the current page"));
      const note = el("textarea", "t3k-annotator-note");
      note.rows = 2;
      note.value = a.note;
      note.placeholder =
        a.kind === "element" ? "What should change on this element?" : "Describe the change";
      note.setAttribute("aria-label", `Note for change ${index + 1}`);
      note.addEventListener("focus", () => select(a.id));
      note.addEventListener("input", () => {
        if (noteEditId !== a.id) {
          commitNote();
          noteBefore = snapshot();
          noteEditId = a.id;
        }
        a.note = note.value;
        if (selectedId !== a.id) select(a.id);
        syncToolbar();
        if (listeners.change.size > 0) emit("change", get());
      });
      note.addEventListener("blur", () => {
        commitNote();
        syncToolbar();
      });
      body.appendChild(note);
      const row = el("div", "t3k-annotator-row");
      const resolved = a.status === "resolved";
      const resolve = actionButton(resolved ? "Reopen" : "Resolve", () => toggleResolved(a.id));
      resolve.setAttribute("aria-pressed", String(resolved));
      const up = actionButton("Up", () => moveTo(a.id, index - 1));
      up.setAttribute("aria-label", `Move change ${index + 1} up`);
      up.disabled = index === 0;
      const down = actionButton("Down", () => moveTo(a.id, index + 1));
      down.setAttribute("aria-label", `Move change ${index + 1} down`);
      down.disabled = index === annotations.length - 1;
      row.append(
        resolve,
        up,
        down,
        actionButton("Delete", () => remove(a.id)),
      );
      body.appendChild(row);
      li.append(el("span", "t3k-annotator-badge", String(index + 1)), body);
      return li;
    }

    // Scrolls only the list (scrollIntoView would also scroll the page around the annotator).
    function reveal(li) {
      const lr = list.getBoundingClientRect();
      const ir = li.getBoundingClientRect();
      if (ir.top < lr.top) list.scrollTop -= lr.top - ir.top;
      else if (ir.bottom > lr.bottom)
        list.scrollTop += Math.min(ir.bottom - lr.bottom, ir.top - lr.top);
    }

    function renderList() {
      list.replaceChildren();
      items.clear();
      annotations.forEach((a, index) => {
        if (hideResolved && a.status === "resolved") return;
        const li = buildItem(a, index);
        items.set(a.id, li);
        list.appendChild(li);
      });
      if (items.size === 0) {
        const text =
          annotations.length === 0
            ? "Pick a tool and mark the target. Each change appears here with its note."
            : "All changes are resolved.";
        list.appendChild(el("li", "t3k-annotator-hint", text));
      }
      const open = annotations.filter((a) => a.status === "open").length;
      countLabel.textContent =
        annotations.length === 0 ? "" : `${open} open of ${annotations.length}`;
      if (focusNoteId !== null) {
        const li = items.get(focusNoteId);
        focusNoteId = null;
        if (li) {
          li.querySelector("textarea").focus({ preventScroll: true });
          reveal(li);
        }
      }
    }

    // ---- geometry: target coordinates <-> view px ----------------------------------------------------------
    function scrollOf() {
      return isPage()
        ? { x: target.display.scrollLeft, y: target.display.scrollTop }
        : { x: 0, y: 0 };
    }

    function toView(p, s) {
      return { x: (p.x - s.x) * scale, y: (p.y - s.y) * scale };
    }

    function toTarget(p) {
      const s = scrollOf();
      return { x: r1(p.x / scale + s.x), y: r1(p.y / scale + s.y) };
    }

    function rectFromView(a, b) {
      const p = toTarget({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) });
      const q = toTarget({ x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) });
      return { x: p.x, y: p.y, width: r1(q.x - p.x), height: r1(q.y - p.y) };
    }

    function geometryOf(a, s) {
      if (a.kind === "pin") return { anchor: toView(a.points[0], s) };
      if (a.kind === "arrow" || a.kind === "freehand") {
        const points = a.points.map((q) => toView(q, s));
        return { points, anchor: points[0] };
      }
      const rect = live.get(a.id) ?? a.rect;
      const o = toView(rect, s);
      return { x: o.x, y: o.y, w: rect.width * scale, h: rect.height * scale, anchor: o };
    }

    function hitTest(p) {
      const s = scrollOf();
      const shown = visibleAnnotations();
      for (let i = shown.length - 1; i >= 0; i--) {
        const a = shown[i];
        const g = geometryOf(a, s);
        if (a.kind === "pin") {
          if (dist(p, g.anchor) <= 10) return a;
        } else if (a.kind === "arrow" || a.kind === "freehand") {
          if (distanceToPath(p, g.points) <= 6) return a;
        } else if (a.kind === "ellipse") {
          const q =
            ((p.x - (g.x + g.w / 2)) / (g.w / 2)) ** 2 + ((p.y - (g.y + g.h / 2)) / (g.h / 2)) ** 2;
          if (q <= 1) return a;
        } else if (p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + g.h) {
          return a;
        }
      }
      return null;
    }

    function localPoint(clientX, clientY) {
      const r = stage.getBoundingClientRect();
      return { x: clamp(clientX - r.left, 0, box.width), y: clamp(clientY - r.top, 0, box.height) };
    }

    // ---- painting (at most once per animation frame, only when something is dirty) ------------------------
    function queueFrame() {
      if (frameQueued || destroyed) return;
      frameQueued = true;
      requestAnimationFrame(flush);
    }

    function flush() {
      frameQueued = false;
      if (destroyed) return;
      if (pendingPoints.length > 0) {
        const samples = pendingPoints;
        pendingPoints = [];
        applyPointer(samples);
      }
      if (dirtyAnchors) {
        dirtyAnchors = false;
        const before = [...missing].join();
        reanchor();
        if ([...missing].join() !== before) renderList();
      }
      if (recheckHover) {
        recheckHover = false;
        if (tool === "element" && lastClient) {
          hover = elementAt(lastClient.x, lastClient.y);
          hoverTrail = [];
          dirtyHover = true;
        }
      }
      if (dirtyAnnotations) {
        dirtyAnnotations = false;
        paintAnnotations();
      }
      if (dirtyDraft) {
        dirtyDraft = false;
        paintDraft();
      }
      if (dirtyHover) {
        dirtyHover = false;
        paintHover();
      }
    }

    function paintShape(node, kind, state, g) {
      if (kind === "pin") {
        setAttrs(node, {
          class: `t3k-annotator-dot ${state}`,
          cx: f2(g.anchor.x),
          cy: f2(g.anchor.y),
          r: 6,
        });
        return;
      }
      const base = `t3k-annotator-shape t3k-annotator-kind-${kind} ${state}`;
      if (kind === "rect" || kind === "element") {
        setAttrs(node, {
          class: `${base} t3k-annotator-fill`,
          x: f2(g.x),
          y: f2(g.y),
          width: f2(g.w),
          height: f2(g.h),
        });
      } else if (kind === "ellipse") {
        setAttrs(node, {
          class: `${base} t3k-annotator-fill`,
          cx: f2(g.x + g.w / 2),
          cy: f2(g.y + g.h / 2),
          rx: f2(g.w / 2),
          ry: f2(g.h / 2),
        });
      } else if (kind === "arrow") {
        setAttrs(node, { class: base, d: arrowPath(g.points[0], g.points[1]) });
      } else {
        setAttrs(node, {
          class: base,
          points: g.points.map((q) => `${f2(q.x)},${f2(q.y)}`).join(" "),
        });
      }
    }

    function stateClass(a) {
      let cls = `t3k-annotator-${a.status}`;
      if (missing.has(a.id)) cls += " t3k-annotator-missing";
      if (a.id === selectedId) cls += " t3k-annotator-sel";
      return cls;
    }

    function paintAnnotations() {
      const alive = new Set();
      const s = scrollOf();
      annotations.forEach((a, index) => {
        alive.add(a.id);
        let node = nodes.get(a.id);
        if (!node || node.kind !== a.kind) {
          if (node) {
            node.shape.remove();
            node.marker.remove();
          }
          node = {
            kind: a.kind,
            shape: svgNode(SHAPE_TAG[a.kind]),
            marker: el("div", "t3k-annotator-marker"),
          };
          svg.insertBefore(node.shape, hoverNode);
          markers.insertBefore(node.marker, chip);
          nodes.set(a.id, node);
        }
        const hidden = hideResolved && a.status === "resolved";
        node.shape.style.display = hidden ? "none" : "";
        node.marker.hidden = hidden;
        if (hidden) return;
        const g = geometryOf(a, s);
        const state = stateClass(a);
        paintShape(node.shape, a.kind, state, g);
        const label = String(index + 1);
        if (node.marker.textContent !== label) node.marker.textContent = label;
        const cls = `t3k-annotator-marker ${state}`;
        if (node.marker.className !== cls) node.marker.className = cls;
        // Keep badges on edge-hugging marks readable: nudge them inside the target box.
        const ax = clamp(g.anchor.x, 10, Math.max(10, box.width - 10));
        const ay = g.anchor.y > -10 && g.anchor.y < 10 ? 10 : g.anchor.y;
        node.marker.style.left = `${f2(ax)}px`;
        node.marker.style.top = `${f2(ay)}px`;
      });
      for (const [id, node] of nodes) {
        if (alive.has(id)) continue;
        node.shape.remove();
        node.marker.remove();
        nodes.delete(id);
      }
    }

    function paintDraft() {
      if (!draft) return;
      const { kind, start, cur, points } = draft;
      let g;
      if (kind === "rect" || kind === "ellipse") {
        g = {
          x: Math.min(start.x, cur.x),
          y: Math.min(start.y, cur.y),
          w: Math.abs(cur.x - start.x),
          h: Math.abs(cur.y - start.y),
        };
      } else if (kind === "arrow") g = { points: [start, cur] };
      else g = { points };
      paintShape(draft.node, kind, "t3k-annotator-open", g);
    }

    function paintHover() {
      if (!hover || tool !== "element" || !isPage()) {
        hoverNode.style.display = "none";
        chip.hidden = true;
        return;
      }
      const sr = stage.getBoundingClientRect();
      const r = hover.getBoundingClientRect();
      const x = r.left - sr.left;
      const y = r.top - sr.top;
      setAttrs(hoverNode, { x: f2(x), y: f2(y), width: f2(r.width), height: f2(r.height) });
      hoverNode.style.display = "";
      const id = hover.id ? `#${hover.id}` : "";
      const classes = [...hover.classList]
        .slice(0, 3)
        .map((c) => `.${c}`)
        .join("");
      chip.replaceChildren(
        `${hover.localName}${id}${classes} `,
        el("span", null, `${Math.round(r.width / scale)} × ${Math.round(r.height / scale)}`),
      );
      chip.hidden = false;
      chip.style.left = `${f2(clamp(x, 0, Math.max(0, box.width - chip.offsetWidth)))}px`;
      chip.style.top = `${f2(y >= 24 ? y - 24 : Math.min(y + r.height + 4, box.height - 22))}px`;
    }

    function layout() {
      if (!target || destroyed) return;
      const vw = view.clientWidth;
      const vh = view.clientHeight;
      const { width, height } = target.size;
      const fit = Math.max(0, Math.min((vw - 2 * PAD) / width, (vh - 2 * PAD) / height));
      scale = isPage() ? Math.min(1, fit) : fit;
      const w = width * scale;
      const h = height * scale;
      box = { x: (vw - w) / 2, y: (vh - h) / 2, width: w, height: h };
      const overlays = [svg, markers, stage];
      if (isPage()) {
        const host = target.display;
        host.style.left = `${f2(box.x)}px`;
        host.style.top = `${f2(box.y)}px`;
        host.style.width = `${width}px`;
        host.style.height = `${height}px`;
        host.style.transform = `scale(${scale})`;
      } else {
        overlays.push(target.display);
      }
      for (const node of overlays) {
        node.style.left = `${f2(box.x)}px`;
        node.style.top = `${f2(box.y)}px`;
        node.style.width = `${f2(box.width)}px`;
        node.style.height = `${f2(box.height)}px`;
      }
      svg.setAttribute("viewBox", `0 0 ${f2(box.width)} ${f2(box.height)}`);
      dirtyAnnotations = true;
      dirtyHover = true;
      queueFrame();
    }

    // ---- page elements ------------------------------------------------------------------------------------
    // Topmost page element at a client point (the stage sits above the page, so look through it).
    function elementAt(clientX, clientY) {
      const stack = target.shadow.elementsFromPoint(clientX, clientY);
      return stack.find((n) => n !== target.html && target.shadow.contains(n)) ?? null;
    }

    function pageRect(node) {
      const r = node.getBoundingClientRect();
      const hr = target.display.getBoundingClientRect();
      const s = scrollOf();
      return {
        x: r1((r.left - hr.left) / scale + s.x),
        y: r1((r.top - hr.top) / scale + s.y),
        width: r1(r.width / scale),
        height: r1(r.height / scale),
      };
    }

    function describe(node) {
      const cs = getComputedStyle(node);
      const styles = {};
      for (const prop of STYLE_PROPS) styles[prop] = cs.getPropertyValue(prop);
      return {
        selector: selectorFor(node, target.shadow),
        tag: node.localName,
        id: node.id,
        classes: [...node.classList],
        text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140),
        box: pageRect(node),
        styles,
      };
    }

    // Element annotations track their element: re-find each selector in the current page.
    function reanchor() {
      live.clear();
      missing.clear();
      if (!isPage()) return;
      for (const a of annotations) {
        if (a.kind !== "element") continue;
        const node = target.shadow.querySelector(a.element.selector);
        if (node) live.set(a.id, pageRect(node));
        else missing.add(a.id);
      }
      dirtyAnnotations = true;
      queueFrame();
    }

    function pickElement(node, extra, user) {
      const element = describe(node);
      return addAnnotation({ kind: "element", rect: { ...element.box }, element, ...extra }, user);
    }

    function addElement(selector, opts = {}) {
      if (!isPage()) throw new Error("addElement needs a page target (setPage)");
      const status = opts.status ?? "open";
      if (status !== "open" && status !== "resolved")
        throw new RangeError("addElement: status must be open or resolved");
      const node = target.shadow.querySelector(selector);
      if (!node) throw new Error(`addElement: no element matches "${selector}"`);
      return structuredClone(pickElement(node, { note: String(opts.note ?? ""), status }, false));
    }

    // ---- pointer ------------------------------------------------------------------------------------------
    // samples: client-space { x, y } in event order. Every sample feeds a freehand stroke; the last one positions
    // boxes, drags and the picker, so a frame's worth of coalesced moves costs one paint.
    function applyPointer(samples) {
      const last = samples[samples.length - 1];
      const p = localPoint(last.x, last.y);
      if (draft) {
        if (draft.kind === "freehand") {
          for (const s of samples) {
            const q = localPoint(s.x, s.y);
            if (dist(draft.points[draft.points.length - 1], q) >= STROKE_STEP) draft.points.push(q);
          }
        }
        draft.cur = p;
        dirtyDraft = true;
      }
      if (drag) {
        const dx = (p.x - drag.start.x) / scale;
        const dy = (p.y - drag.start.y) / scale;
        if (Math.abs(dx) + Math.abs(dy) > 1 / scale) drag.moved = true;
        const a = find(drag.id);
        const o = drag.orig;
        if (o.rect)
          a.rect = {
            x: r1(o.rect.x + dx),
            y: r1(o.rect.y + dy),
            width: o.rect.width,
            height: o.rect.height,
          };
        if (o.points) a.points = o.points.map((q) => ({ x: r1(q.x + dx), y: r1(q.y + dy) }));
        dirtyAnnotations = true;
      }
      if (tool === "element" && !draft && !drag) {
        const found = elementAt(last.x, last.y);
        if (found !== hover) {
          hover = found;
          hoverTrail = [];
          dirtyHover = true;
        }
      }
    }

    function endPointer(e, cancelled) {
      if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
      // Samples still waiting for a frame must land before the gesture is committed.
      const samples = [...pendingPoints, { x: e.clientX, y: e.clientY }];
      pendingPoints = [];
      if (draft) {
        if (cancelled) cancelDraft();
        else {
          applyPointer(samples);
          commitDraft();
        }
      }
      if (drag) {
        if (!cancelled) applyPointer(samples);
        const d = drag;
        drag = null;
        if (d.moved && cancelled) {
          annotations = JSON.parse(d.before);
          syncAll();
        } else if (d.moved) {
          pushHistory(d.before);
          changed();
        }
      }
      queueFrame();
    }

    function startSelect(p) {
      const hit = hitTest(p);
      select(hit ? hit.id : null);
      if (hit && hit.kind !== "element") {
        drag = {
          id: hit.id,
          start: p,
          orig: structuredClone(hit),
          before: snapshot(),
          moved: false,
        };
      }
    }

    function startDraft(p) {
      const node = svgNode(SHAPE_TAG[tool]);
      svg.insertBefore(node, hoverNode);
      draft = { kind: tool, start: p, cur: p, points: [p], node };
      dirtyDraft = true;
      queueFrame();
    }

    function cancelDraft() {
      if (!draft) return;
      draft.node.remove();
      draft = null;
    }

    function commitDraft() {
      const d = draft;
      cancelDraft();
      const s = d.start;
      const p = d.cur;
      if (d.kind === "rect" || d.kind === "ellipse") {
        if (Math.abs(p.x - s.x) < MIN_DRAG && Math.abs(p.y - s.y) < MIN_DRAG) return;
        addAnnotation({ kind: d.kind, rect: rectFromView(s, p) }, true);
      } else if (d.kind === "arrow") {
        if (dist(s, p) < MIN_DRAG) return;
        addAnnotation({ kind: "arrow", points: [toTarget(s), toTarget(p)] }, true);
      } else {
        const points = d.points.slice();
        if (dist(points[points.length - 1], p) > 0) points.push(p);
        let length = 0;
        for (let i = 1; i < points.length; i++) length += dist(points[i - 1], points[i]);
        if (points.length < 2 || length < MIN_DRAG) return;
        addAnnotation({ kind: "freehand", points: points.map(toTarget) }, true);
      }
    }

    stage.addEventListener("pointerdown", (e) => {
      if (!target || e.button !== 0) return;
      root.focus({ preventScroll: true });
      stage.setPointerCapture(e.pointerId);
      lastClient = { x: e.clientX, y: e.clientY };
      const p = localPoint(e.clientX, e.clientY);
      if (tool === "select") startSelect(p);
      else if (tool === "pin") addAnnotation({ kind: "pin", points: [toTarget(p)] }, true);
      else if (tool === "element") {
        const found = hover ?? elementAt(e.clientX, e.clientY);
        if (found) pickElement(found, {}, true);
      } else startDraft(p);
    });
    stage.addEventListener("pointermove", (e) => {
      if (!target) return;
      lastClient = { x: e.clientX, y: e.clientY };
      if (!draft && !drag && tool !== "element") return;
      const coalesced = e.getCoalescedEvents();
      for (const sample of coalesced.length > 0 ? coalesced : [e])
        pendingPoints.push({ x: sample.clientX, y: sample.clientY });
      queueFrame();
    });
    stage.addEventListener("pointerup", (e) => endPointer(e, false));
    stage.addEventListener("pointercancel", (e) => endPointer(e, true));
    stage.addEventListener("pointerleave", () => {
      lastClient = null;
      if (hover && !draft && !drag) {
        hover = null;
        hoverTrail = [];
        dirtyHover = true;
        queueFrame();
      }
    });
    stage.addEventListener(
      "wheel",
      (e) => {
        if (!isPage()) return;
        e.preventDefault();
        target.display.scrollBy({ left: e.deltaX / scale, top: e.deltaY / scale });
      },
      { passive: false },
    );

    function onPageScroll() {
      dirtyAnnotations = true;
      recheckHover = true;
      if (draft) cancelDraft();
      queueFrame();
    }

    // ---- keyboard -----------------------------------------------------------------------------------------
    function pickerKey(e) {
      if (e.key === "ArrowUp") {
        const parent = hover.parentElement;
        if (parent && parent !== target.html) {
          hoverTrail.push(hover);
          hover = parent;
        }
      } else if (e.key === "ArrowDown") {
        if (hoverTrail.length > 0) hover = hoverTrail.pop();
      } else if (e.key === "Enter") {
        pickElement(hover, {}, true);
      } else return false;
      e.preventDefault();
      dirtyHover = true;
      queueFrame();
      return true;
    }

    root.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLTextAreaElement) {
        if (e.key === "Escape") {
          e.target.blur();
          root.focus({ preventScroll: true });
        }
        return;
      }
      if (e.target instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
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
      if (tool === "element" && hover && !e.altKey && !mod && pickerKey(e)) return;
      if (e.key === "Escape") {
        if (draft) cancelDraft();
        else if (tool !== "select") setTool("select");
        else select(null);
        queueFrame();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId !== null) {
          e.preventDefault();
          remove(selectedId);
        }
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const step = e.key === "ArrowUp" ? -1 : 1;
        if (e.altKey) {
          if (selectedId !== null) {
            const next = indexOf(selectedId) + step;
            if (next >= 0 && next < annotations.length) moveTo(selectedId, next);
          }
        } else stepSelection(step);
        return;
      }
      if (mod || e.altKey) return;
      if (key === "x" && selectedId !== null) {
        e.preventDefault();
        toggleResolved(selectedId);
        return;
      }
      const next = TOOL_FOR_KEY[key];
      if (!next || (next === "element" && !isPage())) return;
      e.preventDefault();
      setTool(next);
    });

    // ---- targets ------------------------------------------------------------------------------------------
    function previewCanvas(source, natural) {
      const longest = Math.max(view.clientWidth, view.clientHeight, 512) * window.devicePixelRatio;
      const s = Math.min(
        1,
        Math.min(PREVIEW_MAX, longest) / Math.max(natural.width, natural.height),
      );
      const canvas = el("canvas");
      canvas.width = Math.max(1, Math.round(natural.width * s));
      canvas.height = Math.max(1, Math.round(natural.height * s));
      const g = canvas.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(source, 0, 0, canvas.width, canvas.height);
      return canvas;
    }

    function mountTarget(next) {
      cancelDraft();
      drag = null;
      hover = null;
      hoverTrail = [];
      if (target) {
        if (target.kind === "page") {
          pageObserver.disconnect();
          target.display.removeEventListener("scroll", onPageScroll);
        }
        target.display.remove();
      }
      target = next;
      next.display.classList.add(
        next.kind === "page" ? "t3k-annotator-page" : "t3k-annotator-target",
      );
      view.insertBefore(next.display, svg);
      view.dataset.kind = next.kind;
      if (tool === "element" && next.kind !== "page") tool = "select";
      empty.hidden = true;
      layout();
      syncToolbar();
    }

    async function setImage(source) {
      let full = source;
      if (typeof source === "string") full = await (await fetch(source)).blob();
      let natural;
      let display;
      if (full instanceof Blob) {
        const bitmap = await createImageBitmap(full);
        natural = { width: bitmap.width, height: bitmap.height };
        display = previewCanvas(bitmap, natural);
        bitmap.close();
      } else if (full instanceof HTMLImageElement) {
        await full.decode();
        natural = { width: full.naturalWidth, height: full.naturalHeight };
        display = previewCanvas(full, natural);
      } else if (full instanceof HTMLCanvasElement || full instanceof ImageBitmap) {
        natural = { width: full.width, height: full.height };
        display = previewCanvas(full, natural);
      } else {
        throw new TypeError("setImage needs a Blob, a URL, an <img>, a <canvas> or an ImageBitmap");
      }
      if (destroyed) return { ...natural };
      mountTarget({
        kind: full instanceof HTMLCanvasElement ? "canvas" : "image",
        size: natural,
        full,
        display,
      });
      reanchor();
      emit("load", { ...natural });
      return { ...natural };
    }

    async function setPage(source, opts = {}) {
      const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
      if (
        !isNumber(viewport.width) ||
        !isNumber(viewport.height) ||
        viewport.width <= 0 ||
        viewport.height <= 0
      ) {
        throw new TypeError("setPage: viewport needs positive numeric width and height");
      }
      const host = el("div");
      const shadow = host.attachShadow({ mode: "open" });
      const page = buildPage(shadow, source);
      const size = { width: viewport.width, height: viewport.height };
      mountTarget({ kind: "page", size, display: host, shadow, html: page.html });
      host.addEventListener("scroll", onPageScroll, { passive: true });
      await page.loaded;
      if (destroyed || target.display !== host) return { ...size };
      // Browsers paint the root or body background across the whole canvas; the host plays the canvas here.
      const htmlBg = getComputedStyle(page.html).backgroundColor;
      const bodyBg = getComputedStyle(page.body).backgroundColor;
      if (htmlBg !== TRANSPARENT) host.style.backgroundColor = htmlBg;
      else if (bodyBg !== TRANSPARENT) host.style.backgroundColor = bodyBg;
      pageObserver.observe(page.html);
      reanchor();
      renderList();
      emit("load", { ...size });
      return { ...size };
    }

    function refresh() {
      if (isPage()) {
        reanchor();
        renderList();
      }
      layout();
    }

    // ---- export -------------------------------------------------------------------------------------------
    function exportChangeList(opts = {}) {
      if (!target) throw new Error("exportChangeList needs a loaded target (setImage or setPage)");
      const records = [];
      annotations.forEach((a, index) => {
        if (opts.onlyOpen && a.status !== "open") return;
        const record = {
          number: index + 1,
          id: a.id,
          kind: a.kind,
          status: a.status,
          note: a.note,
        };
        if (a.rect) record.rect = { ...a.rect };
        if (a.points) record.points = structuredClone(a.points);
        if (a.element) {
          record.element = structuredClone(a.element);
          record.found = !missing.has(a.id);
        }
        record.bounds = roundBox(boundsOf(live.get(a.id) ?? a.rect, a.points));
        records.push(record);
      });
      const open = annotations.filter((a) => a.status === "open").length;
      const json = {
        target: { kind: target.kind, width: target.size.width, height: target.size.height },
        counts: { open, resolved: annotations.length - open },
        annotations: records,
      };
      return { json, markdown: toMarkdown(json) };
    }

    async function toDrawable(shot) {
      if (shot instanceof Blob) return createImageBitmap(shot);
      if (shot instanceof HTMLCanvasElement || shot instanceof ImageBitmap) return shot;
      throw new TypeError("options.screenshot must resolve to a Blob, a canvas or an ImageBitmap");
    }

    async function cropImage(ref, cropOptions = {}) {
      if (!target) throw new Error("cropImage needs a loaded target");
      const a = typeof ref === "string" ? find(ref) : find(ref.id);
      const pad = cropOptions.pad ?? 12;
      const size = target.size;
      let region = boundsOf(live.get(a.id) ?? a.rect, a.points);
      if (a.kind === "pin") {
        const side = (cropOptions.pinSize ?? 0.2) * size.width;
        region = { x: region.x - side / 2, y: region.y - side / 2, width: side, height: side };
      }
      const limitH = isPage() ? Math.max(size.height, target.html.scrollHeight) : size.height;
      const x0 = clamp(Math.floor(region.x - pad), 0, size.width - 1);
      const y0 = clamp(Math.floor(region.y - pad), 0, limitH - 1);
      const x1 = clamp(Math.ceil(region.x + region.width + pad), x0 + 1, size.width);
      const y1 = clamp(Math.ceil(region.y + region.height + pad), y0 + 1, limitH);
      const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      if (!isPage())
        return canvasToPng(await cropSource(target.full, rect.x, rect.y, rect.width, rect.height));
      if (!screenshot) throw new Error("cropImage on a page needs options.screenshot(rect)");
      const shot = await toDrawable(await screenshot({ ...rect }));
      const out = el("canvas");
      out.width = shot.width;
      out.height = shot.height;
      out.getContext("2d").drawImage(shot, 0, 0);
      return canvasToPng(out);
    }

    function destroy() {
      destroyed = true;
      observer.disconnect();
      pageObserver.disconnect();
      root.remove();
      for (const callbacks of Object.values(listeners)) callbacks.clear();
    }

    if (options.value !== undefined) set(options.value);
    if (options.tool !== undefined) setTool(options.tool);
    renderList();
    syncToolbar();

    return {
      get,
      set,
      on,
      destroy,
      setImage,
      setPage,
      setTool,
      getTool: () => tool,
      select,
      move: moveTo,
      remove,
      undo,
      redo,
      refresh,
      addElement,
      exportChangeList,
      cropImage,
    };
  }

  t3kit.annotator = {
    create(container, options = {}) {
      if (!(container instanceof HTMLElement))
        throw new TypeError("annotator.create needs an HTMLElement container");
      injectStyle();
      return build(container, options);
    },
  };
})();
