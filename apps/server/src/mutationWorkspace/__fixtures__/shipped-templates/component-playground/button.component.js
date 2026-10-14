/*
 * T3 component playground sample: Button
 * Classic script. Registers window.t3component for the playground host.
 * Uses only T3 theme tokens. Deterministic: no timers, no randomness.
 */
(function () {
  var STYLE_ID = "t3-button-style";

  var PROPS = {
    label: { type: "string", default: "Save changes" },
    variant: {
      type: "enum",
      enum: ["primary", "secondary", "ghost", "danger"],
      default: "primary",
    },
    size: { type: "enum", enum: ["sm", "md", "lg"], default: "md" },
    icon: { type: "enum", enum: ["none", "plus", "check", "arrow"], default: "none" },
    iconOnly: { type: "boolean", default: false },
    loading: { type: "boolean", default: false },
    disabled: { type: "boolean", default: false },
    fullWidth: { type: "boolean", default: false },
    radius: { type: "number", min: 0, max: 16, step: 1, unit: "px", default: 6 },
    paddingX: { type: "number", min: 4, max: 24, step: 1, unit: "px", default: 12 },
  };

  var css = [
    ".t3-btn {",
    "  display: inline-flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  gap: 8px;",
    "  height: 36px;",
    "  padding: 0 var(--t3-btn-px, 12px);",
    "  border: 1px solid transparent;",
    "  border-radius: var(--t3-btn-radius, var(--radius, 6px));",
    "  background: var(--t3-btn-bg);",
    "  color: var(--t3-btn-fg);",
    "  font-family: var(--font-sans, system-ui, sans-serif);",
    "  font-size: 14px;",
    "  font-weight: 500;",
    "  line-height: 1;",
    "  cursor: pointer;",
    "}",
    '.t3-btn[data-variant="primary"] { --t3-btn-bg: var(--primary); --t3-btn-fg: var(--primary-foreground); --t3-btn-hover: color-mix(in srgb, var(--primary) 85%, transparent); }',
    '.t3-btn[data-variant="secondary"] { --t3-btn-bg: var(--muted); --t3-btn-fg: var(--primary); --t3-btn-hover: color-mix(in srgb, var(--muted) 70%, var(--primary)); }',
    '.t3-btn[data-variant="ghost"] { --t3-btn-bg: transparent; --t3-btn-fg: var(--primary); --t3-btn-hover: var(--muted); }',
    '.t3-btn[data-variant="danger"] { --t3-btn-bg: var(--destructive); --t3-btn-fg: var(--primary-foreground); --t3-btn-hover: color-mix(in srgb, var(--destructive) 85%, transparent); }',
    '.t3-btn[data-size="sm"] { height: 30px; font-size: 12px; }',
    '.t3-btn[data-size="lg"] { height: 44px; font-size: 16px; }',
    '.t3-btn[data-icon-only="true"][data-size="sm"] { width: 30px; padding: 0; }',
    '.t3-btn[data-icon-only="true"][data-size="md"] { width: 36px; padding: 0; }',
    '.t3-btn[data-icon-only="true"][data-size="lg"] { width: 44px; padding: 0; }',
    '.t3-btn[data-full-width="true"] { width: 100%; }',
    ".t3-btn:hover { background: var(--t3-btn-hover); }",
    ".t3-btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }",
    ".t3-btn:active { transform: translateY(1px); filter: brightness(0.9); }",
    ".t3-btn:disabled { opacity: 0.45; cursor: not-allowed; background: var(--t3-btn-bg); transform: none; filter: none; }",
    '.t3-btn[aria-busy="true"] { cursor: progress; }',
    ".t3-btn .t3-btn-icon { display: inline-flex; flex: none; }",
  ].join("\n");

  var ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  };

  // Static loading ring: a faint track and a fixed arc. No animation.
  var SPINNER =
    '<svg class="t3-spinner" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke-opacity="0.25"/><path d="M14 8a6 6 0 0 0-6-6" stroke-linecap="round"/></svg>';

  function iconMarkup(name) {
    return (
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      ICONS[name] +
      "</svg>"
    );
  }

  function clampNumber(spec, value) {
    var n = Math.round(Number(value) / spec.step) * spec.step;
    return Math.min(spec.max, Math.max(spec.min, n));
  }

  // Merges input over defaults. Invalid enum values throw so the caller sees them.
  function resolve(input) {
    var source = input || {};
    var out = {};
    Object.keys(PROPS).forEach(function (key) {
      var spec = PROPS[key];
      var value = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : spec.default;
      if (spec.type === "number") {
        out[key] = clampNumber(spec, value);
      } else if (spec.type === "enum") {
        if (spec.enum.indexOf(value) === -1) {
          throw new Error("Button: invalid " + key + ' "' + value + '"');
        }
        out[key] = value;
      } else if (spec.type === "boolean") {
        out[key] = Boolean(value);
      } else {
        out[key] = String(value);
      }
    });
    return out;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildButton(p) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "t3-btn";
    btn.setAttribute("data-variant", p.variant);
    btn.setAttribute("data-size", p.size);
    btn.setAttribute("data-icon-only", String(p.iconOnly));
    btn.setAttribute("data-full-width", String(p.fullWidth));
    btn.setAttribute("aria-busy", String(p.loading));
    btn.style.setProperty("--t3-btn-radius", p.radius + "px");
    btn.style.setProperty("--t3-btn-px", p.paddingX + "px");
    btn.disabled = p.disabled || p.loading;

    var leading = null;
    if (p.loading) {
      leading = SPINNER;
    } else if (p.icon !== "none") {
      leading = iconMarkup(p.icon);
    }
    if (leading !== null) {
      var iconWrap = document.createElement("span");
      iconWrap.className = "t3-btn-icon";
      iconWrap.innerHTML = leading;
      btn.appendChild(iconWrap);
    }

    if (p.iconOnly) btn.setAttribute("aria-label", p.label);

    // Icon-only hides the visible label, unless there is no icon to show.
    var showLabel = !p.iconOnly || leading === null;
    if (showLabel) {
      var text = document.createElement("span");
      text.className = "t3-btn-label";
      text.textContent = p.label;
      btn.appendChild(text);
    }
    return btn;
  }

  function mount(el, props) {
    ensureStyle();
    var state = resolve(props);
    var current = buildButton(state);
    el.appendChild(current);
    return {
      update: function (next) {
        state = resolve(Object.assign({}, state, next));
        var fresh = buildButton(state);
        el.replaceChild(fresh, current);
        current = fresh;
      },
      destroy: function () {
        if (current.parentNode === el) el.removeChild(current);
      },
    };
  }

  function usage(props) {
    var p = resolve(props);
    var attrs = [];
    Object.keys(PROPS).forEach(function (key) {
      var spec = PROPS[key];
      if (key === "label" || p[key] === spec.default) return;
      if (spec.type === "boolean") {
        attrs.push(key);
      } else if (spec.type === "number") {
        attrs.push(key + "={" + p[key] + "}");
      } else {
        attrs.push(key + '="' + p[key] + '"');
      }
    });
    var open = "<Button" + (attrs.length ? " " + attrs.join(" ") : "") + ">";
    return open + p.label + "</Button>";
  }

  window.t3component = {
    name: "Button",
    props: PROPS,
    css: css,
    mount: mount,
    usage: usage,
  };
})();
