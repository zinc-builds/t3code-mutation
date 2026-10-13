/**
 * t3kit.propsform: typed control form generated from a props schema: collapsible group sections, changed dots,
 * per-field reset, live validation. Numbers: slider + numeric field; boolean: switch; enum: radio segments (4 or fewer
 * values) or a select; string: input; text: textarea; color: swatch + hex field (also accepts var(--token)).
 * create(container, { schema, value?, compact? = false }) -> instance. Fills the container's width.
 *   schema  { [key]: { type, default, min?, max?, step?, unit?, enum?, label?, description?, group? } }; a typo'd
 *           option throws. Or JSON Schema { properties } with title, description, minimum, maximum, multipleOf, enum,
 *           format 'color' | 'textarea', x-group, x-unit (a string with enum is an enum). Every field needs a valid
 *           default. Without min/max the slider spans 0 to max(100, 2 x default) and grows with the value.
 *           Step defaults to 1 (integer) or range / 100 rounded to a power of ten. Groups render in schema order.
 *   value   partial starting values.   compact  24px rows, descriptions move to the label tooltip.
 * Instance
 *   get()                    -> { values, changed: [keys whose value !== default] }. Export: get().values as JSON.
 *   set({ values?, schema? }) silent. Unknown keys throw. Invalid values are kept and reported by validate().
 *                             A new schema replaces the form and keeps the values that still validate.
 *   reset(key?)              one field or all back to default. Silent, like set().
 *   validate()               -> [{ key, message }] (out of range, wrong type, not in enum, bad colour).
 *   focus(key)               opens the field's section and focuses its control.
 *   on(event, cb) -> unsubscribe.   destroy() removes DOM, timers and listeners.
 * Events
 *   'change'  get(); every user edit, at most once per frame during drags.
 *   'commit'  { key, value }; once per finished user action: slider release, Enter, blur, 500 ms typing pause, an
 *             arrow or wheel burst, a toggle, a pick, a reset button or Alt+click. Typed numbers clamp into range on
 *             commit; unparseable text never commits. Link history to 'commit', not 'change'.
 * Keys: Tab moves field to field (one stop each; a changed field adds its reset button). ArrowUp/Down step a
 *   number (Shift or PageUp/PageDown x10). Enter commits (Ctrl/Cmd+Enter in a textarea). Wheel steps the focused
 *   number (Shift x10); the page scrolls normally over unfocused rows. Alt+click a label resets that field.
 * DOM hooks: rows carry data-propsform-key and data-changed; sections carry data-propsform-group.
 * Usage:
 *   const pf = t3kit.propsform.create(el, { schema: {
 *     size: { type: 'integer', default: 16, min: 8, max: 96, unit: 'px', group: 'Type' },
 *     tone: { type: 'enum', enum: ['neutral', 'brand'], default: 'neutral', group: 'Color' } } });
 *   pf.on('change', ({ values }) => preview(values));
 *   pf.on('commit', ({ key, value }) => history.commit(`${key}: ${value}`));
 *   pf.set({ values: { size: 24 } }); // silent
 */
