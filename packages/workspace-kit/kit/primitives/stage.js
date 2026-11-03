/**
 * t3kit.stage: hosts agent-supplied component code in isolated cells (one per state, width and prop set), with
 * backgrounds, an onion-skin overlay, forced pseudo-states, a per-cell layout probe and PNG export.
 *
 * create(container, options?) -> instance. Fills `container` and follows its size.
 *   options.mode: 'shadow' (default: one Shadow DOM per cell, page media queries; component code runs in the page) |
 *     'frame' (one sandboxed srcdoc iframe per cell: media queries see the cell width; code never runs in the page;
 *     no storage, no network; cells are reached only through postMessage).
 *   options.background: 'canvas' (default) | 'card' | 'checker'.   options.theme = true: inject the T3 tokens.
 *   options.layout: { cols: 'auto' | n = 'auto', gap = 16 }. 'auto' wraps; a cell with a width keeps that width.
 *   options.overlay: Blob | URL | { src, opacity = 0.5 }: reference image shown over every cell as an onion skin.
 * load({ js, css?, assets? }) -> Promise<{ name, props }>   js, css: text or Blob. assets { name: Blob } replace
 *   url(name) in css and src="name" attributes (blob: URLs in shadow cells, data: URLs in frame cells).
 *   Component: window.t3component = { name, props: schema, css?, mount(el, props) -> { update(props), destroy() },
 *   usage?(props) -> string }. Schema: { key: { type: 'string'|'number'|'boolean'|'enum', default?, options? } }.
 *   A throw at load rejects; a throw in mount or update is caught per cell ('error' event, measure().errors).
 * setCells([{ id, props?, state = 'default', width?, label? }]) -> Promise   reconciles by id; resolves after render.
 *   state: default | hover | focus | active | disabled. focus also forces :focus-visible; disabled sets props.disabled.
 * update(cellId, props) -> Promise   merges props; re-renders through component.update() at most once per frame.
 * setOverlay(Blob | URL | { src?, opacity } | null)
 * get() -> { cells: [{ id, props, state, width, label }], background, layout, selected, overlay: { opacity } | null }
 * set(partial) -> Promise   silent. Keys: cells, background, layout, selected, overlay. Unknown keys throw.
 * measure(cellId) -> Promise<{ width, height, overflowX, overflowing: [selector], errors: [message] }>
 * usage(cellId) -> Promise<string | null>   the component's usage(props), when it has one.
 * exportPng({ cells?, scale = 2 }) -> Promise<Blob | null>   null when something cannot be inlined (reason on 'error').
 * on('change' | 'select' | 'error', cb) -> unsubscribe   change: get() after a user state, background or overlay
 *   edit; select: cellId; error: { cellId | null, message }.     destroy()
 * Forced states: :hover, :focus, :focus-visible and :active rules get twins matching [data-t3k-stage-force~=state] on
 *   the cell root. A pseudo-state inside :not() or :is() cannot be forced.
 *
 * Example:
 *   const s = t3kit.stage.create(el, { mode: 'frame', background: 'card' });
 *   await s.load({ js: buttonJs, assets: { 'photo.jpg': photoBlob } });
 *   await s.setCells([{ id: 'phone', width: 375, props: { label: 'Save' } }, { id: 'hover', state: 'hover' }]);
 *   const m = await s.measure('phone');   // { width: 375, height, overflowX, overflowing, errors }
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});

  const TOKENS = [
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
    "--radius",
    "--font-sans",
    "--font-mono",
  ];
  const MODES = ["shadow", "frame"];
  const BACKGROUNDS = ["canvas", "card", "checker"];
  const BACKGROUND_LABEL = { canvas: "Canvas", card: "Card", checker: "Checker" };
  const STATES = ["default", "hover", "focus", "active", "disabled"];
  // The value written to data-t3k-stage-force for each forced state. Keyboard focus shows :focus-visible too.
  const FORCE_OF = { hover: "hover", focus: "focus focus-visible", active: "active" };
  const PROP_TYPES = ["string", "number", "boolean", "enum"];
  const PSEUDO = /:(focus-visible|focus|hover|active)(?![\w-])/g;
  const FRAME_TIMEOUT_MS = 4000;
  const WELL_INSET_PX = 26; // .t3k-stage-well padding and border, both sides
  const NARROW_PX = 520;

  const STYLE_TEXT = `
.t3k-stage-root{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;font:12px/1.4 var(--font-sans);color:var(--foreground)}
.t3k-stage-root [hidden]{display:none!important}
.t3k-stage-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.t3k-stage-root[data-narrow] .t3k-stage-bar{flex-direction:column;align-items:stretch}
.t3k-stage-seg{display:inline-flex;border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);overflow:hidden}
.t3k-stage-btn{appearance:none;height:26px;padding:0 10px;border:0;background:var(--card);color:var(--muted-foreground);font:inherit;cursor:pointer;white-space:nowrap}
.t3k-stage-btn:hover{color:var(--foreground)}
.t3k-stage-btn[aria-pressed=true]{background:var(--accent);color:var(--accent-foreground)}
.t3k-stage-overlay-ctl{display:inline-flex;align-items:center;gap:6px;color:var(--muted-foreground)}
.t3k-stage-opacity{width:140px;accent-color:var(--ring)}
.t3k-stage-grid{flex:1 1 auto;display:grid;grid-template-columns:var(--t3k-stage-cols);gap:var(--t3k-stage-gap);align-items:start;align-content:start;min-height:0;overflow:auto}
.t3k-stage-grid[data-cols=auto]{display:flex;flex-wrap:wrap}
.t3k-stage-cell{display:flex;flex-direction:column;gap:6px;min-width:0;margin:0}
.t3k-stage-grid[data-cols=auto]>.t3k-stage-cell{flex:1 1 260px}
.t3k-stage-grid[data-cols=auto]>.t3k-stage-cell[data-fixed]{flex:0 1 auto;width:var(--t3k-stage-w);max-width:100%}
.t3k-stage-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.t3k-stage-label{appearance:none;min-width:0;padding:2px 0;border:0;background:none;color:var(--muted-foreground);font:inherit;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.t3k-stage-label[aria-pressed=true]{color:var(--foreground);box-shadow:inset 0 -2px 0 var(--ring)}
.t3k-stage-state{height:24px;max-width:50%;padding:0 4px;border:1px solid var(--input);border-radius:calc(var(--radius) - 4px);background:var(--card);color:var(--foreground);font:inherit}
.t3k-stage-well{position:relative;box-sizing:border-box;min-width:0;padding:12px;border:1px solid var(--border);border-radius:var(--radius);overflow:auto}
.t3k-stage-well[data-bg=canvas]{background:var(--background)}
.t3k-stage-well[data-bg=card]{background:var(--card);color:var(--card-foreground)}
.t3k-stage-well[data-bg=checker]{background:repeating-conic-gradient(var(--border) 0 25%, var(--background) 0 50%) 0 0 / 16px 16px}
.t3k-stage-body{position:relative;min-width:0}
.t3k-stage-frame{display:block;box-sizing:border-box;width:100%;max-width:none;height:120px;border:0;background:transparent}
.t3k-stage-shadow{display:block;min-width:0}
.t3k-stage-overlay{position:absolute;top:0;left:0;width:100%;height:auto;pointer-events:none}
.t3k-stage-error{margin:6px 0 0;padding:6px 8px;border:1px solid var(--destructive);border-radius:calc(var(--radius) - 4px);background:color-mix(in srgb, var(--destructive) 12%, transparent);color:var(--destructive);white-space:pre-wrap}
`;

  // ---- Shared helpers. frameRuntime and the helpers it calls are serialised into each frame's srcdoc, so they
  // ---- must not reference anything outside their own bodies (no closure variables, no t3kit).

  function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function applyForce(el, force) {
    if (force) el.setAttribute("data-t3k-stage-force", force);
    else el.removeAttribute("data-t3k-stage-force");
  }

  function validateSchema(schema) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
      throw new TypeError("props schema must be an object");
    for (const [key, spec] of Object.entries(schema)) {
      if (!spec || !["string", "number", "boolean", "enum"].includes(spec.type)) {
        throw new TypeError(`props.${key}.type must be string, number, boolean or enum`);
      }
      if (spec.type === "enum" && !Array.isArray(spec.options))
        throw new TypeError(`props.${key}.options must be an array`);
    }
    return schema;
  }

  function evaluateComponent(js) {
    const previous = window.t3component;
    delete window.t3component;
    try {
      new Function(js)();
      const component = window.t3component;
      if (!component || typeof component !== "object")
        throw new TypeError("the script must set window.t3component = { name, props, mount }");
      if (typeof component.name !== "string" || component.name === "")
        throw new TypeError("window.t3component.name must be a non-empty string");
      if (typeof component.mount !== "function")
        throw new TypeError("window.t3component.mount(el, props) is required");
      if (component.css !== undefined && typeof component.css !== "string")
        throw new TypeError("window.t3component.css must be text");
      return {
        name: component.name,
        props: validateSchema(component.props ?? {}),
        css: component.css ?? "",
        mount: component.mount,
        usage: component.usage,
      };
    } finally {
      if (previous === undefined) delete window.t3component;
      else window.t3component = previous;
    }
  }

  function checkInstance(instance) {
    if (
      !instance ||
      typeof instance.update !== "function" ||
      typeof instance.destroy !== "function"
    ) {
      throw new TypeError("mount(el, props) must return { update(props), destroy() }");
    }
    return instance;
  }

  function rewriteRefs(root, assets) {
    for (const el of root.querySelectorAll("[src]")) {
      const name = el.getAttribute("src");
      if (Object.hasOwn(assets, name)) el.setAttribute("src", assets[name]);
    }
  }

  // Components set src during mount and update, so rewriting happens on every mutation as well as after a render.
  function watchRefs(root, assets) {
    const observer = new MutationObserver(() => rewriteRefs(root, assets));
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src"],
    });
    rewriteRefs(root, assets);
    return observer;
  }

  function selectorOf(el, root) {
    const parts = [];
    for (let node = el; node && node !== root && parts.length < 6; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) part += `#${node.id}`;
      else if (node.classList.length) part += `.${[...node.classList].slice(0, 2).join(".")}`;
      parts.unshift(part);
    }
    return parts.join(" > ");
  }

  function measureRoot(root) {
    const box = root.getBoundingClientRect();
    const overflowing = [];
    for (const el of root.querySelectorAll("*")) {
      if (overflowing.length === 20) break;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5))
        overflowing.push(selectorOf(el, root));
    }
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      overflowX: overflowing.length > 0 || root.scrollWidth > root.clientWidth + 1,
      overflowing,
      errors: [],
    };
  }

  function snapshotRoot(root) {
    const box = root.getBoundingClientRect();
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      html: new XMLSerializer().serializeToString(root),
    };
  }

  // The frame document: sandboxed, opaque origin, no network (CSP connect-src and default-src none), no storage.
  function frameRuntime() {
    const root = document.getElementById("t3k-stage-root");
    const tokenStyle = document.getElementById("t3k-stage-tokens");
    const componentStyle = document.getElementById("t3k-stage-component");
    const post = (message) => parent.postMessage({ t3k: "stage", ...message }, "*");
    const reply = (id, work) => {
      try {
        post({ type: "reply", id, ok: true, result: work() });
      } catch (error) {
        post({ type: "reply", id, ok: false, message: messageOf(error) });
      }
    };
    let component = null;
    let assets = {};
    let instance = null;
    let watcher = null;
    // Reported after every render as well as on resize: a hidden pane never fires ResizeObserver.
    const postSize = () =>
      post({ type: "size", height: Math.ceil(root.getBoundingClientRect().height) });
    const teardown = () => {
      if (watcher) watcher.disconnect();
      watcher = null;
      if (instance) {
        try {
          instance.destroy();
        } catch (error) {
          post({ type: "error", message: `destroy: ${messageOf(error)}` });
        }
      }
      instance = null;
      root.replaceChildren();
    };
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (event.source !== parent || !message || message.t3k !== "stage") return;
      if (message.type === "tokens") {
        tokenStyle.textContent = message.css;
      } else if (message.type === "code") {
        teardown();
        componentStyle.textContent = message.css;
        assets = message.assets;
        component = null;
        try {
          component = evaluateComponent(message.js);
          post({
            type: "component",
            name: component.name,
            props: component.props,
            css: component.css,
          });
        } catch (error) {
          post({ type: "error", message: messageOf(error) });
        }
      } else if (message.type === "render") {
        applyForce(root, message.force);
        try {
          if (!component) throw new Error("no component loaded in this frame");
          if (!instance) {
            root.replaceChildren();
            instance = checkInstance(component.mount(root, message.props));
            watcher = watchRefs(root, assets);
          } else {
            instance.update(message.props);
            rewriteRefs(root, assets);
          }
        } catch (error) {
          post({ type: "error", message: messageOf(error) });
        }
        postSize();
      } else if (message.type === "measure") {
        reply(message.id, () => measureRoot(root));
      } else if (message.type === "snapshot") {
        reply(message.id, () => snapshotRoot(root));
      } else if (message.type === "usage") {
        reply(message.id, () =>
          component && typeof component.usage === "function"
            ? String(component.usage(message.props))
            : null,
        );
      }
    });
    new ResizeObserver(postSize).observe(root);
    post({ type: "ready" });
  }

  const FRAME_RUNTIME = [
    messageOf,
    applyForce,
    validateSchema,
    evaluateComponent,
    checkInstance,
    rewriteRefs,
    watchRefs,
    selectorOf,
    measureRoot,
    snapshotRoot,
    frameRuntime,
  ]
    .map((fn) => fn.toString())
    .join("\n");

  const FRAME_HEAD = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:"><style id="t3k-stage-tokens"></style><style id="t3k-stage-component"></style><style>html,body{margin:0;padding:0;background:transparent;color:var(--foreground);font:14px/1.5 var(--font-sans)}#t3k-stage-root{box-sizing:border-box;min-width:0}</style></head><body><div id="t3k-stage-root"></div><script>`;
  const FRAME_SRCDOC = `${FRAME_HEAD}\n${FRAME_RUNTIME}\nframeRuntime();</script></body></html>`;

  // ---- Parent-side helpers.

  function oneOf(value, list, name) {
    if (!list.includes(value)) throw new TypeError(`${name} must be one of ${list.join(" | ")}`);
    return value;
  }

  function checkLayout(layout) {
    if (!(layout.cols === "auto" || (Number.isInteger(layout.cols) && layout.cols > 0))) {
      throw new TypeError('layout.cols must be "auto" or a positive integer');
    }
    if (!(Number.isFinite(layout.gap) && layout.gap >= 0))
      throw new TypeError("layout.gap must be a number of pixels, 0 or more");
    return layout;
  }

  function readOptions(options) {
    const config = {
      mode: oneOf(options.mode ?? "shadow", MODES, "mode"),
      background: oneOf(options.background ?? "canvas", BACKGROUNDS, "background"),
      theme: options.theme ?? true,
      layout: checkLayout({ cols: "auto", gap: 16, ...(options.layout ?? {}) }),
      overlay: options.overlay ?? null,
    };
    if (typeof config.theme !== "boolean") throw new TypeError("theme must be true or false");
    return config;
  }

  function mergeProps(schema, given, where) {
    if (!given || typeof given !== "object" || Array.isArray(given))
      throw new TypeError(`${where}.props must be an object`);
    const props = {};
    for (const [key, spec] of Object.entries(schema))
      if (spec.default !== undefined) props[key] = spec.default;
    Object.assign(props, given);
    for (const [key, spec] of Object.entries(schema)) {
      if (!Object.hasOwn(props, key)) continue;
      const value = props[key];
      const valid =
        spec.type === "enum" ? spec.options.includes(value) : typeof value === spec.type;
      if (!valid) {
        const expected = spec.type === "enum" ? spec.options.join(" | ") : spec.type;
        throw new TypeError(
          `${where}.props.${key} must be ${expected}, got ${JSON.stringify(value)}`,
        );
      }
    }
    return props;
  }

  function effectiveProps(cell) {
    const props = { ...cell.props };
    if (cell.state === "disabled") props.disabled = true;
    return props;
  }

  function forcedRules(prelude, body) {
    let rules = "";
    for (const selector of splitSelectors(prelude)) {
      const states = new Set([...selector.matchAll(PSEUDO)].map((match) => match[1]));
      const bare = selector.replace(PSEUDO, "").trim() || "*";
      const anchored = /^[>+~]/.test(bare) ? `* ${bare}` : bare;
      for (const state of states) rules += `[data-t3k-stage-force~=${state}] ${anchored}{${body}}`;
    }
    return rules;
  }

  function splitSelectors(list) {
    const out = [];
    let depth = 0;
    let quote = "";
    let current = "";
    for (const ch of list) {
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "(" || ch === "[") {
        depth += 1;
      } else if (ch === ")" || ch === "]") {
        depth -= 1;
      } else if (ch === "," && depth === 0) {
        out.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    out.push(current.trim());
    return out.filter(Boolean);
  }

  // Walks the stylesheet and gives every selector with a forcible pseudo-state a twin keyed on the cell root's
  // data-t3k-stage-force attribute, so a forced state paints like the real one (storybook-addon-pseudo-states style).
  function forceStates(css) {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    let index = 0;
    const block = () => {
      let out = "";
      while (index < source.length) {
        if (source[index] === "}") {
          index += 1;
          return out;
        }
        const start = index;
        let end = index;
        let quote = "";
        while (end < source.length && (quote || !"{;}".includes(source[end]))) {
          if (quote) {
            if (source[end] === "\\") end += 1;
            else if (source[end] === quote) quote = "";
          } else if (source[end] === '"' || source[end] === "'") {
            quote = source[end];
          }
          end += 1;
        }
        if (end >= source.length) {
          out += source.slice(start);
          index = source.length;
          break;
        }
        const stop = source[end];
        if (stop === ";") {
          out += source.slice(start, end + 1);
          index = end + 1;
          continue;
        }
        if (stop === "}") {
          out += source.slice(start, end);
          index = end;
          continue;
        }
        const prelude = source.slice(start, end);
        index = end + 1;
        const body = block();
        out += prelude.trim().startsWith("@")
          ? `${prelude}{${body}}`
          : `${prelude}{${body}}${forcedRules(prelude, body)}`;
      }
      return out;
    };
    return block();
  }

  function rewriteUrls(css, urls) {
    return css.replace(/url\(\s*(["']?)([^"')\s]+)\1\s*\)/g, (match, quote, name) =>
      Object.hasOwn(urls, name) ? `url("${urls[name]}")` : match,
    );
  }

  // The color-scheme always travels: a frame whose scheme differs from the page gets an opaque canvas in Chrome.
  function readTokens(withVars) {
    const style = getComputedStyle(document.documentElement);
    const vars = {};
    if (withVars) for (const name of TOKENS) vars[name] = style.getPropertyValue(name).trim();
    return { vars, scheme: style.getPropertyValue("color-scheme").trim() };
  }

  function tokensCss(tokens, selector = ":root") {
    const declarations = Object.entries(tokens.vars)
      .filter(([, value]) => value !== "")
      .map(([name, value]) => `${name}:${value}`);
    declarations.push(`color-scheme:${tokens.scheme || "normal"}`);
    return `${selector}{${declarations.join(";")}}`;
  }

  function textOf(value, label) {
    if (typeof value === "string") return Promise.resolve(value);
    if (value instanceof Blob) return value.text();
    throw new TypeError(`${label} must be text or a Blob`);
  }

  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function escapeXml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function cellSvg(shot, css, background) {
    const { width, height, html } = shot;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="${width}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml"><style>${escapeXml(css)}</style><div class="t3k-stage-well" data-bg="${background}" style="box-sizing:border-box;width:${width}px;height:${height}px;padding:0;border:0;overflow:hidden">${html}</div></div></foreignObject></svg>`;
  }

  // A data: URL, not blob:. Blob URLs carry the page origin, which is opaque in the kit sandbox, and Chrome taints
  // a canvas drawn from an SVG whose origin it cannot match.
  function loadSvgImage(svgText) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("a cell could not be rasterised"));
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
    });
  }

  function canvasToPng(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("the canvas could not be encoded"))),
        "image/png",
      );
    });
  }

  // A frame cell is a sandboxed srcdoc iframe. It talks only through postMessage; 'ready' gates the first send.
  function createFrame(frames, onMessage) {
    const iframe = document.createElement("iframe");
    iframe.className = "t3k-stage-frame";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("title", "Component cell");
    iframe.srcdoc = FRAME_SRCDOC;
    const queue = [];
    let ready = false;
    const frame = {
      iframe,
      handle(data) {
        if (data.type === "ready") {
          ready = true;
          for (const packet of queue.splice(0)) iframe.contentWindow.postMessage(packet, "*");
          return;
        }
        onMessage(data);
      },
      send(message) {
        const packet = { t3k: "stage", ...message };
        if (ready) iframe.contentWindow.postMessage(packet, "*");
        else queue.push(packet);
      },
      destroy() {
        frames.delete(frame);
        iframe.remove();
      },
    };
    frames.add(frame);
    return frame;
  }

  function createFrameView(frames, report) {
    const pending = new Map();
    let nextId = 0;
    let version = -1;
    const frame = createFrame(frames, (data) => {
      if (data.type === "error") report(data.message);
      else if (data.type === "size") frame.iframe.style.height = `${data.height}px`;
      else if (data.type === "reply" && pending.has(data.id)) {
        const settle = pending.get(data.id);
        pending.delete(data.id);
        settle(data);
      }
    });
    const request = (type, extra = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${type} got no answer from the frame within ${FRAME_TIMEOUT_MS} ms`));
        }, FRAME_TIMEOUT_MS);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          if (reply.ok) resolve(reply.result);
          else reject(new Error(reply.message));
        });
        frame.send({ type, id, ...extra });
      });
    return {
      element: frame.iframe,
      get version() {
        return version;
      },
      code(next) {
        version = next.version;
        frame.send({
          type: "code",
          version: next.version,
          js: next.js,
          css: next.css,
          assets: next.assets,
        });
      },
      render({ props, force }) {
        frame.send({ type: "render", props, force });
      },
      tokens(tokens) {
        frame.send({ type: "tokens", css: tokensCss(tokens) });
      },
      measure: () => request("measure"),
      snapshot: () => request("snapshot"),
      usage: (props) => request("usage", { props }),
      destroy() {
        for (const settle of pending.values())
          settle({ ok: false, message: "the cell was removed" });
        pending.clear();
        frame.destroy();
      },
    };
  }

  // A shadow cell: a Shadow DOM host in the page realm. Styles are isolated; media queries see the page viewport.
  // All shadow cells of a stage adopt one constructed sheet, so a new component is one replaceSync, not N writes.
  function createShadowView(sheet, report) {
    const element = document.createElement("div");
    element.className = "t3k-stage-shadow";
    const shadow = element.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = [sheet];
    const root = document.createElement("div");
    root.className = "t3k-stage-cell-root";
    shadow.append(root);
    let component = null;
    let assets = {};
    let instance = null;
    let watcher = null;
    let version = -1;
    const teardown = () => {
      if (watcher) watcher.disconnect();
      watcher = null;
      if (instance) {
        try {
          instance.destroy();
        } catch (error) {
          report(`destroy: ${messageOf(error)}`);
        }
      }
      instance = null;
      root.replaceChildren();
    };
    return {
      element,
      get version() {
        return version;
      },
      code(next) {
        teardown();
        component = next.component;
        assets = next.assets;
        version = next.version;
      },
      render({ props, force }) {
        applyForce(root, force);
        try {
          if (!instance) {
            root.replaceChildren();
            instance = checkInstance(component.mount(root, props));
            watcher = watchRefs(root, assets);
          } else {
            instance.update(props);
            rewriteRefs(root, assets);
          }
        } catch (error) {
          report(messageOf(error));
        }
      },
      measure: () => Promise.resolve(measureRoot(root)),
      snapshot: () => Promise.resolve(snapshotRoot(root)),
      usage(props) {
        if (!component || typeof component.usage !== "function") return Promise.resolve(null);
        try {
          return Promise.resolve(String(component.usage(props)));
        } catch (error) {
          report(messageOf(error));
          return Promise.resolve(null);
        }
      },
      tokens(tokens) {
        for (const [name, value] of Object.entries(tokens.vars)) {
          if (value) element.style.setProperty(name, value);
          else element.style.removeProperty(name);
        }
        element.style.setProperty("color-scheme", tokens.scheme || "normal");
      },
      destroy() {
        teardown();
        element.remove();
      },
    };
  }

  function ensureStyle() {
    if (document.querySelector('style[data-t3kit="stage"]')) return;
    const style = document.createElement("style");
    style.dataset.t3kit = "stage";
    style.textContent = STYLE_TEXT;
    document.head.append(style);
  }

  function createStage(container, options) {
    if (!(container instanceof HTMLElement))
      throw new TypeError("create(container) needs an HTMLElement");
    const config = readOptions(options ?? {});
    ensureStyle();

    const frames = new Set();
    const listeners = { change: new Set(), select: new Set(), error: new Set() };
    let cells = new Map();
    const dirty = new Set();
    const waiters = [];
    let flushQueued = false;
    let themeQueued = 0;
    let themeSignature = "";
    let destroyed = false;
    let component = null; // { name, props, js, css, shadow, version }
    let codeVersion = 0;
    let assetUrls = {}; // name -> blob: URL, shadow cells
    let assetData = {}; // name -> data: URL, frame cells and export
    let blobToData = {};
    const shadowSheet = new CSSStyleSheet();
    let cssFrame = "";
    let background = config.background;
    let layout = { ...config.layout };
    let selected = null;
    let overlay = null; // { url, owned, opacity }

    // ---- DOM.
    const root = document.createElement("div");
    root.className = "t3k-stage-root";
    const bar = document.createElement("div");
    bar.className = "t3k-stage-bar";
    const segment = document.createElement("div");
    segment.className = "t3k-stage-seg";
    segment.setAttribute("role", "group");
    segment.setAttribute("aria-label", "Background");
    const backgroundButtons = BACKGROUNDS.map((name) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "t3k-stage-btn";
      button.textContent = BACKGROUND_LABEL[name];
      button.addEventListener("click", () => pickBackground(name));
      segment.append(button);
      return { name, button };
    });
    const overlayControl = document.createElement("label");
    overlayControl.className = "t3k-stage-overlay-ctl";
    overlayControl.append("Overlay opacity ");
    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.min = "0";
    opacity.max = "1";
    opacity.step = "0.01";
    opacity.className = "t3k-stage-opacity";
    opacity.addEventListener("input", () => {
      if (!overlay) return;
      overlay.opacity = Number(opacity.value);
      paintAll();
      emit("change", get());
    });
    overlayControl.append(opacity);
    bar.append(segment, overlayControl);
    const grid = document.createElement("div");
    grid.className = "t3k-stage-grid";
    root.append(bar, grid);
    container.append(root);

    const narrowObserver = new ResizeObserver((entries) =>
      root.toggleAttribute("data-narrow", entries[0].contentRect.width < NARROW_PX),
    );
    narrowObserver.observe(container);
    const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
    const themeObserver = new MutationObserver(scheduleTheme);
    themeObserver.observe(document.documentElement, { attributes: true });
    themeObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    themeMedia.addEventListener("change", scheduleTheme);
    window.addEventListener("message", onWindowMessage);

    function onWindowMessage(event) {
      if (!event.data || event.data.t3k !== "stage") return;
      for (const frame of frames) {
        if (frame.iframe.contentWindow === event.source) frame.handle(event.data);
      }
    }

    function applyLayout() {
      grid.setAttribute("data-cols", String(layout.cols));
      if (layout.cols === "auto") grid.style.removeProperty("--t3k-stage-cols");
      else grid.style.setProperty("--t3k-stage-cols", `repeat(${layout.cols}, minmax(0, 1fr))`);
      grid.style.setProperty("--t3k-stage-gap", `${layout.gap}px`);
    }

    function paintBar() {
      for (const { name, button } of backgroundButtons)
        button.setAttribute("aria-pressed", String(name === background));
      overlayControl.hidden = !overlay;
      if (overlay) opacity.value = String(overlay.opacity);
    }

    function paintCell(cell) {
      const { figure, label, stateSelect, well, body, overlayImg, error } = cell.dom;
      figure.style.order = String(cell.order);
      label.textContent = cell.label ?? cell.id;
      label.setAttribute("aria-pressed", String(selected === cell.id));
      stateSelect.value = cell.state;
      well.setAttribute("data-bg", background);
      body.style.width = cell.width ? `${cell.width}px` : "100%";
      figure.toggleAttribute("data-fixed", cell.width !== null);
      if (cell.width !== null)
        figure.style.setProperty("--t3k-stage-w", `${cell.width + WELL_INSET_PX}px`);
      overlayImg.hidden = !overlay;
      if (overlay) {
        overlayImg.src = overlay.url;
        overlayImg.style.opacity = String(overlay.opacity);
      }
      error.hidden = cell.errors.length === 0;
      error.textContent = cell.errors.join("\n");
    }

    function paintAll() {
      paintBar();
      for (const cell of cells.values()) paintCell(cell);
    }

    function buildCellDom(id) {
      const figure = document.createElement("figure");
      figure.className = "t3k-stage-cell";
      figure.dataset.cellId = id;
      const head = document.createElement("div");
      head.className = "t3k-stage-head";
      const label = document.createElement("button");
      label.type = "button";
      label.className = "t3k-stage-label";
      label.addEventListener("click", () => select(id));
      const stateSelect = document.createElement("select");
      stateSelect.className = "t3k-stage-state";
      stateSelect.setAttribute("aria-label", `State of ${id}`);
      for (const name of STATES) stateSelect.append(new Option(name, name));
      stateSelect.addEventListener("change", () => {
        const cell = cells.get(id);
        cell.state = oneOf(stateSelect.value, STATES, "state");
        scheduleRender([id]);
        emit("change", get());
      });
      head.append(label, stateSelect);
      const well = document.createElement("div");
      well.className = "t3k-stage-well";
      const body = document.createElement("div");
      body.className = "t3k-stage-body";
      const overlayImg = document.createElement("img");
      overlayImg.className = "t3k-stage-overlay";
      overlayImg.alt = "";
      overlayImg.hidden = true;
      body.append(overlayImg);
      well.append(body);
      const error = document.createElement("p");
      error.className = "t3k-stage-error";
      error.setAttribute("role", "alert");
      error.hidden = true;
      figure.append(head, well, error);
      grid.append(figure);
      return { figure, label, stateSelect, well, body, overlayImg, error };
    }

    // ---- Cells and renders. Work is batched: a dirty set, flushed once per animation frame.

    function scheduleRender(ids) {
      for (const id of ids) dirty.add(id);
      if (ids.length === 0) return Promise.resolve();
      if (!flushQueued) {
        flushQueued = true;
        requestAnimationFrame(flush);
      }
      return new Promise((resolve) => waiters.push(resolve));
    }

    function flush() {
      flushQueued = false;
      try {
        if (destroyed) return;
        const ids = [...dirty];
        dirty.clear();
        for (const id of ids) {
          const cell = cells.get(id);
          if (cell) renderCell(cell);
        }
      } finally {
        for (const resolve of waiters.splice(0)) resolve();
      }
    }

    function reportCell(cell, message) {
      cell.errors.push(message);
      paintCell(cell);
      emit("error", { cellId: cell.id, message });
    }

    function makeView(cell) {
      const report = (message) => reportCell(cell, message);
      const view =
        config.mode === "shadow"
          ? createShadowView(shadowSheet, report)
          : createFrameView(frames, report);
      cell.dom.body.replaceChildren(view.element, cell.dom.overlayImg);
      view.tokens(readTokens(config.theme));
      return view;
    }

    function renderCell(cell) {
      cell.errors = [];
      if (!component) {
        cell.errors.push("No component loaded. Call load({ js }) first.");
        paintCell(cell);
        return;
      }
      if (!cell.view) cell.view = makeView(cell);
      if (cell.view.version !== component.version) {
        const shadowMode = config.mode === "shadow";
        cell.view.code({
          version: component.version,
          js: component.js,
          component: component.shadow,
          css: cssFrame,
          assets: shadowMode ? assetUrls : assetData,
        });
      }
      cell.view.render({ props: effectiveProps(cell), force: FORCE_OF[cell.state] ?? null });
      paintCell(cell);
    }

    function destroyCell(cell) {
      cell.view?.destroy();
      cell.view = null;
      cell.dom.figure.remove();
    }

    function invalidateViews() {
      for (const cell of cells.values()) {
        cell.view?.destroy();
        cell.view = null;
        dirty.add(cell.id);
      }
    }

    function requireCell(id) {
      const cell = cells.get(id);
      if (!cell) throw new Error(`no cell "${id}": call setCells() first`);
      return cell;
    }

    function setCells(list) {
      if (!Array.isArray(list)) throw new TypeError("setCells(cells) expects an array");
      const schema = component?.props ?? {};
      const seen = new Set();
      const specs = list.map((spec, index) => {
        const where = `cells[${index}]`;
        if (!spec || typeof spec !== "object") throw new TypeError(`${where} must be an object`);
        if (typeof spec.id !== "string" || spec.id === "")
          throw new TypeError(`${where}.id must be a non-empty string`);
        if (seen.has(spec.id)) throw new TypeError(`${where}.id "${spec.id}" is used twice`);
        seen.add(spec.id);
        const state = oneOf(spec.state ?? "default", STATES, `${where}.state`);
        const width = spec.width ?? null;
        if (width !== null && !(Number.isFinite(width) && width > 0))
          throw new TypeError(`${where}.width must be a positive number of pixels`);
        const label = spec.label ?? null;
        if (label !== null && typeof label !== "string")
          throw new TypeError(`${where}.label must be text`);
        return {
          id: spec.id,
          state,
          width,
          label,
          props: mergeProps(schema, spec.props ?? {}, where),
          order: index,
        };
      });
      const next = new Map();
      for (const spec of specs) {
        const cell = cells.get(spec.id) ?? {
          id: spec.id,
          view: null,
          errors: [],
          dom: buildCellDom(spec.id),
        };
        Object.assign(cell, spec);
        next.set(spec.id, cell);
      }
      for (const [id, cell] of cells) if (!next.has(id)) destroyCell(cell);
      cells = next;
      if (selected !== null && !cells.has(selected)) selected = null;
      paintAll();
      return scheduleRender([...next.keys()]);
    }

    function update(id, props) {
      const cell = requireCell(id);
      cell.props = mergeProps(
        component?.props ?? {},
        { ...cell.props, ...props },
        `update("${id}")`,
      );
      return scheduleRender([id]);
    }

    // ---- Assets, components and themes.

    function describeShadow(js) {
      const found = evaluateComponent(js);
      return { name: found.name, props: found.props, css: found.css, component: found };
    }

    function probeFrame(js) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer = 0;
        const finish = (settle) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          probe.destroy();
          settle();
        };
        const probe = createFrame(frames, (data) => {
          if (data.type === "component")
            finish(() =>
              resolve({ name: data.name, props: validateSchema(data.props), css: data.css }),
            );
          else if (data.type === "error") finish(() => reject(new Error(data.message)));
        });
        timer = setTimeout(
          () =>
            finish(() =>
              reject(new Error(`the component did not load within ${FRAME_TIMEOUT_MS} ms`)),
            ),
          FRAME_TIMEOUT_MS,
        );
        probe.iframe.hidden = true;
        root.append(probe.iframe);
        probe.send({ type: "code", version: 0, js, css: "", assets: {} });
      });
    }

    async function load(spec) {
      if (!spec || typeof spec !== "object")
        throw new TypeError("load({ js, css?, assets? }) expects an object");
      const js = await textOf(spec.js, "js");
      const ownCss = spec.css === undefined ? "" : await textOf(spec.css, "css");
      const assets = spec.assets ?? {};
      for (const [name, blob] of Object.entries(assets)) {
        if (!(blob instanceof Blob)) throw new TypeError(`assets["${name}"] must be a Blob`);
      }
      const found = config.mode === "shadow" ? describeShadow(js) : await probeFrame(js);
      const merged = [...cells.values()].map((cell) => [
        cell,
        mergeProps(found.props, cell.props, `cells[${cell.id}]`),
      ]);
      const dataUrls = {};
      for (const [name, blob] of Object.entries(assets)) dataUrls[name] = await readAsDataUrl(blob);

      for (const url of Object.values(assetUrls)) URL.revokeObjectURL(url);
      assetUrls = {};
      assetData = dataUrls;
      blobToData = {};
      for (const name of Object.keys(assets)) {
        assetUrls[name] = URL.createObjectURL(assets[name]);
        blobToData[assetUrls[name]] = dataUrls[name];
      }
      const css = [ownCss, found.css].join("\n");
      codeVersion += 1;
      component = {
        name: found.name,
        props: found.props,
        js,
        css,
        shadow: found.component ?? null,
        version: codeVersion,
      };
      shadowSheet.replaceSync(
        `:host{display:block;min-width:0}\n${forceStates(rewriteUrls(css, assetUrls))}`,
      );
      cssFrame = forceStates(rewriteUrls(css, assetData));
      for (const [cell, props] of merged) cell.props = props;
      invalidateViews();
      scheduleRender([...cells.keys()]);
      return { name: found.name, props: found.props };
    }

    function readThemeAndPaint() {
      const tokens = readTokens(config.theme);
      const signature = JSON.stringify(tokens);
      if (signature === themeSignature) return;
      themeSignature = signature;
      for (const cell of cells.values()) cell.view?.tokens(tokens);
    }

    function scheduleTheme() {
      if (destroyed || themeQueued) return;
      themeQueued = requestAnimationFrame(() => {
        themeQueued = 0;
        readThemeAndPaint();
      });
    }

    // ---- Overlay, background and layout.

    function clearOverlay() {
      if (overlay?.owned) URL.revokeObjectURL(overlay.url);
      overlay = null;
    }

    function setOverlay(value) {
      if (value === null) {
        clearOverlay();
        paintAll();
        return;
      }
      const isSource = value instanceof Blob || typeof value === "string" || value instanceof URL;
      const source = isSource ? { src: value } : value;
      if (!source || typeof source !== "object")
        throw new TypeError("overlay must be a Blob, a URL or { src, opacity }");
      const next = source.opacity ?? overlay?.opacity ?? 0.5;
      if (!(Number.isFinite(next) && next >= 0 && next <= 1))
        throw new TypeError("overlay.opacity must be from 0 to 1");
      if (source.src === undefined) {
        if (!overlay) throw new TypeError("overlay needs src the first time it is set");
        overlay.opacity = next;
      } else {
        if (
          !(
            source.src instanceof Blob ||
            typeof source.src === "string" ||
            source.src instanceof URL
          )
        ) {
          throw new TypeError("overlay.src must be a Blob or a URL");
        }
        clearOverlay();
        const owned = source.src instanceof Blob;
        overlay = {
          url: owned ? URL.createObjectURL(source.src) : String(source.src),
          owned,
          opacity: next,
        };
      }
      paintAll();
    }

    function pickBackground(name) {
      background = name;
      paintAll();
      emit("change", get());
    }

    function select(id) {
      selected = id;
      paintAll();
      emit("select", id);
    }

    // ---- Probe, measure, usage and export.

    function flushNow() {
      flush();
    }

    async function measure(id) {
      const cell = requireCell(id);
      flushNow();
      if (!cell.view)
        return { width: 0, height: 0, overflowX: false, overflowing: [], errors: [...cell.errors] };
      const result = await cell.view.measure();
      return { ...result, errors: [...cell.errors] };
    }

    async function usage(id) {
      const cell = requireCell(id);
      flushNow();
      if (!cell.view) return null;
      return cell.view.usage(effectiveProps(cell));
    }

    function inlineForExport(html) {
      let out = html;
      for (const [blobUrl, dataUrl] of Object.entries(blobToData))
        out = out.split(blobUrl).join(dataUrl);
      if (/(?:src|poster)\s*=\s*["']?(?:https?:|blob:)|url\(\s*["']?(?:https?:|blob:)/i.test(out)) {
        throw new Error("an element points outside the cell and cannot be inlined");
      }
      return out;
    }

    function exportCss() {
      const css = `${tokensCss(readTokens(true), ".t3k-stage-well")}\n.t3k-stage-well{font:14px/1.5 var(--font-sans);color:var(--foreground)}\n${STYLE_TEXT}\n${cssFrame}`;
      if (/@import|url\(\s*["']?(?:https?:|blob:)/i.test(css))
        throw new Error("component css points outside the cell and cannot be inlined");
      return css;
    }

    async function snapshotCell(cell) {
      if (!cell.view) throw new Error(`cell "${cell.id}" has not rendered`);
      const shot = await cell.view.snapshot();
      return { width: shot.width, height: shot.height, html: inlineForExport(shot.html) };
    }

    async function composePng(shots, scale) {
      const columns = layout.cols === "auto" ? Math.min(shots.length, 3) : layout.cols;
      const colWidths = [];
      const rowHeights = [];
      shots.forEach((shot, i) => {
        const col = i % columns;
        const row = Math.floor(i / columns);
        colWidths[col] = Math.max(colWidths[col] ?? 0, shot.width);
        rowHeights[row] = Math.max(rowHeights[row] ?? 0, shot.height);
      });
      const xs = [];
      let x = 0;
      colWidths.forEach((w, c) => {
        xs[c] = x;
        x += w + layout.gap;
      });
      const ys = [];
      let y = 0;
      rowHeights.forEach((h, r) => {
        ys[r] = y;
        y += h + layout.gap;
      });
      const width = x - layout.gap;
      const height = y - layout.gap;
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      const page = readTokens(true).vars["--background"];
      if (page) {
        ctx.fillStyle = page;
        ctx.fillRect(0, 0, width, height);
      }
      const css = exportCss();
      for (let i = 0; i < shots.length; i++) {
        const shot = shots[i];
        const image = await loadSvgImage(cellSvg(shot, css, background));
        ctx.drawImage(image, xs[i % columns], ys[Math.floor(i / columns)], shot.width, shot.height);
      }
      return canvasToPng(canvas);
    }

    async function exportPng(opts = {}) {
      const scale = opts.scale ?? 2;
      if (!(Number.isFinite(scale) && scale > 0 && scale <= 4))
        throw new TypeError("scale must be a number from 0 to 4");
      try {
        if (!component) throw new Error("no component loaded");
        const ids = opts.cells ?? [...cells.keys()];
        if (ids.length === 0) throw new Error("no cells to export");
        flushNow();
        const shots = [];
        for (const id of ids) shots.push(await snapshotCell(requireCell(id)));
        return await composePng(shots, scale);
      } catch (error) {
        emit("error", { cellId: null, message: `exportPng: ${messageOf(error)}` });
        return null;
      }
    }

    // ---- State, events and lifetime.

    function get() {
      return {
        cells: [...cells.values()].map((cell) => ({
          id: cell.id,
          props: effectiveProps(cell),
          state: cell.state,
          width: cell.width,
          label: cell.label,
        })),
        background,
        layout: { ...layout },
        selected,
        overlay: overlay ? { opacity: overlay.opacity } : null,
      };
    }

    function set(partial) {
      if (!partial || typeof partial !== "object")
        throw new TypeError("set({ ... }) expects an object");
      let pending = Promise.resolve();
      for (const [key, value] of Object.entries(partial)) {
        if (key === "cells") pending = setCells(value);
        else if (key === "background") {
          background = oneOf(value, BACKGROUNDS, "background");
          paintAll();
        } else if (key === "layout") {
          layout = checkLayout({ ...layout, ...value });
          applyLayout();
          paintAll();
        } else if (key === "selected") {
          if (value !== null && !cells.has(value)) throw new Error(`no cell "${value}" to select`);
          selected = value;
          paintAll();
        } else if (key === "overlay") {
          setOverlay(value);
        } else {
          throw new TypeError(`set() does not know "${key}"`);
        }
      }
      return pending;
    }

    function emit(event, payload) {
      for (const callback of [...listeners[event]]) callback(payload);
    }

    function on(event, callback) {
      if (!Object.hasOwn(listeners, event))
        throw new TypeError(`on() knows change, select and error, not "${event}"`);
      if (typeof callback !== "function")
        throw new TypeError("on(event, callback) needs a function");
      listeners[event].add(callback);
      return () => listeners[event].delete(callback);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const cell of cells.values()) destroyCell(cell);
      cells = new Map();
      clearOverlay();
      for (const url of Object.values(assetUrls)) URL.revokeObjectURL(url);
      window.removeEventListener("message", onWindowMessage);
      themeObserver.disconnect();
      themeMedia.removeEventListener("change", scheduleTheme);
      narrowObserver.disconnect();
      root.remove();
      for (const name of Object.keys(listeners)) listeners[name].clear();
      for (const resolve of waiters.splice(0)) resolve();
    }

    applyLayout();
    if (config.overlay !== null) setOverlay(config.overlay);
    paintAll();
    readThemeAndPaint();

    return {
      load,
      setCells,
      update,
      setOverlay,
      get,
      set,
      measure,
      usage,
      exportPng,
      on,
      destroy,
    };
  }

  t3kit.stage = {
    create(container, options) {
      return createStage(container, options);
    },
  };
})();
