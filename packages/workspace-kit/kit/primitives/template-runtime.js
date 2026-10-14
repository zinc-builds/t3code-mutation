/**
 * t3kit.templateRuntime: the one bolt-on runtime behind every template's window.t3template. Bolt-ons (options.customScript)
 *   get one API whose effects reach the preview AND the export. Agents read the template's "boltOn" docs, not this header.
 * create({ id, pipeline: 'image'|'edl'|'data', addPanel(title, { open, position: 'top'|'bottom' }) -> body, toolbar, buttonClass?,
 *   getValues(), setValues(partial, label), export() -> Promise<File | File[] | { files, ffmpeg?: [command] }>, addPreset?,
 *   applyPreset?, reservedKeys?, onCommand?(label, run, hint), onBoltOnChange?() (re-render, persist state()),
 *   stageTargets?: ['image', 'output'], previewTarget?, frame?() -> { width, height, duration },
 *   audioPreview?() -> [instances with setAudioChain (waveform, player)],
 *   chrome?: { toolbar?() -> items, sidebar?() -> sections, native(on) } })
 *   chrome: T3 chrome manifest entries plus run(value?). publish() offers them to t3.workspace.setChrome; when T3 accepts,
 *   native(true) hides the page's own toolbar and T3 commands call run; otherwise the in-page UI stays as it is.
 * Runtime (template side)
 *   publish({ instances, extras?, saved? }) -> api (window.t3template; saved = a previous state()).
 *   linkHistory(history, getState, applyState, { sources?, idleMs?, thumb?, commit?(label) }) -> t3kit.links.historyState
 *     link whose steps also hold control values: a control edit (one drag = one step) is an undo step, and undo, redo,
 *     jump and presets restore controls with the template state. commit defaults to link.commit.
 *   runCustomScript(code, options)  reportError(err, where?)  showBanner(text)  emitChange()  refresh()
 *   state() -> { [controlId]: value } to persist with setState and pass back as saved.
 *   syncChrome() after state a chrome entry shows changed.  chromeMode() -> 'page' | 'pending' | 'native'.
 *   data:  no media hooks (tables, charts): bolt-ons use controls, panels, buttons and presets; stage, EDL and audio
 *          calls throw with a pointer to them.
 *   image: hasImageStages(at?); runImageStages(canvas, { scale = 1, phase, at = 'image', info? }) edits in place.
 *   edl:   transformEdl(edl, { phase, info }); exportFilters(edl, { phase, info }) -> { video, audio, notes } (audio holds
 *          addAudioFilter's ffmpeg too); previewFilter(); setPreviewTime(time, info); hasOverlays();
 *          renderOverlays() -> [{ id, canvas, start, end }]; drawOverlays(canvas, time).
 *   'preview': a failing hook is reported once, then skipped. 'export': every failure throws.
 * window.t3template (bolt-on side)
 *   instances, getValues() -> { ...values, controls }, setValues(partial, label?), on('change', cb) -> off, refresh(),
 *   export() -> Promise<{ files: [{ name, type, size, width?, height? }], ffmpeg?: [command] }> (ffmpeg: edl templates),
 *   addPanel(title | { title, open = true, position = 'top' }) -> body, addToolbarButton(label, onClick, { shortcut,
 *   title }), addPreset(name, values), applyPreset(name), addControl({ id, label?, type: 'slider'|'toggle'|'select'|'color'|
 *   'text'|'button', min = 0, max = 1, step, default, options, placeholder, rows, panel?, onChange?, onClick? })
 *     -> { id, element, get(), set(value), setLabel(text) }   values persist and arrive as `controls` in every hook.
 *   image: addImageStage(id, (ctx, controls) => void, { at? }), addShaderStage(id, glsl, uniforms?, { at? }), removeStage.
 *   edl:   addEdlTransform, addExportNote, addPreviewFilter, addOverlay(id, draw, timing?),
 *          addAudioFilter(id, (controls) => filter | filter[] | null): heard live (Web Audio) AND rendered by ffmpeg.
 *          filter { type, ...params }: gain { db }, highpass|lowpass { frequency, q }, bandpass|notch { frequency, q },
 *          peaking { frequency, gain, q }, lowshelf|highshelf { frequency, gain }, compressor { threshold, ratio,
 *          attack, release, knee, makeup }, echo { time, mix }. Ranges and defaults: AUDIO_FILTERS below.
 * Example: const rt = t3kit.templateRuntime.create({ id, pipeline: 'image', addPanel, toolbar, getValues, setValues,
 *   export, onBoltOnChange });  const link = rt.linkHistory(history, getState, applyState);  rt.publish({ instances });
 */