(function () {
  "use strict";
  const t3kit = (window.t3kit = window.t3kit || {});

  const TYPES = new Set(["number", "integer", "boolean", "string", "text", "enum", "color"]);
  const SPEC_KEYS = new Set([
    "type",
    "default",
    "min",
    "max",
    "step",
    "unit",
    "enum",
    "label",
    "description",
    "group",
  ]);
  const JSON_SCHEMA_KEYS = new Set([
    "type",
    "properties",
    "required",
    "title",
    "description",
    "$schema",
    "$id",
    "additionalProperties",
  ]);
  const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
  const COLOR_RE = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|var\(--[a-z0-9-]+(,[^()]*)?\))$/i;
  const SETTLE_MS = 500;
  const WHEEL_PX = 100;
  const STEP_DIR = new Map([
    ["ArrowUp", 1],
    ["ArrowRight", 1],
    ["PageUp", 1],
    ["ArrowDown", -1],
    ["ArrowLeft", -1],
    ["PageDown", -1],
  ]);

  const STYLE = `
.t3k-propsform-root{--t3k-propsform-h:28px;box-sizing:border-box;width:100%;min-width:0;font:400 12px/1.4 var(--font-sans);color:var(--foreground)}
.t3k-propsform-compact{--t3k-propsform-h:24px}
.t3k-propsform-root *,.t3k-propsform-root *::before,.t3k-propsform-root *::after{box-sizing:border-box}
.t3k-propsform-root [hidden]{display:none!important}
.t3k-propsform-section+.t3k-propsform-section{border-top:1px solid var(--border)}
.t3k-propsform-head{display:flex;align-items:center;gap:8px;width:100%;height:30px;margin:0;padding:0 10px;border:0;border-radius:0;background:transparent;color:var(--muted-foreground);font:600 11px/1 var(--font-sans);text-align:left;cursor:pointer}
.t3k-propsform-head:hover{color:var(--foreground)}
.t3k-propsform-head:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.t3k-propsform-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3k-propsform-count{color:var(--primary);font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.t3k-propsform-count:empty{display:none}
.t3k-propsform-chev{flex:none;width:6px;height:6px;margin:0 2px 2px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.t3k-propsform-head[aria-expanded="false"] .t3k-propsform-chev{margin-bottom:0;transform:rotate(-45deg)}
.t3k-propsform-body{display:grid;gap:2px;padding:0 10px 10px}
.t3k-propsform-compact .t3k-propsform-body{gap:0;padding-bottom:6px}
.t3k-propsform-root>.t3k-propsform-section:first-child>.t3k-propsform-body:first-child{padding-top:8px}
.t3k-propsform-row{position:relative;display:grid;grid-template-columns:minmax(0,38%) minmax(0,1fr);column-gap:10px;row-gap:2px;align-items:center;min-height:var(--t3k-propsform-h);padding:2px 0}
.t3k-propsform-wide{grid-template-columns:minmax(0,1fr)}
.t3k-propsform-narrow .t3k-propsform-row{grid-template-columns:minmax(0,1fr)}
.t3k-propsform-label{display:flex;align-items:center;gap:6px;min-width:0;color:var(--muted-foreground);cursor:default;user-select:none}
.t3k-propsform-row[data-changed="true"]>.t3k-propsform-label{color:var(--foreground)}
.t3k-propsform-label-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3k-propsform-dot{display:none;flex:none;width:5px;height:5px;border-radius:50%;background:var(--primary)}
.t3k-propsform-row[data-changed="true"]>.t3k-propsform-label>.t3k-propsform-dot{display:inline-block}
.t3k-propsform-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.t3k-propsform-desc,.t3k-propsform-error{grid-column:1/-1;margin:0;font-size:11px;line-height:1.35}
.t3k-propsform-desc{color:var(--muted-foreground)}
.t3k-propsform-error{color:var(--destructive)}
.t3k-propsform-control{display:flex;align-items:center;gap:6px;min-width:0}
.t3k-propsform-control>*:not(.t3k-propsform-reset){flex:1 1 auto;min-width:0}
.t3k-propsform-control>.t3k-propsform-switch,.t3k-propsform-control>.t3k-propsform-swatch{flex:none}
.t3k-propsform-spacer{flex:1 1 auto}
.t3k-propsform-reset{flex:none;display:inline-grid;place-items:center;width:20px;height:20px;margin:0;padding:0;border:0;border-radius:calc(var(--radius) - 6px);background:transparent;color:var(--muted-foreground);font:500 13px/1 var(--font-sans);cursor:pointer}
.t3k-propsform-reset:hover:not(:disabled){background:var(--muted);color:var(--foreground)}
.t3k-propsform-reset:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.t3k-propsform-reset:disabled{visibility:hidden}
.t3k-propsform-num{display:flex;align-items:center;gap:8px;min-width:0}
.t3k-propsform-num>*{flex:none}
.t3k-propsform-num>.t3k-propsform-range{flex:1 1 auto;min-width:48px}
.t3k-propsform-range{-webkit-appearance:none;appearance:none;height:var(--t3k-propsform-h);margin:0;padding:0;background:transparent;cursor:pointer;--t3k-propsform-p:50%}
.t3k-propsform-range:focus{outline:none}
.t3k-propsform-range::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:linear-gradient(to right,var(--primary) var(--t3k-propsform-p),color-mix(in srgb,var(--foreground) 18%,transparent) var(--t3k-propsform-p))}
.t3k-propsform-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;margin-top:-4px;border:0;border-radius:50%;background:var(--foreground);box-shadow:0 0 0 2px var(--background)}
.t3k-propsform-range:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 2px var(--background),0 0 0 4px var(--ring)}
.t3k-propsform-range::-moz-range-track{height:4px;border-radius:999px;background:color-mix(in srgb,var(--foreground) 18%,transparent)}
.t3k-propsform-range::-moz-range-progress{height:4px;border-radius:999px;background:var(--primary)}
.t3k-propsform-range::-moz-range-thumb{width:12px;height:12px;border:0;border-radius:50%;background:var(--foreground)}
.t3k-propsform-field{height:var(--t3k-propsform-h);min-width:0;margin:0;padding:0 7px;border:1px solid var(--input);border-radius:calc(var(--radius) - 4px);background:var(--muted);color:var(--foreground);font:400 12px/1 var(--font-sans);outline:none;transition:border-color .12s ease,box-shadow .12s ease}
.t3k-propsform-field:focus-visible{border-color:var(--ring);box-shadow:0 0 0 1px var(--ring)}
.t3k-propsform-field[aria-invalid="true"]{border-color:var(--destructive)}
.t3k-propsform-num-field{width:64px;flex:none;text-align:right;font-family:var(--font-mono);font-size:11px;font-variant-numeric:tabular-nums}
.t3k-propsform-hex{font-family:var(--font-mono);font-size:11px}
.t3k-propsform-unit{flex:none;min-width:14px;color:var(--muted-foreground);font-size:11px}
.t3k-propsform-input{width:100%}
.t3k-propsform-area{display:block;width:100%;height:auto;min-height:60px;padding:6px 7px;line-height:1.4;resize:vertical}
.t3k-propsform-select{height:var(--t3k-propsform-h);width:100%;min-width:0;padding:0 6px;border:1px solid var(--input);border-radius:calc(var(--radius) - 4px);background:var(--muted);color:var(--foreground);font:400 12px var(--font-sans);outline:none}
.t3k-propsform-select:focus-visible{border-color:var(--ring);box-shadow:0 0 0 1px var(--ring)}
.t3k-propsform-switch{position:relative;display:inline-flex;align-items:center;width:30px;height:18px;cursor:pointer}
.t3k-propsform-switch>input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.t3k-propsform-track{position:relative;display:block;width:30px;height:18px;border-radius:999px;background:var(--input);transition:background .14s ease;pointer-events:none}
.t3k-propsform-track::after{content:"";position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:var(--muted-foreground);transition:transform .14s ease,background .14s ease}
.t3k-propsform-switch>input:checked+.t3k-propsform-track{background:var(--primary)}
.t3k-propsform-switch>input:checked+.t3k-propsform-track::after{background:var(--primary-foreground);transform:translateX(12px)}
.t3k-propsform-switch>input:focus-visible+.t3k-propsform-track{outline:2px solid var(--ring);outline-offset:2px}
.t3k-propsform-seg{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:2px;padding:2px;border:1px solid var(--input);border-radius:calc(var(--radius) - 2px);background:var(--muted)}
.t3k-propsform-opt{position:relative;display:flex;align-items:center;justify-content:center;min-width:0;height:calc(var(--t3k-propsform-h) - 6px);padding:0 6px;border-radius:calc(var(--radius) - 4px);color:var(--muted-foreground);cursor:pointer;transition:color .12s ease,background .12s ease}
.t3k-propsform-opt:hover{color:var(--foreground)}
.t3k-propsform-opt>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3k-propsform-opt>input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.t3k-propsform-opt:has(>input:checked){background:var(--card);color:var(--foreground);box-shadow:0 0 0 1px var(--input)}
.t3k-propsform-opt:has(>input:focus-visible){outline:2px solid var(--ring);outline-offset:1px}
.t3k-propsform-swatch{position:relative;width:calc(var(--t3k-propsform-h) - 4px);height:calc(var(--t3k-propsform-h) - 4px);border:1px solid var(--input);border-radius:calc(var(--radius) - 5px);overflow:hidden;background-color:var(--muted)}
.t3k-propsform-picker{position:absolute;inset:-4px;width:calc(100% + 8px);height:calc(100% + 8px);margin:0;padding:0;border:0;opacity:0;cursor:pointer}
`;

  let instances = 0;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function ensureStyle() {
    if (document.head.querySelector('style[data-t3kit="propsform"]')) return;
    const style = el("style");
    style.dataset.t3kit = "propsform";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function decimalsOf(n) {
    const s = String(n);
    const e = s.indexOf("e-");
    if (e >= 0) return Number(s.slice(e + 2)) + (s.slice(0, e).split(".")[1] || "").length;
    return (s.split(".")[1] || "").length;
  }

  function roundTo(n, decimals) {
    return Number(n.toFixed(Math.min(12, decimals)));
  }

  function humanize(key) {
    const spaced = key
      .replace(/[_-]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .trim();
    return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  const isNumeric = (f) => f.type === "number" || f.type === "integer";
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  function problemOf(f, v) {
    switch (f.type) {
      case "number":
      case "integer":
        if (typeof v !== "number" || !Number.isFinite(v)) return "Enter a number.";
        if (f.type === "integer" && !Number.isInteger(v)) return "Enter a whole number.";
        if (f.min !== undefined && v < f.min) return `Must be at least ${f.min}.`;
        if (f.max !== undefined && v > f.max) return `Must be at most ${f.max}.`;
        return null;
      case "boolean":
        return typeof v === "boolean" ? null : "Expected true or false.";
      case "enum":
        return f.options.includes(v) ? null : `Pick one of ${f.options.map(String).join(", ")}.`;
      case "color":
        return typeof v === "string" && COLOR_RE.test(v.trim())
          ? null
          : "Expected a hex colour or a var() CSS variable.";
      default:
        return typeof v === "string" ? null : "Expected text.";
    }
  }

  // Normalised field: key, type, def, label, description, group, unit, min, max (validation), lo, hi (slider), step.
  function buildField(key, raw) {
    let type = raw.enum !== undefined ? "enum" : raw.type;
    if (type === "string" && raw.format === "color") type = "color";
    if (type === "string" && (raw.format === "textarea" || raw.control === "text")) type = "text";
    if (!TYPES.has(type))
      throw new TypeError(`propsform: field "${key}" has unknown type "${String(raw.type)}"`);
    if (raw.default === undefined) throw new TypeError(`propsform: field "${key}" needs a default`);
    if (type === "enum" && (!Array.isArray(raw.enum) || raw.enum.length === 0)) {
      throw new TypeError(`propsform: enum field "${key}" needs a non-empty enum array`);
    }
    const f = {
      key,
      type,
      def: raw.default,
      label: raw.label ?? humanize(key),
      description: raw.description ?? "",
      group: raw.group ?? null,
      unit: raw.unit ?? "",
      min: raw.min,
      max: raw.max,
      step: raw.step,
      options: type === "enum" ? raw.enum.slice() : null,
    };
    if (isNumeric(f)) {
      if (f.min !== undefined && f.max !== undefined && !(f.min <= f.max)) {
        throw new RangeError(`propsform: field "${key}" has min above max`);
      }
      if (f.step !== undefined && !(f.step > 0))
        throw new RangeError(`propsform: field "${key}" needs a step above 0`);
      const d = typeof f.def === "number" ? f.def : 0;
      f.lo = f.min ?? Math.min(0, d * 2);
      f.hi = f.max ?? Math.max(f.lo + 100, d * 2, 100);
      if (f.step === undefined)
        f.step = f.type === "integer" ? 1 : 10 ** Math.floor(Math.log10((f.hi - f.lo || 1) / 100));
    }
    const problem = problemOf(f, f.def);
    if (problem) throw new TypeError(`propsform: default of "${key}" is invalid: ${problem}`);
    return f;
  }

  function fromPlain(key, spec) {
    if (!isObject(spec)) throw new TypeError(`propsform: field "${key}" must be an object`);
    for (const option of Object.keys(spec)) {
      if (!SPEC_KEYS.has(option)) {
        throw new TypeError(
          `propsform: field "${key}" has unknown option "${option}"; options are ${[...SPEC_KEYS].join(", ")}`,
        );
      }
    }
    return buildField(key, spec);
  }

  function fromJson(key, spec) {
    if (!isObject(spec)) throw new TypeError(`propsform: property "${key}" must be an object`);
    return buildField(key, {
      type: spec.type,
      format: spec.format,
      control: spec["x-control"],
      default: spec.default,
      min: spec.minimum,
      max: spec.maximum,
      step: spec.multipleOf,
      unit: spec["x-unit"],
      enum: spec.enum,
      label: spec.title,
      description: spec.description,
      group: spec["x-group"],
    });
  }

  function normalizeSchema(schema) {
    if (!isObject(schema)) throw new TypeError("propsform: schema must be an object");
    const json =
      schema.type === "object" ||
      (isObject(schema.properties) && Object.keys(schema).every((k) => JSON_SCHEMA_KEYS.has(k)));
    if (json && !isObject(schema.properties))
      throw new TypeError("propsform: JSON Schema needs a properties object");
    const entries = Object.entries(json ? schema.properties : schema);
    if (entries.length === 0) throw new TypeError("propsform: schema has no fields");
    return entries.map(([key, spec]) => (json ? fromJson(key, spec) : fromPlain(key, spec)));
  }

  function clampNum(f, n) {
    if (f.min !== undefined && n < f.min) return f.min;
    if (f.max !== undefined && n > f.max) return f.max;
    return n;
  }

  function parseTyped(f, raw) {
    const text = raw.trim();
    if (isNumeric(f)) {
      if (!NUMBER_RE.test(text)) return { ok: false, message: "Enter a number." };
      const n = Number(text);
      if (f.type === "integer" && !Number.isInteger(n))
        return { ok: false, message: "Enter a whole number." };
      return { ok: true, value: n };
    }
    if (f.type === "color") {
      return COLOR_RE.test(text)
        ? { ok: true, value: text }
        : { ok: false, message: "Expected a hex colour or a var() CSS variable." };
    }
    return { ok: true, value: raw };
  }

  // Resolves a colour to #rrggbb for the native picker; var(--token) is read through the probe's computed style.
  function toHex(value, probe) {
    if (typeof value !== "string" || !COLOR_RE.test(value)) return null;
    if (value.startsWith("#")) {
      const digits = value.slice(1).toLowerCase();
      return digits.length <= 4
        ? `#${[...digits.slice(0, 3)].map((c) => c + c).join("")}`
        : `#${digits.slice(0, 6)}`;
    }
    probe.style.color = value;
    const parts = getComputedStyle(probe).color.match(/[\d.]+/g);
    probe.style.color = "";
    if (!parts || parts.length < 3) return null;
    return `#${parts
      .slice(0, 3)
      .map((p) => Math.round(Number(p)).toString(16).padStart(2, "0"))
      .join("")}`;
  }

  function create(container, options) {
    if (!(container instanceof HTMLElement))
      throw new TypeError("propsform.create: container must be an HTMLElement");
    if (!isObject(options) || options.schema === undefined)
      throw new TypeError("propsform.create: options.schema is required");
    for (const key of Object.keys(options)) {
      if (!["schema", "value", "compact"].includes(key))
        throw new TypeError(`propsform.create: unknown option "${key}"`);
    }
    ensureStyle();

    const uid = `t3k-pf-${++instances}`;
    const compact = Boolean(options.compact);
    const listeners = { change: new Set(), commit: new Set() };
    const views = new Map();
    const sections = [];
    const openState = new Map();
    const dirty = new Set();
    const settleTimers = new Map();
    let fields = [];
    let fieldMap = new Map();
    let values = {};
    let changeFrame = 0;
    let seq = 0;

    const root = el("div", `t3k-propsform-root${compact ? " t3k-propsform-compact" : ""}`);
    container.appendChild(root);
    const resizeObserver = new ResizeObserver(() =>
      root.classList.toggle("t3k-propsform-narrow", root.clientWidth < 260),
    );
    resizeObserver.observe(root);

    function emit(name, payload) {
      for (const callback of [...listeners[name]]) callback(payload);
    }

    function unknownKey(key) {
      return new TypeError(
        `propsform: unknown key "${key}"; keys are ${fields.map((f) => f.key).join(", ")}`,
      );
    }

    function assertKnown(patch, known) {
      if (!isObject(patch))
        throw new TypeError("propsform: values must be an object of key: value");
      for (const key of Object.keys(patch)) if (!known.has(key)) throw unknownKey(key);
    }

    function get() {
      const out = {};
      const changed = [];
      for (const f of fields) {
        out[f.key] = values[f.key];
        if (values[f.key] !== f.def) changed.push(f.key);
      }
      return { values: out, changed };
    }

    function forgetPending(key) {
      clearTimeout(settleTimers.get(key));
      settleTimers.delete(key);
      dirty.delete(key);
    }

    function adopt(nextFields, previous) {
      if (new Set(nextFields.map((f) => f.key)).size !== nextFields.length)
        throw new TypeError("propsform: duplicate keys");
      const nextValues = {};
      for (const f of nextFields) {
        const prev = previous[f.key];
        nextValues[f.key] = prev !== undefined && problemOf(f, prev) === null ? prev : f.def;
      }
      for (const key of [...settleTimers.keys()]) forgetPending(key);
      dirty.clear();
      fields = nextFields;
      fieldMap = new Map(nextFields.map((f) => [f.key, f]));
      values = nextValues;
    }

    function setOpen(section, open) {
      section.body.hidden = !open;
      if (section.head) section.head.setAttribute("aria-expanded", String(open));
      if (section.title !== null) openState.set(section.title, open);
    }

    function renderSection(title, list) {
      const bodyId = `${uid}-s${++seq}`;
      const section = {
        title,
        el: el("section", "t3k-propsform-section"),
        body: el("div", "t3k-propsform-body"),
        head: null,
        count: null,
        keys: list.map((f) => f.key),
      };
      section.body.id = bodyId;
      if (title !== null) {
        section.el.dataset.propsformGroup = String(title);
        const head = el("button", "t3k-propsform-head");
        const count = el("span", "t3k-propsform-count");
        const chevron = el("span", "t3k-propsform-chev");
        chevron.setAttribute("aria-hidden", "true");
        head.type = "button";
        head.setAttribute("aria-controls", bodyId);
        head.append(el("span", "t3k-propsform-title", String(title)), count, chevron);
        head.addEventListener("click", () =>
          setOpen(section, head.getAttribute("aria-expanded") !== "true"),
        );
        section.el.appendChild(head);
        section.head = head;
        section.count = count;
      }
      for (const f of list) section.body.appendChild(renderField(f));
      section.el.appendChild(section.body);
      setOpen(section, title === null || openState.get(title) !== false);
      return section;
    }

    function textInput(id, cls) {
      const input = el("input", `t3k-propsform-field ${cls}`);
      input.type = "text";
      input.id = id;
      input.spellcheck = false;
      input.autocomplete = "off";
      return input;
    }

    function renderField(f) {
      const base = `${uid}-f${++seq}`;
      const wide = f.type === "text" || (f.type === "enum" && f.options.length <= 4);
      const row = el("div", `t3k-propsform-row${wide ? " t3k-propsform-wide" : ""}`);
      row.dataset.propsformKey = f.key;

      const label = el("label", "t3k-propsform-label");
      label.id = `${base}-l`;
      label.title = `${f.description && compact ? `${f.description} ` : ""}Alt+click to reset.`;
      const dot = el("span", "t3k-propsform-dot");
      dot.setAttribute("aria-hidden", "true");
      const sr = el("span", "t3k-propsform-sr");
      label.append(el("span", "t3k-propsform-label-text", f.label), dot, sr);

      const control = el("div", "t3k-propsform-control");
      const view = {
        f,
        row,
        label,
        sr,
        control,
        error: el("p", "t3k-propsform-error"),
        typedError: null,
        wheel: 0,
        text: null,
        slider: null,
        check: null,
        radios: null,
        select: null,
        swatch: null,
        picker: null,
        focusEl: null,
        aria: null,
        reset: null,
      };
      view.error.id = `${base}-e`;
      view.error.setAttribute("aria-live", "polite");
      view.error.hidden = true;
      const describedBy = [];
      let desc = null;
      if (!compact && f.description) {
        desc = el("p", "t3k-propsform-desc", f.description);
        desc.id = `${base}-d`;
        describedBy.push(desc.id);
      }
      describedBy.push(view.error.id);

      switch (f.type) {
        case "number":
        case "integer": {
          const wrap = el("div", "t3k-propsform-num");
          const slider = el("input", "t3k-propsform-range");
          slider.type = "range";
          slider.tabIndex = -1;
          slider.min = String(f.lo);
          slider.max = String(f.hi);
          slider.step = String(f.step);
          slider.setAttribute("aria-label", f.label);
          const text = textInput(base, "t3k-propsform-num-field");
          text.inputMode = "decimal";
          wrap.append(slider, text, el("span", "t3k-propsform-unit", f.unit));
          control.appendChild(wrap);
          Object.assign(view, { slider, text, focusEl: text, wrap });
          break;
        }
        case "boolean": {
          const toggle = el("label", "t3k-propsform-switch");
          const box = el("input");
          box.type = "checkbox";
          box.id = base;
          box.setAttribute("role", "switch");
          toggle.append(box, el("span", "t3k-propsform-track"));
          control.append(toggle, el("span", "t3k-propsform-spacer"));
          Object.assign(view, { check: box, focusEl: box });
          break;
        }
        case "enum": {
          if (wide) {
            const group = el("div", "t3k-propsform-seg");
            group.setAttribute("role", "radiogroup");
            group.setAttribute("aria-labelledby", label.id);
            view.radios = f.options.map((choice, i) => {
              const option = el("label", "t3k-propsform-opt");
              const input = el("input");
              input.type = "radio";
              input.name = base;
              input.value = String(i);
              option.append(input, el("span", null, String(choice)));
              group.appendChild(option);
              return input;
            });
            control.appendChild(group);
            view.aria = group;
          } else {
            const select = el("select", "t3k-propsform-select");
            select.id = base;
            f.options.forEach((choice, i) => {
              const option = el("option", null, String(choice));
              option.value = String(i);
              select.appendChild(option);
            });
            control.appendChild(select);
            Object.assign(view, { select, focusEl: select });
          }
          break;
        }
        case "text": {
          const area = el("textarea", "t3k-propsform-field t3k-propsform-area");
          area.rows = 3;
          area.spellcheck = false;
          area.id = base;
          control.appendChild(area);
          Object.assign(view, { text: area, focusEl: area });
          break;
        }
        case "color": {
          const swatch = el("span", "t3k-propsform-swatch");
          const picker = el("input", "t3k-propsform-picker");
          picker.type = "color";
          picker.tabIndex = -1;
          picker.setAttribute("aria-label", `Pick a colour for ${f.label}`);
          swatch.appendChild(picker);
          const field = textInput(base, "t3k-propsform-input t3k-propsform-hex");
          control.append(swatch, field);
          Object.assign(view, { swatch, picker, text: field, focusEl: field });
          break;
        }
        default: {
          const input = textInput(base, "t3k-propsform-input");
          control.appendChild(input);
          Object.assign(view, { text: input, focusEl: input });
        }
      }

      const reset = el("button", "t3k-propsform-reset", "↺");
      reset.type = "button";
      reset.title = "Reset to default";
      reset.setAttribute("aria-label", `Reset ${f.label} to default`);
      control.appendChild(reset);
      view.reset = reset;

      if (view.focusEl) label.htmlFor = view.focusEl.id;
      view.aria = view.aria ?? view.focusEl;
      view.aria.setAttribute("aria-describedby", describedBy.join(" "));

      row.append(label, control);
      if (desc) row.appendChild(desc);
      row.appendChild(view.error);
      views.set(f.key, view);
      wire(view);
      return row;
    }

    function renderForm() {
      views.clear();
      sections.length = 0;
      root.replaceChildren();
      const groups = new Map();
      for (const f of fields) {
        if (!groups.has(f.group)) groups.set(f.group, []);
        groups.get(f.group).push(f);
      }
      for (const [title, list] of groups) {
        const section = renderSection(title, list);
        sections.push(section);
        root.appendChild(section.el);
      }
      syncAll();
    }

    function scheduleChange() {
      if (changeFrame) return;
      changeFrame = requestAnimationFrame(() => {
        changeFrame = 0;
        emit("change", get());
      });
    }

    function flushChange() {
      if (!changeFrame) return;
      cancelAnimationFrame(changeFrame);
      changeFrame = 0;
      emit("change", get());
    }

    // A user edit: store, mark dirty, one 'change' per frame, repaint (never the text the user is typing).
    function setUser(key, value) {
      if (values[key] !== value) {
        values[key] = value;
        dirty.add(key);
        scheduleChange();
      }
      sync(key);
    }

    // End of a user action: clamp numbers into range, flush 'change', emit one 'commit'.
    function settle(key) {
      clearTimeout(settleTimers.get(key));
      settleTimers.delete(key);
      if (!dirty.has(key)) return;
      const f = fieldMap.get(key);
      if (isNumeric(f) && Number.isFinite(values[key])) {
        const clamped = clampNum(f, values[key]);
        if (clamped !== values[key]) {
          values[key] = clamped;
          scheduleChange();
        }
        sync(key, true);
      }
      dirty.delete(key);
      flushChange();
      emit("commit", { key, value: values[key] });
    }

    function settleSoon(key) {
      clearTimeout(settleTimers.get(key));
      settleTimers.set(
        key,
        setTimeout(() => settle(key), SETTLE_MS),
      );
    }

    function stepField(key, steps, coarse) {
      const f = fieldMap.get(key);
      const view = views.get(key);
      view.typedError = null;
      const current = values[key];
      const base = typeof current === "number" && Number.isFinite(current) ? current : f.def;
      const next = clampNum(
        f,
        roundTo(
          base + steps * f.step * (coarse ? 10 : 1),
          Math.max(decimalsOf(f.step), decimalsOf(base)),
        ),
      );
      if (next === current) return;
      setUser(key, next);
      sync(key, true);
      settleSoon(key);
    }

    function typeInto(view) {
      const parsed = parseTyped(view.f, view.text.value);
      view.typedError = parsed.ok ? null : parsed.message;
      if (!parsed.ok) {
        clearTimeout(settleTimers.get(view.f.key));
        sync(view.f.key);
        return;
      }
      setUser(view.f.key, parsed.value);
      settleSoon(view.f.key);
    }

    function commitTyped(view) {
      const parsed = parseTyped(view.f, view.text.value);
      view.typedError = null;
      if (parsed.ok) setUser(view.f.key, parsed.value);
      sync(view.f.key, true);
      settle(view.f.key);
    }

    function userReset(key) {
      views.get(key).typedError = null;
      setUser(key, fieldMap.get(key).def);
      sync(key, true);
      settle(key);
    }

    function wireNumber(view) {
      const { f, text, slider, wrap } = view;
      const key = f.key;
      text.addEventListener("input", () => typeInto(view));
      text.addEventListener("blur", () => commitTyped(view));
      const keys = (event, isSlider) => {
        const dir = STEP_DIR.get(event.key);
        if (
          dir !== undefined &&
          (isSlider ||
            !event.key.startsWith("Arrow") ||
            event.key === "ArrowUp" ||
            event.key === "ArrowDown")
        ) {
          event.preventDefault();
          stepField(key, dir, event.shiftKey || event.key.startsWith("Page"));
        } else if (event.key === "Enter" && !isSlider) {
          event.preventDefault();
          commitTyped(view);
        }
      };
      text.addEventListener("keydown", (event) => keys(event, false));
      slider.addEventListener("keydown", (event) => keys(event, true));
      slider.addEventListener("input", () => {
        view.typedError = null;
        setUser(key, Number(slider.value));
        sync(key, true);
      });
      slider.addEventListener("change", () => settle(key));
      slider.addEventListener("blur", () => settle(key));
      wrap.addEventListener(
        "wheel",
        (event) => {
          if (event.deltaY === 0 || !wrap.contains(document.activeElement)) return;
          event.preventDefault();
          view.wheel -= event.deltaMode === 1 ? event.deltaY * WHEEL_PX : event.deltaY;
          const steps = Math.trunc(view.wheel / WHEEL_PX);
          if (steps === 0) return;
          view.wheel -= steps * WHEEL_PX;
          stepField(key, steps, event.shiftKey);
        },
        { passive: false },
      );
    }

    function wireText(view) {
      const { f, text, picker } = view;
      const key = f.key;
      text.addEventListener("input", () => typeInto(view));
      text.addEventListener("blur", () => commitTyped(view));
      text.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        if (f.type === "text" && !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        commitTyped(view);
      });
      if (!picker) return;
      // A var() colour resolves to the live theme each time the picker opens.
      picker.addEventListener("pointerdown", () => {
        const hex = toHex(values[key], view.swatch);
        if (hex) picker.value = hex;
      });
      picker.addEventListener("input", () => {
        view.typedError = null;
        setUser(key, picker.value);
        sync(key, true);
      });
      picker.addEventListener("change", () => settle(key));
    }

    function wire(view) {
      const { f } = view;
      const key = f.key;
      view.reset.addEventListener("click", () => userReset(key));
      view.label.addEventListener("click", (event) => {
        if (!event.altKey) return;
        event.preventDefault();
        userReset(key);
      });
      if (isNumeric(f)) wireNumber(view);
      else if (f.type === "boolean") {
        view.check.addEventListener("change", () => {
          setUser(key, view.check.checked);
          settle(key);
        });
      } else if (view.radios) {
        view.radios.forEach((input, i) =>
          input.addEventListener("change", () => {
            setUser(key, f.options[i]);
            settle(key);
          }),
        );
      } else if (view.select) {
        view.select.addEventListener("change", () => {
          setUser(key, f.options[view.select.selectedIndex]);
          settle(key);
        });
      } else wireText(view);
    }

    function updateCounts() {
      for (const section of sections) {
        if (!section.count) continue;
        const n = section.keys.filter((k) => values[k] !== fieldMap.get(k).def).length;
        section.count.textContent = n ? `${n} changed` : "";
      }
    }

    // Writes state into the DOM. Silent. Text being typed is left alone while focused unless force is set.
    function sync(key, force = false) {
      const view = views.get(key);
      if (!view) return;
      const { f, row } = view;
      const value = values[key];
      const changed = value !== f.def;
      row.dataset.changed = String(changed);
      view.reset.disabled = !changed;
      view.sr.textContent = changed ? " (changed)" : "";
      const writable = (node) => force || document.activeElement !== node;
      if (isNumeric(f)) {
        if (Number.isFinite(value)) {
          const s = view.slider;
          if (f.max === undefined && value > Number(s.max)) s.max = String(value * 2);
          if (f.min === undefined && value < Number(s.min)) s.min = String(value * 2);
          s.value = String(value);
          const lo = Number(s.min);
          const span = Number(s.max) - lo;
          s.style.setProperty(
            "--t3k-propsform-p",
            `${span > 0 ? Math.min(100, Math.max(0, ((value - lo) / span) * 100)) : 0}%`,
          );
        }
        if (writable(view.text)) view.text.value = String(value);
      } else if (f.type === "boolean") view.check.checked = value === true;
      else if (view.radios)
        view.radios.forEach((input, i) => {
          input.checked = f.options[i] === value;
        });
      else if (view.select) view.select.selectedIndex = f.options.indexOf(value);
      else {
        if (view.swatch) {
          view.swatch.style.background =
            typeof value === "string" && COLOR_RE.test(value) ? value : "";
          const hex = toHex(value, view.swatch);
          if (hex) view.picker.value = hex;
        }
        if (writable(view.text)) view.text.value = String(value);
      }
      const message = view.typedError ?? problemOf(f, value);
      view.error.textContent = message ?? "";
      view.error.hidden = !message;
      view.aria.setAttribute("aria-invalid", String(Boolean(message)));
      updateCounts();
    }

    function syncAll() {
      for (const f of fields) sync(f.key, true);
    }

    function set(patch) {
      if (!isObject(patch)) throw new TypeError("propsform.set: expects { values?, schema? }");
      for (const key of Object.keys(patch)) {
        if (key !== "values" && key !== "schema")
          throw new TypeError(`propsform.set: unknown option "${key}"; use values or schema`);
      }
      const next = patch.schema !== undefined ? normalizeSchema(patch.schema) : null;
      if (patch.values !== undefined) {
        const known = new Set((next ?? fields).map((f) => f.key));
        if (!isObject(patch.values))
          throw new TypeError("propsform: values must be an object of key: value");
        for (const key of Object.keys(patch.values)) {
          if (!known.has(key))
            throw new TypeError(
              `propsform: unknown key "${key}"; keys are ${[...known].join(", ")}`,
            );
        }
      }
      if (next) {
        adopt(next, values);
        renderForm();
      }
      if (patch.values !== undefined) {
        for (const key of Object.keys(patch.values)) {
          forgetPending(key);
          views.get(key).typedError = null;
          values[key] = patch.values[key];
        }
        syncAll();
      }
    }

    function reset(key) {
      if (key !== undefined && !fieldMap.has(key)) throw unknownKey(key);
      for (const k of key === undefined ? fields.map((f) => f.key) : [key]) {
        values[k] = fieldMap.get(k).def;
        forgetPending(k);
        views.get(k).typedError = null;
      }
      syncAll();
    }

    function validate() {
      const issues = [];
      for (const f of fields) {
        const message = problemOf(f, values[f.key]);
        if (message) issues.push({ key: f.key, message });
      }
      return issues;
    }

    function focus(key) {
      const view = views.get(key);
      if (!view) throw unknownKey(key);
      const section = sections.find((s) => s.keys.includes(key));
      if (section) setOpen(section, true);
      const target = view.radios
        ? (view.radios.find((r) => r.checked) ?? view.radios[0])
        : view.focusEl;
      target.focus();
      target.scrollIntoView({ block: "nearest" });
    }

    function on(name, callback) {
      if (!listeners[name])
        throw new TypeError(`propsform.on: unknown event "${name}"; use "change" or "commit"`);
      if (typeof callback !== "function")
        throw new TypeError("propsform.on: callback must be a function");
      listeners[name].add(callback);
      return () => listeners[name].delete(callback);
    }

    function destroy() {
      resizeObserver.disconnect();
      if (changeFrame) cancelAnimationFrame(changeFrame);
      changeFrame = 0;
      for (const key of [...settleTimers.keys()]) forgetPending(key);
      listeners.change.clear();
      listeners.commit.clear();
      views.clear();
      root.remove();
    }

    try {
      adopt(normalizeSchema(options.schema), {});
      if (options.value !== undefined) {
        assertKnown(options.value, new Set(fields.map((f) => f.key)));
        Object.assign(values, options.value);
      }
      renderForm();
    } catch (error) {
      resizeObserver.disconnect();
      root.remove();
      throw error;
    }

    return { get, set, reset, validate, focus, on, destroy };
  }

  t3kit.propsform = { create };
})();