(function () {
  "use strict";
  const t3kit = (window.t3kit = window.t3kit || {});

  const P = "t3k-template-runtime-";
  const TYPES = ["slider", "toggle", "select", "color", "text", "button"];
  const CORE = [
    "instances",
    "getValues",
    "setValues",
    "on",
    "refresh",
    "export",
    "addPanel",
    "addToolbarButton",
    "addControl",
    "addPreset",
    "applyPreset",
    "addImageStage",
    "addShaderStage",
    "removeStage",
    "addEdlTransform",
    "addExportNote",
    "addPreviewFilter",
    "addOverlay",
    "addAudioFilter",
    "audioFilters",
  ];
  const DEFAULT_PANEL = "Extras";
  const TEXT_MAX = 2000;
  const SETTLE_MS = 1000; // a control edit with no release/blur event becomes an undo step after this pause
  const TEXT_SETTLE_MS = 700;
  const CHROME_TOOLBAR_MAX = 24; // T3's limit (mutationWorkspaceChrome.ts MAX_TOOLBAR_ITEMS)
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const messageOf = (err) => (err instanceof Error ? err.message : String(err));
  const show = (v) => {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s;
  };
  const HEX = /^#[0-9a-f]{6}$/i;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // ---- Audio filters: one description, two renderers (Web Audio for the preview, ffmpeg for the export) ----------
  // Each param is [min, max, default]. Units: Hz, dB, seconds; q is the filter Q (0.7071 = Butterworth).
  const AUDIO_FILTERS = {
    gain: { db: [-60, 24, 0] },
    highpass: { frequency: [10, 20000, 100], q: [0.1, 30, Math.SQRT1_2] },
    lowpass: { frequency: [10, 20000, 8000], q: [0.1, 30, Math.SQRT1_2] },
    bandpass: { frequency: [10, 20000, 1000], q: [0.1, 30, 1] },
    notch: { frequency: [10, 20000, 1000], q: [0.1, 30, 1] },
    peaking: { frequency: [10, 20000, 1000], gain: [-30, 30, 0], q: [0.1, 30, 1] },
    lowshelf: { frequency: [10, 20000, 200], gain: [-30, 30, 0] },
    highshelf: { frequency: [10, 20000, 4000], gain: [-30, 30, 0] },
    compressor: {
      threshold: [-60, 0, -24],
      ratio: [1, 20, 4],
      attack: [0, 1, 0.003],
      release: [0.01, 1, 0.25],
      knee: [0, 18, 6],
      makeup: [0, 24, 0],
    },
    echo: { time: [0.001, 2, 0.25], mix: [0, 1, 0.4] },
  };
  function checkAudioFilter(f, where) {
    if (!isObj(f))
      throw new TypeError(
        `${where}: a filter is an object like { type: 'highpass', frequency: 80 } (got ${show(f)})`,
      );
    const params = AUDIO_FILTERS[f.type];
    if (!params)
      throw new TypeError(
        `${where}: type must be ${Object.keys(AUDIO_FILTERS).join(", ")} (got ${show(f.type)})`,
      );
    const out = { type: f.type };
    for (const k of Object.keys(f)) {
      if (k !== "type" && !params[k])
        throw new TypeError(
          `${where}: ${f.type} has no "${k}" (it takes ${Object.keys(params).join(", ")})`,
        );
    }
    for (const [k, [min, max, def]] of Object.entries(params)) {
      const v = f[k] === undefined ? def : f[k];
      if (!(isNum(v) && v >= min && v <= max))
        throw new RangeError(
          `${where}: ${f.type}.${k} must be a number ${min}..${max} (got ${show(f[k])})`,
        );
      out[k] = v;
    }
    return out;
  }
  const n6 = (v) => String(Math.round(v * 1e6) / 1e6);
  const dbLin = (db) => 10 ** (db / 20);
  const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // Web Audio's compressor adds an automatic makeup gain of 0.6 x the gain it takes off a 0 dBFS signal; ffmpeg's
  // acompressor gets it explicitly so both sound alike (close, not sample-identical: the knee shapes differ).
  const autoMakeupDb = (f) => -0.6 * f.threshold * (1 - 1 / f.ratio);
  function audioFfmpeg(f) {
    const fq = `f=${n6(f.frequency)}`;
    switch (f.type) {
      case "gain":
        return f.db === 0 ? "" : `volume=${n6(f.db)}dB`;
      case "highpass":
      case "lowpass":
        return `${f.type}=${fq}:width_type=q:width=${n6(f.q)}`;
      case "bandpass":
        return `bandpass=${fq}:width_type=q:width=${n6(f.q)}`;
      case "notch":
        return `bandreject=${fq}:width_type=q:width=${n6(f.q)}`;
      case "peaking":
        return `equalizer=${fq}:width_type=q:width=${n6(f.q)}:gain=${n6(f.gain)}`;
      // lowshelf/highshelf (not bass/treble, whose curves differ from Web Audio's) with slope 1, as Web Audio uses.
      case "lowshelf":
      case "highshelf":
        return `${f.type}=${fq}:gain=${n6(f.gain)}:width_type=s:width=1`;
      case "compressor":
        return (
          `acompressor=threshold=${n6(Math.max(0.000976563, dbLin(f.threshold)))}:ratio=${n6(f.ratio)}` +
          `:attack=${n6(Math.max(0.01, f.attack * 1000))}:release=${n6(f.release * 1000)}` +
          `:knee=${n6(clampNum(dbLin(f.knee), 1, 8))}:makeup=${n6(clampNum(dbLin(autoMakeupDb(f) + f.makeup), 1, 64))}`
        );
      case "echo":
        return f.mix === 0
          ? ""
          : `aecho=in_gain=1:out_gain=1:delays=${n6(f.time * 1000)}:decays=${n6(f.mix)}`;
      default:
        throw new TypeError(`no ffmpeg mapping for audio filter "${f.type}"`);
    }
  }
  // One filter as Web Audio nodes: { input, output, update(filter) }. update glides params (no clicks while dragging).
  function audioNode(ctx, f) {
    const glide = (param, v) => param.setTargetAtTime(v, ctx.currentTime, 0.012);
    const nyquist = ctx.sampleRate / 2 - 1;
    if (f.type === "gain") {
      const g = ctx.createGain();
      g.gain.value = dbLin(f.db);
      return { input: g, output: g, update: (x) => glide(g.gain, dbLin(x.db)) };
    }
    if (f.type === "compressor") {
      const c = ctx.createDynamicsCompressor();
      const g = ctx.createGain();
      c.connect(g);
      const set = (x, first) => {
        const apply = (param, v) => (first ? (param.value = v) : glide(param, v));
        apply(c.threshold, x.threshold);
        apply(c.ratio, x.ratio);
        apply(c.attack, x.attack);
        apply(c.release, x.release);
        apply(c.knee, x.knee);
        apply(g.gain, dbLin(x.makeup));
      };
      set(f, true);
      return { input: c, output: g, update: (x) => set(x, false) };
    }
    if (f.type === "echo") {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const delay = ctx.createDelay(2);
      const wet = ctx.createGain();
      input.connect(output);
      input.connect(delay);
      delay.connect(wet);
      wet.connect(output);
      delay.delayTime.value = f.time;
      wet.gain.value = f.mix;
      return {
        input,
        output,
        update: (x) => {
          glide(delay.delayTime, x.time);
          glide(wet.gain, x.mix);
        },
      };
    }
    const b = ctx.createBiquadFilter();
    b.type = f.type;
    // Web Audio's lowpass/highpass Q is in dB; the others take the plain Q, like ffmpeg's width_type=q.
    const q = (x) => (x.type === "lowpass" || x.type === "highpass" ? 20 * Math.log10(x.q) : x.q);
    const set = (x, first) => {
      const apply = (param, v) => (first ? (param.value = v) : glide(param, v));
      apply(b.frequency, Math.min(x.frequency, nyquist));
      if (x.q !== undefined) apply(b.Q, q(x));
      if (x.gain !== undefined) apply(b.gain, x.gain);
    };
    set(f, true);
    return { input: b, output: b, update: (x) => set(x, false) };
  }
  function buildAudioChain(ctx, input, list) {
    const nodes = list.map((f) => audioNode(ctx, f));
    let prev = input;
    for (const n of nodes) {
      prev.connect(n.input);
      prev = n.output;
    }
    return { nodes, output: prev };
  }

  const CSS = `
.${P}row{display:grid;grid-template-columns:minmax(64px,100px) minmax(0,1fr) 48px;align-items:center;gap:8px;min-height:24px;margin:2px 0;font:12px/1.4 var(--font-sans);color:var(--foreground)}
.${P}row>label{color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${P}row.${P}edited>label{color:var(--foreground)}
.${P}row output{font:11px/1 var(--font-mono);text-align:right;font-variant-numeric:tabular-nums;color:var(--muted-foreground)}
.${P}row input[type=range]{width:100%;margin:0;accent-color:var(--primary)}
.${P}row input[type=checkbox]{justify-self:start;margin:0;width:14px;height:14px;accent-color:var(--primary)}
.${P}row select,.${P}row input[type=text],.${P}row textarea{box-sizing:border-box;width:100%;min-width:0;padding:0 6px;border:1px solid var(--border);border-radius:calc(var(--radius) - 4px);background:var(--background);color:var(--foreground);font:inherit}
.${P}row select,.${P}row input[type=text]{height:24px}
.${P}row textarea{padding:4px 6px;resize:vertical}
.${P}row.${P}text>input,.${P}row.${P}text>textarea{grid-column:2 / span 2}
.${P}row input[type=color]{width:100%;height:22px;padding:0 2px;border:1px solid var(--border);border-radius:calc(var(--radius) - 4px);background:var(--background);cursor:pointer}
.${P}row.${P}wide{grid-template-columns:minmax(0,1fr)}
.${P}action{height:26px;padding:0 10px;border:1px solid var(--border);border-radius:calc(var(--radius) - 4px);background:var(--muted);color:var(--foreground);font:inherit;cursor:pointer}
.${P}action:hover{border-color:var(--ring)}
.${P}kbd{margin-left:6px;padding:1px 4px;border:1px solid currentColor;border-radius:4px;font:10px/1 var(--font-mono);opacity:.7}
.${P}overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1}
.${P}banner{position:fixed;left:12px;right:12px;bottom:12px;z-index:50;display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--destructive);border-radius:var(--radius);background:var(--card);color:var(--card-foreground);font:12px/1.4 var(--font-sans)}
.${P}banner[data-kind=notice]{border-color:var(--border)}
.${P}banner>b{color:var(--destructive);font-weight:600;white-space:nowrap}
.${P}banner[data-kind=notice]>b{color:var(--muted-foreground)}
.${P}banner>span{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.${P}banner>button{height:24px;padding:0 10px;border:1px solid var(--border);border-radius:calc(var(--radius) - 4px);background:var(--muted);color:var(--foreground);font:inherit;cursor:pointer}
`;
  function injectStyle() {
    if (document.head.querySelector('style[data-t3kit="templateRuntime"]')) return;
    const style = document.createElement("style");
    style.setAttribute("data-t3kit", "templateRuntime");
    style.textContent = CSS;
    document.head.append(style);
  }

  // Seeded PRNG (mulberry32) so a stage draws the same pattern on every render; the seed is hashed from a string.
  function hashSeed(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function copyCanvas(canvas) {
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    out.getContext("2d").drawImage(canvas, 0, 0);
    return out;
  }

  // ---- Shortcuts --------------------------------------------------------------------------------
  // Canonical form: modifiers in the order mod, alt, shift, then the key in lower case ('mod+shift+g').
  function normalizeShortcut(text) {
    if (typeof text !== "string" || !text.trim())
      throw new TypeError("shortcut must be a string like 'g', 'shift+g' or 'mod+g'");
    const parts = text
      .toLowerCase()
      .split("+")
      .map((s) => s.trim());
    const key = parts.pop() || "+";
    const mods = new Set();
    for (const p of parts) {
      if (["mod", "cmd", "ctrl", "meta", "control"].includes(p)) mods.add("mod");
      else if (p === "alt" || p === "option") mods.add("alt");
      else if (p === "shift") mods.add("shift");
      else throw new TypeError(`shortcut "${text}": unknown modifier "${p}" (use mod, alt, shift)`);
    }
    if (
      key.length !== 1 &&
      !["enter", "escape", "delete", "backspace", "tab", "space"].includes(key)
    ) {
      throw new TypeError(
        `shortcut "${text}": the key must be one character (or enter, escape, delete, backspace, tab, space)`,
      );
    }
    return [...["mod", "alt", "shift"].filter((m) => mods.has(m)), key].join("+");
  }
  function eventShortcut(e) {
    let key;
    let shiftable = true; // shift+[ arrives as "{", so punctuation already carries its shift
    if (/^Key[A-Z]$/.test(e.code || "")) key = e.code.slice(3).toLowerCase();
    else if (/^Digit\d$/.test(e.code || "")) key = e.code.slice(5);
    else if (e.key === " ") key = "space";
    else if (e.key.length === 1) {
      key = e.key.toLowerCase();
      shiftable = false;
    } else key = e.key.toLowerCase();
    const mods = [];
    if (e.metaKey || e.ctrlKey) mods.push("mod");
    if (e.altKey) mods.push("alt");
    if (e.shiftKey && shiftable) mods.push("shift");
    return [...mods, key].join("+");
  }
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || "");
  const PRETTY = MAC
    ? { mod: "⌘", alt: "⌥", shift: "⇧" }
    : { mod: "Ctrl+", alt: "Alt+", shift: "Shift+" };
  const prettyShortcut = (s) =>
    s
      .split("+")
      .map((p) => PRETTY[p] || (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
      .join("");
  const isTyping = (t) =>
    t instanceof HTMLElement &&
    (t.isContentEditable ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement ||
      (t instanceof HTMLInputElement &&
        !["checkbox", "radio", "range", "button", "color"].includes(t.type)));

  // ---- WebGL for shader stages (one shared context, created on first use) -------------------------
  const VERT =
    "attribute vec2 a_pos;varying vec2 v_uv;void main(){v_uv=a_pos*0.5+0.5;gl_Position=vec4(a_pos,0.0,1.0);}";
  const FRAG_HEAD =
    "precision highp float;\nuniform sampler2D u_image;\nuniform vec2 u_resolution;\nuniform float u_scale;\nvarying vec2 v_uv;\n";
  let glState = null;
  function gl() {
    if (glState) return glState;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("webgl", {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
      alpha: true,
    });
    if (!ctx) throw new Error("shader stages need WebGL, which this browser did not provide");
    const buf = ctx.createBuffer();
    ctx.bindBuffer(ctx.ARRAY_BUFFER, buf);
    ctx.bufferData(
      ctx.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      ctx.STATIC_DRAW,
    );
    const tex = ctx.createTexture();
    ctx.bindTexture(ctx.TEXTURE_2D, tex);
    for (const [k, v] of [
      [ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE],
      [ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE],
      [ctx.TEXTURE_MIN_FILTER, ctx.LINEAR],
      [ctx.TEXTURE_MAG_FILTER, ctx.LINEAR],
    ]) {
      ctx.texParameteri(ctx.TEXTURE_2D, k, v);
    }
    const dims = ctx.getParameter(ctx.MAX_VIEWPORT_DIMS);
    glState = {
      canvas,
      ctx,
      buf,
      tex,
      max: Math.min(ctx.getParameter(ctx.MAX_TEXTURE_SIZE), dims[0], dims[1]),
    };
    return glState;
  }
  function compileShader(id, glsl) {
    const { ctx } = gl();
    const make = (type, src, what) => {
      const s = ctx.createShader(type);
      ctx.shaderSource(s, src);
      ctx.compileShader(s);
      if (!ctx.getShaderParameter(s, ctx.COMPILE_STATUS))
        throw new Error(
          `shader stage "${id}": ${what} does not compile: ${ctx.getShaderInfoLog(s)}`,
        );
      return s;
    };
    const program = ctx.createProgram();
    ctx.attachShader(program, make(ctx.VERTEX_SHADER, VERT, "vertex shader"));
    ctx.attachShader(
      program,
      make(
        ctx.FRAGMENT_SHADER,
        FRAG_HEAD + glsl,
        "fragment shader (u_image, u_resolution, u_scale and v_uv are declared for you)",
      ),
    );
    ctx.linkProgram(program);
    if (!ctx.getProgramParameter(program, ctx.LINK_STATUS))
      throw new Error(`shader stage "${id}" does not link: ${ctx.getProgramInfoLog(program)}`);
    return program;
  }
  function setUniform(ctx, loc, name, v, id) {
    if (typeof v === "boolean") return ctx.uniform1f(loc, v ? 1 : 0);
    if (isNum(v)) return ctx.uniform1f(loc, v);
    if (typeof v === "string" && HEX.test(v)) {
      return ctx.uniform3f(
        loc,
        parseInt(v.slice(1, 3), 16) / 255,
        parseInt(v.slice(3, 5), 16) / 255,
        parseInt(v.slice(5, 7), 16) / 255,
      );
    }
    if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every(isNum))
      return ctx[`uniform${v.length}fv`](loc, v);
    throw new TypeError(
      `shader stage "${id}": uniform ${name} must be a number, boolean, '#rrggbb' or 2-4 numbers (got ${show(v)})`,
    );
  }
  function runShader(st, canvas, controls, scale) {
    const g = gl();
    const { ctx } = g;
    const w = canvas.width;
    const h = canvas.height;
    if (w > g.max || h > g.max)
      throw new Error(`shader stage "${st.id}": ${w} x ${h} is over this GPU's ${g.max} px limit`);
    g.canvas.width = w;
    g.canvas.height = h;
    ctx.viewport(0, 0, w, h);
    ctx.useProgram(st.program);
    ctx.bindBuffer(ctx.ARRAY_BUFFER, g.buf);
    const aPos = ctx.getAttribLocation(st.program, "a_pos");
    ctx.enableVertexAttribArray(aPos);
    ctx.vertexAttribPointer(aPos, 2, ctx.FLOAT, false, 0, 0);
    ctx.activeTexture(ctx.TEXTURE0);
    ctx.bindTexture(ctx.TEXTURE_2D, g.tex);
    ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, true);
    ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, canvas);
    ctx.uniform1i(ctx.getUniformLocation(st.program, "u_image"), 0);
    const res = ctx.getUniformLocation(st.program, "u_resolution");
    if (res) ctx.uniform2f(res, w, h);
    const sc = ctx.getUniformLocation(st.program, "u_scale");
    if (sc) ctx.uniform1f(sc, scale);
    const uniforms = st.uniforms ? st.uniforms(controls, { width: w, height: h, scale }) : {};
    if (!isObj(uniforms))
      throw new TypeError(
        `shader stage "${st.id}": the uniforms function must return an object like { u_amount: 0.5 }`,
      );
    for (const [name, v] of Object.entries(uniforms)) {
      if (!/^[A-Za-z_]\w*$/.test(name))
        throw new TypeError(`shader stage "${st.id}": "${name}" is not a GLSL uniform name`);
      if (!new RegExp(`uniform\\s+\\w+\\s+${name}\\s*[;\\[]`).test(st.glsl))
        throw new Error(`shader stage "${st.id}": uniform ${name} is not declared in the GLSL`);
      const loc = ctx.getUniformLocation(st.program, name);
      if (loc) setUniform(ctx, loc, name, v, st.id); // null: declared but unused, so the compiler dropped it
    }
    ctx.drawArrays(ctx.TRIANGLE_STRIP, 0, 4);
    const c2 = canvas.getContext("2d");
    c2.save();
    c2.globalCompositeOperation = "copy";
    c2.drawImage(g.canvas, 0, 0);
    c2.restore();
  }

  // ---- create ------------------------------------------------------------------------------------
  function create(cfg) {
    if (!isObj(cfg)) throw new TypeError("templateRuntime.create(config) needs an object");
    if (typeof cfg.id !== "string" || !cfg.id)
      throw new TypeError("templateRuntime: config.id must be the template id");
    if (!["image", "edl", "data"].includes(cfg.pipeline))
      throw new TypeError(`templateRuntime(${cfg.id}): pipeline must be 'image', 'edl' or 'data'`);
    for (const fn of ["addPanel", "getValues", "setValues", "export"]) {
      if (typeof cfg[fn] !== "function")
        throw new TypeError(`templateRuntime(${cfg.id}): config.${fn} must be a function`);
    }
    if (!(cfg.toolbar instanceof HTMLElement))
      throw new TypeError(`templateRuntime(${cfg.id}): config.toolbar must be an element`);
    const targets = cfg.stageTargets === undefined ? ["image"] : cfg.stageTargets;
    if (!Array.isArray(targets) || !targets.every((t) => t === "image" || t === "output")) {
      throw new TypeError(
        `templateRuntime(${cfg.id}): config.stageTargets must list 'image' and/or 'output'`,
      );
    }
    if (cfg.previewTarget !== undefined && !(cfg.previewTarget instanceof HTMLElement))
      throw new TypeError(`templateRuntime(${cfg.id}): config.previewTarget must be an element`);
    if (cfg.frame !== undefined && typeof cfg.frame !== "function")
      throw new TypeError(`templateRuntime(${cfg.id}): config.frame must be a function`);
    if (cfg.audioPreview !== undefined && typeof cfg.audioPreview !== "function")
      throw new TypeError(
        `templateRuntime(${cfg.id}): config.audioPreview must be a function returning instances with setAudioChain()`,
      );
    if (cfg.chrome !== undefined) {
      const ch = cfg.chrome;
      if (!isObj(ch) || typeof ch.native !== "function")
        throw new TypeError(
          `templateRuntime(${cfg.id}): config.chrome must be { toolbar?(), sidebar?(), native(on) }`,
        );
      for (const k of ["toolbar", "sidebar"])
        if (ch[k] !== undefined && typeof ch[k] !== "function")
          throw new TypeError(`templateRuntime(${cfg.id}): config.chrome.${k} must be a function`);
    }
    injectStyle();

    const controls = new Map(); // id -> { spec, value, initial, sync(value) }
    const panels = new Map(); // title -> body element
    const presets = new Map(); // name -> { controls?, template: boolean }
    const listeners = new Set();
    const stages = []; // { id, at, kind: '2d' | 'shader', fn | glsl, program, uniforms, failed }
    const transforms = [];
    const notes = [];
    const previewFilters = [];
    const overlays = []; // { id, draw, timing, failed, n, cache }
    const shortcuts = new Map(); // canonical -> run
    const reserved = new Set((cfg.reservedKeys || []).map(normalizeShortcut));
    let saved = {};
    let seeds = {};
    let api = null;
    let banner = null;
    let previewInfo = { time: 0 };

    // ---- Errors and banner ----
    function bannerEl() {
      if (banner) return banner;
      banner = document.createElement("div");
      banner.className = `${P}banner`;
      banner.setAttribute("role", "alert");
      banner.hidden = true;
      const label = document.createElement("b");
      const text = document.createElement("span");
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Dismiss";
      close.addEventListener("click", () => {
        banner.hidden = true;
      });
      banner.append(label, text, close);
      document.body.append(banner);
      return banner;
    }
    function showBanner(text, kind = "notice", label = "") {
      const b = bannerEl();
      b.dataset.kind = kind;
      b.children[0].textContent = label;
      b.children[0].hidden = !label;
      b.children[1].textContent = String(text);
      b.hidden = false;
    }
    function reportError(err, where = cfg.id) {
      const message = messageOf(err);
      console.error(`[t3template] ${where} error:`, message);
      showBanner(message, "error", `${where} error`);
    }
    // Runs a bolt-on callback; errors go to the console and banner instead of breaking the template.
    function guard(where, fn) {
      try {
        const r = fn();
        if (r && typeof r.then === "function") r.then(null, (err) => reportError(err, where));
        return r;
      } catch (err) {
        reportError(err, where);
        return undefined;
      }
    }
    function boltOnChanged() {
      invalidateOverlays();
      if (audioSinks.size || notes.some((h) => h.kind === "audio"))
        guard("audio preview", refreshAudio);
      if (cfg.onBoltOnChange) guard(cfg.id, () => cfg.onBoltOnChange());
    }
    function needPipeline(name, pipeline) {
      if (cfg.pipeline === "data" && cfg.pipeline !== pipeline) {
        throw new TypeError(
          `t3template.${name} is for ${pipeline === "image" ? "image" : "video and audio"} templates; ${cfg.id} has no picture or timeline, so bolt on with addControl, addPanel, addToolbarButton and addPreset`,
        );
      }
      if (cfg.pipeline !== pipeline) {
        const use =
          pipeline === "image"
            ? "addEdlTransform / addExportNote"
            : "addImageStage / addShaderStage";
        throw new TypeError(
          `t3template.${name} is for ${pipeline === "image" ? "image" : "video and audio"} templates; ${cfg.id} uses ${use}`,
        );
      }
    }
    function needId(name, id, taken) {
      if (typeof id !== "string" || !/^[A-Za-z_][\w-]*$/.test(id))
        throw new TypeError(`t3template.${name}: id must be a word like "glow" (got ${show(id)})`);
      if (taken(id)) throw new Error(`t3template.${name}: "${id}" already exists`);
    }

    // ---- Values ----
    const controlValues = () => {
      const out = {};
      for (const [id, c] of controls) if (c.spec.type !== "button") out[id] = c.value;
      return out;
    };
    function checkValue(c, v, where) {
      const s = c.spec;
      const got = ` (got ${show(v)})`;
      if (s.type === "slider" && !(isNum(v) && v >= s.min && v <= s.max))
        throw new RangeError(`${where}: "${s.id}" must be a number ${s.min}..${s.max}${got}`);
      if (s.type === "toggle" && typeof v !== "boolean")
        throw new TypeError(`${where}: "${s.id}" must be true or false${got}`);
      if (s.type === "select" && !s.options.some((o) => o.value === v))
        throw new RangeError(
          `${where}: "${s.id}" must be one of ${s.options.map((o) => JSON.stringify(o.value)).join(", ")}${got}`,
        );
      if (s.type === "color" && !(typeof v === "string" && HEX.test(v)))
        throw new TypeError(`${where}: "${s.id}" must be a '#rrggbb' colour${got}`);
      if (s.type === "text" && !(typeof v === "string" && v.length <= s.maxLength))
        throw new TypeError(
          `${where}: "${s.id}" must be a string of at most ${s.maxLength} characters${got}`,
        );
      if (s.type === "button")
        throw new TypeError(`${where}: "${s.id}" is a button and has no value`);
      return s.type === "color" ? v.toLowerCase() : v;
    }
    function checkControls(partial, where) {
      if (!isObj(partial))
        throw new TypeError(`${where}: controls must be an object like { glow: 0.5 }`);
      const out = {};
      for (const [id, v] of Object.entries(partial)) {
        const c = controls.get(id);
        if (!c)
          throw new Error(
            `${where}: no control "${id}" (controls: ${[...controls.keys()].join(", ") || "none yet; call addControl first"})`,
          );
        out[id] = checkValue(c, v, where);
      }
      return out;
    }
    // restore: an undo/redo/jump sets values back; onChange (for edits) does not run, hooks see the values as usual.
    function applyControls(checked, { restore = false } = {}) {
      for (const [id, v] of Object.entries(checked)) {
        const c = controls.get(id);
        c.value = v;
        c.sync(v);
      }
      if (!restore) {
        for (const id of Object.keys(checked)) {
          const c = controls.get(id);
          if (c.spec.onChange) guard(`control "${id}"`, () => c.spec.onChange(c.value, api));
        }
      }
      applyPreviewFilter();
      boltOnChanged();
      emitChange();
    }
    // After `result` (a value or a promise) settles successfully, run fn.
    const after = (result, fn) =>
      result && typeof result.then === "function" ? result.then((r) => (fn(), r)) : (fn(), result);
    function emitChange() {
      if (!api || listeners.size === 0) return;
      const v = api.getValues();
      for (const cb of [...listeners]) guard("change listener", () => cb(v));
    }
    function getValues() {
      return { ...cfg.getValues(), controls: controlValues() };
    }
    function setValues(partial, label) {
      if (!isObj(partial))
        throw new TypeError("t3template.setValues(partial, label?) needs an object");
      const { controls: c, ...rest } = partial;
      const checked = c === undefined ? null : checkControls(c, "t3template.setValues");
      const text = label === undefined ? "Script Edit" : String(label);
      // Controls go first, so a template edit commits them in the same undo step; a template that rejects the edit
      // puts them back.
      let prev = null;
      if (checked) {
        flushCommit();
        prev = Object.fromEntries(Object.keys(checked).map((id) => [id, controls.get(id).value]));
        applyControls(checked);
      }
      let result;
      try {
        result = Object.keys(rest).length ? cfg.setValues(rest, text) : undefined;
      } catch (err) {
        if (prev) applyControls(prev, { restore: true });
        throw err;
      }
      // A no-op when the template step already holds the controls (history skips equal states).
      if (checked) result = after(result, () => commitStep(text));
      return result && typeof result.then === "function"
        ? result.then(() => getValues())
        : getValues();
    }
    function refresh() {
      applyPreviewFilter();
      boltOnChanged();
    }

    // ---- Panels, buttons, controls ----
    function addPanel(arg) {
      const title = typeof arg === "string" ? arg : isObj(arg) ? arg.title : undefined;
      if (typeof title !== "string" || !title.trim())
        throw new TypeError(
          "t3template.addPanel(title) needs a title: addPanel('Glow') or addPanel({ title: 'Glow', open, position })",
        );
      const key = title.trim();
      if (panels.has(key)) return panels.get(key);
      const open = isObj(arg) && arg.open !== undefined ? Boolean(arg.open) : true;
      const position = isObj(arg) && arg.position !== undefined ? arg.position : "top";
      if (position !== "top" && position !== "bottom")
        throw new TypeError(
          `t3template.addPanel("${key}"): position must be 'top' or 'bottom' (got ${show(position)})`,
        );
      const body = cfg.addPanel(key, { open, position });
      if (!(body instanceof HTMLElement))
        throw new Error(`templateRuntime(${cfg.id}): config.addPanel must return an element`);
      panels.set(key, body);
      return body;
    }
    function panelFor(panel) {
      if (panel instanceof HTMLElement) return panel;
      const title = panel === undefined ? DEFAULT_PANEL : panel;
      if (typeof title !== "string" || !title.trim())
        throw new TypeError("addControl: panel must be a panel title or an element from addPanel");
      return addPanel(title);
    }
    function addToolbarButton(label, onClick, opts = {}) {
      if (typeof label !== "string" || !label.trim())
        throw new TypeError(
          "t3template.addToolbarButton(label, onClick, { shortcut? }) needs a label",
        );
      if (typeof onClick !== "function")
        throw new TypeError("t3template.addToolbarButton(label, onClick) needs a function");
      if (!isObj(opts))
        throw new TypeError(
          "t3template.addToolbarButton: the third argument is { shortcut?, title? }",
        );
      const button = document.createElement("button");
      button.type = "button";
      button.className = cfg.buttonClass || `${P}action`;
      button.textContent = label;
      if (opts.title) button.title = String(opts.title);
      const run = () => guard(`toolbar button "${label}"`, () => onClick(api));
      button.addEventListener("click", run);
      let hint = "";
      if (opts.shortcut !== undefined) {
        const key = normalizeShortcut(opts.shortcut);
        if (reserved.has(key))
          throw new Error(
            `t3template.addToolbarButton: shortcut "${opts.shortcut}" is already used by ${cfg.id} (taken: ${[...reserved].join(", ")})`,
          );
        if (shortcuts.has(key))
          throw new Error(
            `t3template.addToolbarButton: shortcut "${opts.shortcut}" is already used by another bolt-on`,
          );
        shortcuts.set(key, run);
        hint = prettyShortcut(key);
        const kbd = document.createElement("kbd");
        kbd.className = `${P}kbd`;
        kbd.textContent = hint;
        button.append(kbd);
        button.title = `${button.title || label} (${hint})`;
      }
      cfg.toolbar.append(button);
      if (cfg.onCommand) cfg.onCommand(label, run, hint);
      // Native chrome: bolt-on buttons follow the template's own items (ids bolt.1, bolt.2, ...).
      boltButtons.push({
        type: "button",
        id: `bolt.${boltButtons.length + 1}`,
        label: label.trim(),
        ...(opts.shortcut !== undefined ? { shortcut: normalizeShortcut(opts.shortcut) } : {}),
        run,
      });
      scheduleChromeSync();
      return button;
    }
    document.addEventListener("keydown", (e) => {
      if (shortcuts.size === 0 || e.defaultPrevented || e.repeat || isTyping(e.target)) return;
      const run = shortcuts.get(eventShortcut(e));
      if (!run) return;
      e.preventDefault();
      run();
    });

    function addControl(spec) {
      if (!isObj(spec))
        throw new TypeError("t3template.addControl({ id, label, type, ... }) needs an object");
      needId("addControl", spec.id, (id) => controls.has(id));
      const type = spec.type === undefined ? "slider" : spec.type;
      if (!TYPES.includes(type))
        throw new TypeError(
          `t3template.addControl("${spec.id}"): type must be ${TYPES.join(", ")} (got ${show(spec.type)})`,
        );
      const s = { ...spec, type, label: spec.label === undefined ? spec.id : String(spec.label) };
      if (type === "slider") {
        s.min = spec.min === undefined ? 0 : spec.min;
        s.max = spec.max === undefined ? 1 : spec.max;
        if (!isNum(s.min) || !isNum(s.max) || s.max <= s.min)
          throw new RangeError(
            `t3template.addControl("${s.id}"): min and max must be numbers with min < max (got ${show(s.min)}, ${show(s.max)})`,
          );
        s.step = spec.step === undefined ? (s.max - s.min) / 100 : spec.step;
        if (!isNum(s.step) || s.step <= 0)
          throw new RangeError(
            `t3template.addControl("${s.id}"): step must be a positive number (got ${show(s.step)})`,
          );
      }
      if (type === "select") {
        if (!Array.isArray(spec.options) || spec.options.length === 0)
          throw new TypeError(
            `t3template.addControl("${s.id}"): a select needs options: ['a', 'b'] or [{ value, label }]`,
          );
        s.options = spec.options.map((o) =>
          isObj(o)
            ? { value: o.value, label: String(o.label === undefined ? o.value : o.label) }
            : { value: o, label: String(o) },
        );
      }
      if (type === "text") {
        s.maxLength = spec.maxLength === undefined ? TEXT_MAX : spec.maxLength;
        s.rows = spec.rows === undefined ? 1 : spec.rows;
        if (!Number.isInteger(s.maxLength) || s.maxLength < 1)
          throw new RangeError(
            `t3template.addControl("${s.id}"): maxLength must be a positive integer`,
          );
        if (!Number.isInteger(s.rows) || s.rows < 1 || s.rows > 12)
          throw new RangeError(`t3template.addControl("${s.id}"): rows must be 1..12`);
      }
      if (type === "button" && typeof spec.onClick !== "function")
        throw new TypeError(`t3template.addControl("${s.id}"): a button needs onClick(t3template)`);
      if (spec.onChange !== undefined && typeof spec.onChange !== "function")
        throw new TypeError(`t3template.addControl("${s.id}"): onChange must be a function`);
      if (spec.format !== undefined && typeof spec.format !== "function")
        throw new TypeError(
          `t3template.addControl("${s.id}"): format must be a function (value) => text`,
        );
      const host = panelFor(spec.panel);

      const c = { spec: s, value: undefined, initial: undefined, sync: () => {} };
      const fallback = {
        slider: s.min,
        toggle: false,
        select: s.options?.[0].value,
        color: "#ffffff",
        text: "",
      }[type];
      if (type !== "button") {
        c.value = checkValue(
          c,
          spec.default === undefined ? fallback : spec.default,
          `t3template.addControl("${s.id}") default`,
        );
        c.initial = c.value;
        // Precedence: saved edit > options.controls > default. A bad options value fails loudly; a stale saved one warns.
        if (Object.prototype.hasOwnProperty.call(seeds, s.id))
          c.value = checkValue(c, seeds[s.id], "options.controls");
        if (Object.prototype.hasOwnProperty.call(saved, s.id)) {
          try {
            c.value = checkValue(c, saved[s.id], "saved state");
          } catch (err) {
            console.warn(
              `[t3template] saved value for "${s.id}" no longer fits (${err.message}); keeping ${show(c.value)}`,
            );
          }
        }
      }

      const row = document.createElement("div");
      row.className = `${P}row`;
      const inputId = `${P}${cfg.id}-${s.id}`;
      const label = document.createElement("label");
      label.htmlFor = inputId;
      label.textContent = s.label;
      label.title = s.label;
      const out = document.createElement("output");
      const decimals =
        type === "slider" ? Math.min(4, Math.max(0, -Math.floor(Math.log10(s.step) + 1e-9))) : 0;
      const render = (v) => {
        if (type === "slider")
          out.textContent = s.format ? String(s.format(v)) : v.toFixed(decimals);
        else if (type === "toggle") out.textContent = v ? "On" : "Off";
        row.classList.toggle(`${P}edited`, v !== c.initial);
      };
      c.decimals = decimals;
      // A user edit applies at once (live preview) and becomes one undo step: a drag or a typing burst settles into a
      // single step on release/blur (or after a pause), a click on a toggle or select is a step of its own.
      const commit = (v) => applyControls({ [s.id]: v });
      const settle = (ms) => queueCommit(s.id, () => stepLabel(c), ms);
      const settleNow = () => {
        settle(0);
        flushCommit();
      };
      let input;
      if (type === "button") {
        row.classList.add(`${P}wide`);
        input = document.createElement("button");
        input.type = "button";
        input.className = `${P}action`;
        input.textContent = s.label;
        input.addEventListener("click", () => guard(`control "${s.id}"`, () => s.onClick(api)));
        row.append(input);
      } else {
        if (type === "slider") {
          input = document.createElement("input");
          input.type = "range";
          input.min = String(s.min);
          input.max = String(s.max);
          input.step = String(s.step);
          input.addEventListener("input", () => {
            commit(Number(input.value));
            settle(SETTLE_MS);
          });
          input.addEventListener("change", flushCommit);
          input.addEventListener("dblclick", () => {
            commit(c.initial);
            settleNow();
          });
        } else if (type === "toggle") {
          input = document.createElement("input");
          input.type = "checkbox";
          input.addEventListener("change", () => {
            commit(input.checked);
            settleNow();
          });
        } else if (type === "select") {
          input = document.createElement("select");
          s.options.forEach((o, i) => input.append(new Option(o.label, String(i))));
          input.addEventListener("change", () => {
            commit(s.options[Number(input.value)].value);
            settleNow();
          });
        } else if (type === "text") {
          row.classList.add(`${P}text`);
          input = document.createElement(s.rows > 1 ? "textarea" : "input");
          if (s.rows > 1) input.rows = s.rows;
          else input.type = "text";
          input.maxLength = s.maxLength;
          input.spellcheck = false;
          if (s.placeholder !== undefined) input.placeholder = String(s.placeholder);
          input.addEventListener("input", () => {
            commit(input.value);
            settle(TEXT_SETTLE_MS);
          });
          input.addEventListener("change", flushCommit);
        } else {
          input = document.createElement("input");
          input.type = "color";
          input.addEventListener("input", () => {
            commit(input.value.toLowerCase());
            settle(SETTLE_MS);
          });
          input.addEventListener("change", flushCommit);
        }
        c.sync = (v) => {
          if (type === "toggle") input.checked = v;
          else if (type === "select")
            input.value = String(s.options.findIndex((o) => o.value === v));
          else if (input.value !== String(v)) input.value = String(v);
          render(v);
        };
        input.id = inputId;
        row.append(label, input);
        if (type !== "text") row.append(out);
        c.sync(c.value);
      }
      host.append(row);
      controls.set(s.id, c);
      if (type !== "button") backfillHistory();
      applyPreviewFilter();
      if (type !== "button") boltOnChanged();
      return {
        id: s.id,
        element: row,
        get: () => c.value,
        set: (v) => {
          const checked = checkValue(c, v, `control "${s.id}".set`);
          flushCommit();
          applyControls({ [s.id]: checked });
          commitStep(stepLabel(c));
        },
        setLabel(text) {
          s.label = String(text);
          if (type === "button") input.textContent = s.label;
          else {
            label.textContent = s.label;
            label.title = s.label;
          }
        },
      };
    }

    // ---- Presets ----
    function addPreset(name, values) {
      if (typeof name !== "string" || !name.trim())
        throw new TypeError("t3template.addPreset(name, values) needs a non-empty name");
      if (!isObj(values))
        throw new TypeError("t3template.addPreset(name, values) needs a values object");
      const key = name.trim();
      const { controls: c, ...rest } = values;
      const checked = c === undefined ? null : checkControls(c, `t3template.addPreset("${key}")`);
      const hasTemplate = Object.keys(rest).length > 0;
      if (!hasTemplate && !checked)
        throw new TypeError(`t3template.addPreset("${key}"): values are empty`);
      if (hasTemplate) {
        if (!cfg.addPreset)
          throw new Error(`${cfg.id} has no template presets; use addPreset(name, { controls })`);
        cfg.addPreset(key, rest);
      }
      presets.set(key, { controls: checked, template: hasTemplate });
      return key;
    }
    // Controls first, so a template preset's undo step holds them too; one step either way.
    function applyPreset(name) {
      const p = presets.get(name);
      if ((!p || p.template) && !cfg.applyPreset)
        throw new Error(`t3template.applyPreset: no preset "${name}"`);
      if (p && p.controls) {
        flushCommit();
        applyControls(p.controls);
      }
      let result = !p || p.template ? cfg.applyPreset(name) : undefined;
      if (p && p.controls) result = after(result, () => commitStep(`Preset: ${name}`));
      return result;
    }

    // ---- History: control edits are undo steps; undo, redo and jump restore controls with the template state ----
    let hist = null; // { history, commit(label) } once the template calls linkHistory
    let pendingCommit = null; // { id, label(), timer }: the control edit still settling
    function stepLabel(c) {
      const s = c.spec;
      const v = c.value;
      if (s.type === "slider")
        return `${s.label} ${s.format ? s.format(v) : v.toFixed(c.decimals)}`;
      if (s.type === "toggle") return `${s.label} ${v ? "On" : "Off"}`;
      if (s.type === "select")
        return `${s.label}: ${s.options.find((o) => o.value === v)?.label ?? show(v)}`;
      if (s.type === "color") return `${s.label} ${v}`;
      return `Edit ${s.label}`;
    }
    function commitStep(label) {
      if (hist) guard("history", () => hist.commit(label));
    }
    function queueCommit(id, label, ms) {
      if (!hist) return;
      if (pendingCommit && pendingCommit.id !== id) flushCommit();
      if (pendingCommit) clearTimeout(pendingCommit.timer);
      pendingCommit = { id, label, timer: setTimeout(flushCommit, ms) };
    }
    function flushCommit() {
      if (!pendingCommit) return;
      const { label, timer } = pendingCommit;
      clearTimeout(timer);
      pendingCommit = null;
      commitStep(label());
    }
    const valueControls = () => [...controls.values()].filter((c) => c.spec.type !== "button");
    function withControls(state) {
      if (!valueControls().length) return state;
      if (!isObj(state))
        throw new TypeError(
          `templateRuntime(${cfg.id}): history states must be objects to carry control values`,
        );
      if (hasOwn(state, "controls"))
        throw new Error(
          `templateRuntime(${cfg.id}): "controls" in a history state is reserved for control values`,
        );
      return { ...state, controls: controlValues() };
    }
    // The active step, completed with the current control values (a preset or older step that lacks some).
    function writeActiveControls() {
      const st = hist.history.get().state;
      if (!isObj(st)) return;
      const { controls: _old, ...rest } = st;
      hist.history.set({ state: { ...rest, controls: controlValues() } });
    }
    function restoreState(applyState, s) {
      if (pendingCommit) {
        clearTimeout(pendingCommit.timer); // an edit still settling is superseded by the restored step
        pendingCommit = null;
      }
      if (!isObj(s)) return applyState(s);
      const { controls: saved, ...rest } = s;
      applyState(rest);
      if (!valueControls().length) return undefined;
      const changed = {};
      let partial = !isObj(saved);
      for (const c of valueControls()) {
        if (!isObj(saved) || !hasOwn(saved, c.spec.id)) {
          partial = true;
          continue;
        }
        try {
          const v = checkValue(c, saved[c.spec.id], "history step");
          if (v !== c.value) changed[c.spec.id] = v;
        } catch (err) {
          console.warn(`[t3template] ${err.message}; keeping ${show(c.value)}`);
          partial = true;
        }
      }
      if (Object.keys(changed).length) applyControls(changed, { restore: true });
      if (partial) writeActiveControls();
      return undefined;
    }
    // Steps recorded before a control existed get its current (starting) value, so undoing back to them resets it.
    function backfillHistory() {
      if (!hist) return;
      const values = controlValues();
      const m = hist.history.get();
      let touched = false;
      const entries = m.entries.map((e) => {
        if (!isObj(e.state)) return e;
        const have = isObj(e.state.controls) ? e.state.controls : {};
        const missing = Object.keys(values).filter((id) => !hasOwn(have, id));
        if (!missing.length) return e;
        touched = true;
        const { controls: _old, ...rest } = e.state;
        return {
          id: e.id,
          label: e.label,
          at: e.at,
          state: {
            ...rest,
            controls: { ...have, ...Object.fromEntries(missing.map((id) => [id, values[id]])) },
          },
        };
      });
      if (touched) hist.history.set({ entries, index: m.index });
    }
    function linkHistory(history, getState, applyState, options = {}) {
      if (hist) throw new Error(`templateRuntime(${cfg.id}): linkHistory() runs once`);
      if (!t3kit.links || typeof t3kit.links.historyState !== "function")
        throw new Error(
          `templateRuntime(${cfg.id}): linkHistory needs the links primitive in the template's kit`,
        );
      if (typeof getState !== "function" || typeof applyState !== "function")
        throw new TypeError(
          `templateRuntime(${cfg.id}): linkHistory(history, getState, applyState) needs two functions`,
        );
      if (!isObj(options))
        throw new TypeError(`templateRuntime(${cfg.id}): linkHistory options must be an object`);
      const { commit, ...linkOptions } = options;
      if (commit !== undefined && typeof commit !== "function")
        throw new TypeError(
          `templateRuntime(${cfg.id}): linkHistory commit must be (label) => void`,
        );
      let link = null;
      hist = { history, commit: (label) => (commit ? commit(label) : link.commit(label)) };
      link = t3kit.links.historyState(
        history,
        () => withControls(getState()),
        (s) => restoreState(applyState, s),
        linkOptions,
      );
      backfillHistory();
      return link;
    }

    // ---- Image pipeline ----
    function stageAt(name, id, opts) {
      if (opts === undefined) return "image";
      if (!isObj(opts))
        throw new TypeError(
          `t3template.${name}("${id}", ..., { at }): the options argument must be an object`,
        );
      const at = opts.at === undefined ? "image" : opts.at;
      if (!targets.includes(at))
        throw new RangeError(
          `t3template.${name}("${id}"): at must be ${targets.map((t) => `'${t}'`).join(" or ")} in ${cfg.id} (got ${show(at)})`,
        );
      return at;
    }
    function addImageStage(id, fn, opts) {
      needPipeline("addImageStage", "image");
      needId("addImageStage", id, (x) => stages.some((st) => st.id === x));
      if (typeof fn !== "function")
        throw new TypeError(
          `t3template.addImageStage("${id}", fn): fn({ canvas, context, width, height, scale, phase }, controls) is required`,
        );
      stages.push({ id, at: stageAt("addImageStage", id, opts), kind: "2d", fn, failed: "" });
      boltOnChanged();
      return id;
    }
    function addShaderStage(id, glsl, uniforms, opts) {
      needPipeline("addShaderStage", "image");
      needId("addShaderStage", id, (x) => stages.some((st) => st.id === x));
      if (typeof glsl !== "string" || !/void\s+main\s*\(/.test(glsl))
        throw new TypeError(
          `t3template.addShaderStage("${id}", glsl): glsl must be a fragment shader with void main()`,
        );
      if (uniforms !== undefined && uniforms !== null && typeof uniforms !== "function")
        throw new TypeError(
          `t3template.addShaderStage("${id}", glsl, uniforms): uniforms must be (controls, { width, height, scale }) => ({ u_name: value })`,
        );
      const at = stageAt("addShaderStage", id, opts);
      const program = compileShader(id, glsl);
      stages.push({
        id,
        at,
        kind: "shader",
        glsl,
        program,
        uniforms: uniforms || undefined,
        failed: "",
      });
      boltOnChanged();
      return id;
    }
    function removeStage(id) {
      const i = stages.findIndex((st) => st.id === id);
      if (i < 0) throw new Error(`t3template.removeStage: no stage "${id}"`);
      stages.splice(i, 1);
      boltOnChanged();
    }
    const hasImageStages = (at) => stages.some((st) => at === undefined || st.at === at);
    function runImageStages(canvas, { scale = 1, phase = "preview", at = "image", info } = {}) {
      if (!hasImageStages(at)) return canvas;
      if (!(canvas instanceof HTMLCanvasElement))
        throw new TypeError("runImageStages(canvas) needs a 2D <canvas>");
      const values = controlValues();
      for (const st of stages) {
        if (st.at !== at) continue;
        if (st.failed) {
          if (phase === "export")
            throw new Error(
              `image stage "${st.id}" failed on the preview (${st.failed}); fix the bolt-on before exporting`,
            );
          continue;
        }
        try {
          if (st.kind === "2d") {
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new Error("the canvas has no 2D context");
            const ctx = {
              ...info,
              canvas,
              context,
              width: canvas.width,
              height: canvas.height,
              scale,
              phase,
              copy: () => copyCanvas(canvas),
              random: (seed = "") => mulberry32(hashSeed(`${st.id}:${seed}`)),
            };
            context.save();
            try {
              st.fn(ctx, values);
            } finally {
              context.restore();
            }
          } else {
            runShader(st, canvas, values, scale);
          }
        } catch (err) {
          if (phase === "export") throw new Error(`image stage "${st.id}": ${messageOf(err)}`);
          st.failed = messageOf(err);
          reportError(err, `image stage "${st.id}"`);
        }
      }
      return canvas;
    }

    // ---- EDL pipeline ----
    function addHook(list, name, fn, shape) {
      needPipeline(name, "edl");
      if (typeof fn !== "function")
        throw new TypeError(`t3template.${name}(${shape}) needs a function`);
      list.push({ fn, failed: "", n: list.length + 1 });
      boltOnChanged();
    }
    function runHook(h, label, phase, call) {
      if (h.failed) {
        if (phase === "export")
          throw new Error(
            `${label} failed earlier (${h.failed}); fix the bolt-on before exporting`,
          );
        return undefined;
      }
      try {
        return call();
      } catch (err) {
        if (phase === "export") throw new Error(`${label}: ${messageOf(err)}`);
        h.failed = messageOf(err);
        reportError(err, label);
        return undefined;
      }
    }
    function transformEdl(edl, { phase = "export", info } = {}) {
      let out = clone(edl);
      const values = controlValues();
      const hookInfo = { ...info, phase };
      for (const t of transforms) {
        const next = runHook(t, `edl transform ${t.n}`, phase, () => {
          const r = t.fn(out, values, hookInfo);
          if (!isObj(r)) throw new TypeError("must return the edl object");
          return r;
        });
        if (next) out = next;
      }
      return out;
    }
    function exportFilters(edl, { phase = "export", info } = {}) {
      const fx = { video: [], audio: [], notes: [] };
      const values = controlValues();
      const hookInfo = { ...info, phase };
      for (const h of notes) {
        if (h.kind === "audio") {
          runHook(h, `audio filter "${h.id}"`, phase, () => {
            for (const f of audioFiltersOf(h, values)) {
              const text = audioFfmpeg(f);
              if (text) fx.audio.push(text);
            }
          });
          continue;
        }
        runHook(h, `export note ${h.n}`, phase, () => {
          const r = h.fn(clone(edl), values, hookInfo);
          if (r === undefined || r === null || r === "") return;
          if (typeof r === "string") return void fx.notes.push(r);
          if (!isObj(r))
            throw new TypeError(
              `must return a string or { note?, videoFilter?, audioFilter? } (got ${show(r)})`,
            );
          for (const [k, v] of Object.entries(r)) {
            if (!["note", "videoFilter", "audioFilter"].includes(k))
              throw new TypeError(`unknown key "${k}" (use note, videoFilter, audioFilter)`);
            if (v !== undefined && v !== null && typeof v !== "string")
              throw new TypeError(`${k} must be a string (got ${show(v)})`);
          }
          if (r.note) fx.notes.push(r.note);
          if (r.videoFilter) fx.video.push(r.videoFilter);
          if (r.audioFilter) fx.audio.push(r.audioFilter);
        });
      }
      return fx;
    }
    // ---- Audio filters (edl): addAudioFilter shares the export-note list, so ffmpeg keeps the order they were added ----
    const audioSinks = new Map(); // audioPreview instance -> { sig, nodes }
    function audioFiltersOf(h, values) {
      const r = h.fn(values);
      if (r === undefined || r === null || r === false) return [];
      const list = Array.isArray(r) ? r : [r];
      return list.map((f, i) =>
        checkAudioFilter(f, list.length > 1 ? `filter ${i + 1}` : "filter"),
      );
    }
    function previewAudioFilters() {
      const values = controlValues();
      const out = [];
      for (const h of notes) {
        if (h.kind !== "audio") continue;
        const list = runHook(h, `audio filter "${h.id}"`, "preview", () =>
          audioFiltersOf(h, values),
        );
        if (list) out.push(...list);
      }
      return out;
    }
    const audioSig = (list) => list.map((f) => f.type).join(",");
    // Same filter types in the same order: glide the live nodes' params. Otherwise the instance rebuilds its chain.
    function refreshAudio() {
      if (!cfg.audioPreview) return;
      const targets = cfg.audioPreview();
      if (!Array.isArray(targets))
        throw new TypeError(
          `templateRuntime(${cfg.id}): config.audioPreview() must return an array of instances`,
        );
      const list = previewAudioFilters();
      const sig = audioSig(list);
      for (const target of targets) {
        if (!target || typeof target.setAudioChain !== "function")
          throw new TypeError(
            `templateRuntime(${cfg.id}): config.audioPreview() must return instances with setAudioChain()`,
          );
        const sink = audioSinks.get(target);
        if (sink && sink.sig === sig) {
          if (sink.nodes) sink.nodes.forEach((n, i) => n.update(list[i]));
          continue;
        }
        const next = { sig, nodes: null };
        audioSinks.set(target, next);
        target.setAudioChain((ctx, input) => {
          const now = previewAudioFilters(); // built when the instance has a context: read the current values then
          const chain = buildAudioChain(ctx, input, now);
          next.sig = audioSig(now);
          next.nodes = chain.nodes;
          return chain.output;
        });
      }
    }
    function addAudioFilter(id, fn) {
      needPipeline("addAudioFilter", "edl");
      if (!cfg.audioPreview)
        throw new TypeError(
          `t3template.addAudioFilter: ${cfg.id} has no audio preview; use addExportNote({ audioFilter })`,
        );
      needId("addAudioFilter", id, (x) => notes.some((h) => h.id === x));
      if (typeof fn !== "function")
        throw new TypeError(
          `t3template.addAudioFilter("${id}", fn): fn(controls) => filter | [filter] | null is required`,
        );
      const hook = { kind: "audio", id, fn, failed: "", n: notes.length + 1 };
      try {
        audioFiltersOf(hook, controlValues()); // a bad description fails here, at the call, not on first play
      } catch (err) {
        throw new Error(
          `t3template.addAudioFilter("${id}"): ${messageOf(err)} (add the controls it reads first)`,
        );
      }
      notes.push(hook);
      boltOnChanged();
      return id;
    }
    // { ffmpeg: 'a,b', filters: [...] }: what the preview plays and the export renders right now.
    function describeAudioFilters() {
      const filters = previewAudioFilters();
      return {
        filters,
        ffmpeg: filters.map(audioFfmpeg).filter(Boolean).join(","),
        live: [...audioSinks.values()].some((x) => x.nodes),
      };
    }

    // ---- Export: every template returns { files: [{ name, type, size, width?, height? }], ffmpeg? } ----
    async function runExport() {
      const r = await cfg.export();
      const files =
        r instanceof Blob
          ? [r]
          : Array.isArray(r)
            ? r
            : isObj(r) && Array.isArray(r.files)
              ? r.files
              : null;
      if (!files || files.length === 0) throw new Error(`${cfg.id}: the export produced no files`);
      const out = [];
      for (const f of files) {
        if (!(f instanceof Blob))
          throw new TypeError(
            `templateRuntime(${cfg.id}): config.export() must resolve to Files (got ${show(f)})`,
          );
        const d = { name: typeof f.name === "string" ? f.name : "", type: f.type, size: f.size };
        if (/^image\//.test(f.type)) {
          const bmp = await createImageBitmap(f);
          d.width = bmp.width;
          d.height = bmp.height;
          bmp.close();
        }
        out.push(d);
      }
      const result = { files: out };
      if (cfg.pipeline === "edl") {
        const ff = isObj(r) && !(r instanceof Blob) ? r.ffmpeg : undefined;
        if (
          !Array.isArray(ff) ||
          !ff.length ||
          !ff.every((x) => typeof x === "string" && x.trim())
        ) {
          throw new Error(
            `templateRuntime(${cfg.id}): an EDL export must resolve to { files, ffmpeg: [command, ...] }`,
          );
        }
        result.ffmpeg = ff.slice();
      }
      return result;
    }

    // ---- Native chrome: the template's toolbar (and sidebar) rendered by T3, mapped back to the same actions ----
    let chromeMode = "page";
    let chromeSent = "";
    let chromeTimer = 0;
    const chromeHandlers = new Map(); // chrome id -> run(value?)
    const boltButtons = []; // bolt-on toolbar buttons, projected after the template's items
    let chromeTrimWarned = false;
    function chromeEntry(entry) {
      const { run, ...rest } = entry;
      if (typeof run === "function" && typeof rest.id === "string")
        chromeHandlers.set(rest.id, run);
      return rest;
    }
    function buildChrome() {
      chromeHandlers.clear();
      const values = {};
      const toolbar = (cfg.chrome.toolbar ? cfg.chrome.toolbar() : []).map((item) => {
        const out = chromeEntry(item);
        if (out.type === "menu") out.items = item.items.map(chromeEntry);
        if (hasOwn(out, "value")) values[out.id] = out.value;
        return out;
      });
      if (boltButtons.length) {
        // T3 takes at most 24 toolbar items; buttons past that stay in the page's command list and shortcuts only.
        const room = Math.max(0, CHROME_TOOLBAR_MAX - toolbar.length - 1);
        if (boltButtons.length > room && !chromeTrimWarned) {
          chromeTrimWarned = true;
          console.warn(
            `[t3template] ${cfg.id}: T3's toolbar holds ${CHROME_TOOLBAR_MAX} items; ${boltButtons.length - room} bolt-on button(s) are not in it`,
          );
        }
        if (room > 0)
          toolbar.push({ type: "separator" }, ...boltButtons.slice(0, room).map(chromeEntry));
      }
      const patch = { toolbar };
      if (cfg.chrome.sidebar) {
        patch.sidebar = cfg.chrome.sidebar().map((section) => {
          const out = chromeEntry(section);
          values[out.id] = out.value === undefined ? null : out.value;
          return out;
        });
      }
      patch.values = values;
      return patch;
    }
    function onChromeCommand(cmd) {
      if (!isObj(cmd) || typeof cmd.id !== "string") return;
      const run = chromeHandlers.get(cmd.id);
      if (!run) {
        console.warn(`[t3template] ${cfg.id}: no action for chrome command "${cmd.id}"`);
        return;
      }
      guard(`command "${cmd.id}"`, () => run(cmd.value));
      chromeSent = ""; // T3 now holds the clicked value: resend ours even if it looks unchanged
      scheduleChromeSync();
    }
    // T3 answers setChrome with an error when this workspace has no native chrome: the page keeps its own UI.
    function connectChrome() {
      const ws = window.t3 && window.t3.workspace;
      if (!cfg.chrome || !ws || typeof ws.setChrome !== "function") return;
      const patch = buildChrome();
      chromeMode = "pending";
      chromeSent = JSON.stringify(patch);
      Promise.resolve(ws.setChrome(patch)).then(
        () => {
          chromeMode = "native";
          ws.on("command", onChromeCommand);
          guard(cfg.id, () => cfg.chrome.native(true));
          scheduleChromeSync();
        },
        (err) => {
          chromeMode = "page";
          chromeSent = "";
          console.info(`[t3template] ${cfg.id}: in-page toolbar (${messageOf(err)})`);
        },
      );
    }
    function scheduleChromeSync() {
      if (chromeMode !== "native" || chromeTimer) return;
      chromeTimer = setTimeout(() => {
        chromeTimer = 0;
        const patch = guard("native chrome", buildChrome);
        if (!patch) return;
        const json = JSON.stringify(patch);
        if (json === chromeSent) return;
        chromeSent = json;
        Promise.resolve(window.t3.workspace.setChrome(patch)).then(null, (err) =>
          reportError(err, "native chrome"),
        );
      }, 30);
    }

    function previewFilter(info = previewInfo) {
      const values = controlValues();
      const parts = [];
      for (const h of previewFilters) {
        const css = runHook(h, `preview filter ${h.n}`, "preview", () => {
          const r = h.fn(values, info);
          if (r !== undefined && r !== null && typeof r !== "string")
            throw new TypeError(
              `must return a CSS filter string like 'contrast(1.2)' (got ${show(r)})`,
            );
          return r;
        });
        if (css) parts.push(css);
      }
      return parts.join(" ");
    }
    function applyPreviewFilter() {
      if (previewFilters.length && cfg.previewTarget)
        cfg.previewTarget.style.filter = previewFilter();
    }

    // ---- Overlays (edl picture templates): drawn once per control change, shown in their time range ----
    let overlayCanvas = null;
    let overlayShown = "";
    function frameInfo() {
      if (!cfg.frame) throw new Error(`t3template.addOverlay: ${cfg.id} has no picture`);
      const f = cfg.frame();
      if (!isObj(f) || !(f.width > 0) || !(f.height > 0) || !isNum(f.duration))
        throw new Error(
          `templateRuntime(${cfg.id}): config.frame() must return { width, height, duration }`,
        );
      return f;
    }
    function overlayRange(o, values, frame, phase) {
      if (!o.timing) return { start: 0, end: frame.duration };
      const r = runHook(o, `overlay "${o.id}" timing`, phase, () => {
        const t = o.timing(values, { duration: frame.duration });
        if (t === null || t === undefined) return null;
        if (!isObj(t) || !isNum(t.start) || !isNum(t.end))
          throw new TypeError(
            `must return { start, end } in edit seconds or null (got ${show(t)})`,
          );
        return { start: Math.max(0, t.start), end: Math.min(frame.duration, t.end) };
      });
      return r && r.end > r.start ? r : null;
    }
    function drawOverlay(o, width, height, scale, phase, values) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      const context = canvas.getContext("2d");
      const ok = runHook(o, `overlay "${o.id}"`, phase, () => {
        o.draw(
          { canvas, context, width: canvas.width, height: canvas.height, scale, phase },
          values,
        );
        return true;
      });
      return ok ? canvas : null;
    }
    function invalidateOverlays() {
      for (const o of overlays) o.cache = null;
      overlayShown = "";
      if (overlays.length) paintOverlays();
    }
    function paintOverlays() {
      const host = cfg.previewTarget;
      if (!host || !overlays.length) return;
      if (!overlayCanvas) {
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        overlayCanvas = document.createElement("canvas");
        overlayCanvas.className = `${P}overlay`;
        host.append(overlayCanvas);
        new ResizeObserver(() => invalidateOverlays()).observe(host);
      }
      const frame = frameInfo();
      const values = controlValues();
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.max(1, Math.round(host.clientWidth * dpr));
      const bh = Math.max(1, Math.round(host.clientHeight * dpr));
      const k = Math.min(bw / frame.width, bh / frame.height);
      const rect = { w: frame.width * k, h: frame.height * k };
      rect.x = (bw - rect.w) / 2;
      rect.y = (bh - rect.h) / 2;
      const t = previewInfo.time || 0;
      const visible = overlays.filter((o) => {
        const r = overlayRange(o, values, frame, "preview");
        return r && t >= r.start && t < r.end;
      });
      const key = `${bw}x${bh}:${visible.map((o) => o.id).join(",")}`;
      if (key === overlayShown) return;
      overlayShown = key;
      if (overlayCanvas.width !== bw || overlayCanvas.height !== bh) {
        overlayCanvas.width = bw;
        overlayCanvas.height = bh;
      }
      const ctx = overlayCanvas.getContext("2d");
      ctx.clearRect(0, 0, bw, bh);
      for (const o of visible) {
        if (!o.cache) o.cache = drawOverlay(o, rect.w, rect.h, k, "preview", values);
        if (o.cache) ctx.drawImage(o.cache, rect.x, rect.y, rect.w, rect.h);
      }
    }
    function setPreviewTime(time, info) {
      previewInfo = { ...info, time: isNum(time) ? time : 0 };
      applyPreviewFilter();
      if (overlays.length) paintOverlays();
    }
    function renderOverlays({ phase = "export" } = {}) {
      if (!overlays.length) return [];
      const frame = frameInfo();
      const values = controlValues();
      const out = [];
      for (const o of overlays) {
        const range = overlayRange(o, values, frame, phase);
        if (!range) continue;
        const canvas = drawOverlay(o, frame.width, frame.height, 1, phase, values);
        if (canvas) out.push({ id: o.id, canvas, start: range.start, end: range.end });
      }
      return out;
    }
    // Stills: every overlay visible at `time`, drawn at the canvas size.
    function drawOverlays(canvas, time) {
      if (!overlays.length) return canvas;
      const frame = frameInfo();
      const values = controlValues();
      const ctx = canvas.getContext("2d");
      for (const o of overlays) {
        const r = overlayRange(o, values, frame, "export");
        if (!r || time < r.start || time >= r.end) continue;
        const img = drawOverlay(
          o,
          canvas.width,
          canvas.height,
          canvas.width / frame.width,
          "export",
          values,
        );
        if (img) ctx.drawImage(img, 0, 0);
      }
      return canvas;
    }
    function addOverlay(id, draw, timing) {
      needPipeline("addOverlay", "edl");
      if (!cfg.previewTarget || !cfg.frame)
        throw new TypeError(`t3template.addOverlay: ${cfg.id} has no picture to draw on`);
      needId("addOverlay", id, (x) => overlays.some((o) => o.id === x));
      if (typeof draw !== "function")
        throw new TypeError(
          `t3template.addOverlay("${id}", draw): draw({ canvas, context, width, height, scale, phase }, controls) is required`,
        );
      if (timing !== undefined && typeof timing !== "function")
        throw new TypeError(
          `t3template.addOverlay("${id}", draw, timing): timing must be (controls, { duration }) => ({ start, end }) | null`,
        );
      overlays.push({ id, draw, timing, failed: "", n: overlays.length + 1, cache: null });
      boltOnChanged();
      return id;
    }

    // ---- Publish ----
    function publish({ instances = {}, extras = {}, saved: savedValues } = {}) {
      if (api) throw new Error(`templateRuntime(${cfg.id}): publish() runs once`);
      saved = isObj(savedValues) ? savedValues : {};
      api = {
        instances,
        getValues,
        setValues,
        on(event, cb) {
          if (event !== "change")
            throw new Error(`t3template.on: unknown event "${event}" (use "change")`);
          if (typeof cb !== "function")
            throw new TypeError("t3template.on('change', cb) needs a function");
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        refresh,
        export: runExport,
        addPanel,
        addToolbarButton,
        addControl,
        addPreset,
        applyPreset,
        addImageStage,
        addShaderStage,
        removeStage,
        addEdlTransform: (fn) =>
          addHook(transforms, "addEdlTransform", fn, "(edl, controls, info) => edl"),
        addExportNote: (fn) =>
          addHook(
            notes,
            "addExportNote",
            fn,
            "(edl, controls, info) => string | { note, videoFilter, audioFilter }",
          ),
        addPreviewFilter(fn) {
          needPipeline("addPreviewFilter", "edl");
          if (!cfg.previewTarget)
            throw new TypeError(
              `t3template.addPreviewFilter: ${cfg.id} has no picture to preview; use addExportNote({ audioFilter })`,
            );
          addHook(previewFilters, "addPreviewFilter", fn, "(controls, info) => CSS filter");
          applyPreviewFilter();
        },
        addOverlay,
        addAudioFilter,
      };
      if (cfg.pipeline === "edl" && cfg.audioPreview) api.audioFilters = describeAudioFilters;
      for (const [k, v] of Object.entries(extras)) {
        if (CORE.includes(k))
          throw new Error(
            `templateRuntime(${cfg.id}): extra "${k}" would replace a core t3template method`,
          );
        api[k] = v;
      }
      window.t3template = api;
      connectChrome();
      return api;
    }
    // options.controls seeds control values; ids no control claimed are an error once the script has run.
    function checkSeeds() {
      const unknown = Object.keys(seeds).filter((id) => !controls.has(id));
      if (unknown.length)
        reportError(
          new Error(
            `options.controls: no control ${unknown.map((id) => `"${id}"`).join(", ")} (controls: ${[...controls.keys()].join(", ") || "none"})`,
          ),
          "options",
        );
    }
    function runCustomScript(code, options) {
      if (!api) throw new Error(`templateRuntime(${cfg.id}): publish() before runCustomScript()`);
      const seed = isObj(options) ? options.controls : undefined;
      if (seed !== undefined && !isObj(seed)) {
        reportError(
          new TypeError(
            `options.controls must be an object like { glow: 0.5 } (got ${show(seed)})`,
          ),
          "options",
        );
      } else seeds = seed || {};
      if (typeof code !== "string" || !code.trim()) return void checkSeeds();
      try {
        const r = new Function("t3template", "options", code)(api, clone(options));
        if (r && typeof r.then === "function")
          r.then(checkSeeds, (err) => reportError(err, "customScript"));
        else checkSeeds();
      } catch (err) {
        reportError(err, "customScript");
      }
    }

    return {
      publish,
      linkHistory,
      syncChrome: scheduleChromeSync,
      chromeMode: () => chromeMode,
      runCustomScript,
      reportError,
      showBanner: (text) => showBanner(text, "notice"),
      emitChange,
      refresh,
      state: controlValues,
      hasImageStages,
      runImageStages,
      transformEdl,
      exportFilters,
      previewFilter,
      setPreviewTime,
      hasOverlays: () => overlays.length > 0,
      renderOverlays,
      drawOverlays,
    };
  }

  t3kit.templateRuntime = { create };
})();
