/**
 * t3kit.develop: WebGL2 photo develop (Lightroom Basic + Presence + Effects, tone curves, 8-band HSL).
 *
 * create(container, options?) -> instance
 *   options.controls     default true: slider panel beside the image (stacks below under 560px).
 *                        false = canvas only; drive it with set().
 *   options.values       initial partial params, same shape as set().
 *   options.previewSize  longest edge of the GPU preview texture, default 2048. Export is always full size.
 *
 * instance
 *   setImage(blob | url)  -> Promise<{width,height} | null>  full source size; null if superseded. Params kept.
 *   get()                 -> {exposure, ..., grain, hsl, curves}  JSON-safe copy.
 *   set(partial)          merge params; re-renders; throws on unknown keys or out-of-range values. No 'change'.
 *   reset()               every param, hsl and curves back to default. No 'change'.
 *   exportBlob({type, quality}) -> Promise<Blob>  FULL source resolution; type default 'image/jpeg', quality 0.92.
 *   getImageData()        ImageData of the developed look, longest edge <= 512, rows top-first.
 *   histogram()           {rgb, r, g, b}: 256 counts each (rgb = luminance) of the developed look;
 *                         feeds curves.setHistogram() or a histogram primitive directly.
 *   on(event, cb)         -> unsubscribe. 'change': user moved a control, payload get(); 'load': {width,height};
 *                         'render': the shown look changed (setImage/set/edits, once per frame); read histogram() here.
 *   destroy()
 *
 * Params (all default 0): exposure -5..5 (EV); contrast, highlights, shadows, whites, blacks,
 *   temperature (+ warm), tint (+ magenta), vibrance, saturation, clarity, dehaze,
 *   vignette (- darkens edges) -100..100; grain 0..100.
 * hsl: {hue, sat, lum}, each 8 numbers -100..100 in band order Red Orange Yellow Green Aqua Blue
 *   Purple Magenta. Partial objects merge per channel: set({hsl: {sat: [...]}}).
 * curves: null | {rgb?, r?, g?, b?}, each 256 output levels 0..255 (identity lut[i] = i, as curves.lut()
 *   returns). rgb is applied first, then r/g/b. Missing channels are identity; null clears all.
 *   If your r/g/b already include the master curve, pass only {r, g, b}.
 *
 * Renders on demand (one frame per edit, nothing while idle) from the preview. Requires WebGL2; throws without it.
 *
 * @example
 *   const dev = t3kit.develop.create(el);
 *   await dev.setImage(blob);
 *   dev.set({ exposure: 0.4, shadows: 30, highlights: -35, vibrance: 20, hsl: { sat: [0,0,0,0,0,25,0,0] } });
 *   dev.on('change', (v) => save(v));
 *   const jpeg = await dev.exportBlob({ type: 'image/jpeg', quality: 0.92 });
 */
(function () {
  "use strict";
  const t3kit = (window.t3kit = window.t3kit || {});

  // ---- Parameters -----------------------------------------------------------
  const NUMERIC = [
    "exposure",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "temperature",
    "tint",
    "vibrance",
    "saturation",
    "clarity",
    "dehaze",
    "vignette",
    "grain",
  ];
  const DEFAULT_RANGE = [-100, 100];
  const RANGE = { exposure: [-5, 5], grain: [0, 100] };
  const DEFAULTS = Object.fromEntries(NUMERIC.map((key) => [key, 0]));
  const LABEL = {
    exposure: "Exposure",
    contrast: "Contrast",
    highlights: "Highlights",
    shadows: "Shadows",
    whites: "Whites",
    blacks: "Blacks",
    temperature: "Temperature",
    tint: "Tint",
    vibrance: "Vibrance",
    saturation: "Saturation",
    clarity: "Clarity",
    dehaze: "Dehaze",
    vignette: "Vignette",
    grain: "Grain",
  };
  const SECTIONS = [
    { title: "Light", keys: ["exposure", "contrast", "highlights", "shadows", "whites", "blacks"] },
    { title: "Color", keys: ["temperature", "tint", "vibrance", "saturation"] },
    { title: "Presence", keys: ["clarity", "dehaze"] },
    { title: "Effects", keys: ["vignette", "grain"] },
  ];
  const BANDS = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"];
  const HSL_CHANNELS = [
    ["hue", "Hue"],
    ["sat", "Saturation"],
    ["lum", "Luminance"],
  ];
  const CURVE_KEYS = ["rgb", "r", "g", "b"];
  const PARAM_KEYS = [...NUMERIC, "hsl", "curves"];

  // ---- Sizes and limits -----------------------------------------------------
  const BLUR_EDGE = 256; // local-contrast source; low frequency, so resolution-independent
  const HIST_EDGE = 512; // histogram readback size
  const GRAIN_CELLS = 900; // grain cells across the long edge, so preview and export match
  const MAX_CANVAS_EDGE = 4096;
  const NARROW_PX = 560; // below this root width the panel stacks under the image
  const STAGE_PAD = 16; // CSS px of breathing room around the photo

  const CTX_PREVIEW = {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
  };
  const CTX_EXPORT = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
  };

  // ---- Shaders --------------------------------------------------------------
  // Every texture is stored top row first (no UNPACK_FLIP_Y, which ImageBitmap uploads ignore).
  // Passes into a framebuffer object keep that order; passes onto a canvas flip with uFlipY.
  const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  // One pass. Order: exposure, tone regions, clarity and dehaze, contrast, white balance,
  // HSL, vibrance and saturation, curves, vignette, grain.
  const FRAG_DEVELOP = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform sampler2D uBlur;
uniform sampler2D uCurves;
uniform int uUseCurves;
uniform int uUseHsl;
uniform float uFlipY;
uniform float uHslHue[8];
uniform float uHslSat[8];
uniform float uHslLum[8];
uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uTemp;
uniform float uTint;
uniform float uVibrance;
uniform float uSaturation;
uniform float uClarity;
uniform float uDehaze;
uniform float uVignette;
uniform float uGrain;
uniform float uAspect;
uniform vec2 uGrainCells;

const float BAND_CENTER[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0);

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// Triangular band weights around each hue centre (max gap 60 deg, width 40, so every hue
// has weight), normalised so overlapping bands blend. Effect fades in with saturation.
vec3 applyHsl(vec3 c) {
  vec3 hsv = rgb2hsv(c);
  if (hsv.y < 0.001) return c;
  float hue = hsv.x * 360.0;
  float dh = 0.0;
  float ds = 0.0;
  float dl = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < 8; i++) {
    float d = abs(hue - BAND_CENTER[i]);
    d = min(d, 360.0 - d);
    float w = max(0.0, 1.0 - d / 40.0);
    dh += w * uHslHue[i];
    ds += w * uHslSat[i];
    dl += w * uHslLum[i];
    wsum += w;
  }
  float amt = smoothstep(0.0, 0.25, hsv.y);
  dh = dh / wsum * amt; ds = ds / wsum * amt; dl = dl / wsum * amt;
  hsv.x = fract(hsv.x + dh * (30.0 / 360.0));
  hsv.y = clamp(hsv.y * (1.0 + ds), 0.0, 1.0);
  hsv.z = clamp(hsv.z * (1.0 + dl * 0.35), 0.0, 1.0);
  return hsv2rgb(hsv);
}

float curveAt(float v, float row) {
  return texture(uCurves, vec2((clamp(v, 0.0, 1.0) * 255.0 + 0.5) / 256.0, row)).r;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vec2(vUv.x, mix(vUv.y, 1.0 - vUv.y, uFlipY));
  vec3 src = texture(uSrc, uv).rgb;
  vec3 blur = texture(uBlur, uv).rgb;
  vec3 detail = src - blur;

  // Exposure in linear light, then back to display encoding.
  vec3 c = pow(src, vec3(2.2)) * uExposure;
  c = clamp(pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)), 0.0, 1.0);

  // Blacks, shadows, highlights, whites: smooth luma-band lifts.
  float Y = luma(c);
  float wBlack = 1.0 - smoothstep(0.0, 0.3, Y);
  float wShadow = smoothstep(0.05, 0.35, Y) * (1.0 - smoothstep(0.35, 0.6, Y));
  float wHigh = smoothstep(0.4, 0.65, Y) * (1.0 - smoothstep(0.65, 0.95, Y));
  float wWhite = smoothstep(0.7, 1.0, Y);
  c += uBlacks * 0.25 * wBlack + uShadows * 0.3 * wShadow
     + uHighlights * 0.3 * wHigh + uWhites * 0.25 * wWhite;
  c = clamp(c, 0.0, 1.0);

  // Presence: clarity adds midtone local contrast; dehaze removes haze via the blur's dark channel.
  Y = luma(c);
  c += uClarity * 1.2 * 4.0 * Y * (1.0 - Y) * detail;
  float haze = min(blur.r, min(blur.g, blur.b));
  if (uDehaze >= 0.0) {
    float k = 0.7 * uDehaze * haze;
    c = (c - k) / max(1.0 - k, 0.2);
  } else {
    c = mix(c, vec3(max(haze, 0.6)), -uDehaze * 0.4);
  }
  c = clamp(c, 0.0, 1.0);

  // Contrast: S-curve for positive, flatten for negative.
  if (uContrast >= 0.0) {
    c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
  } else {
    c = 0.5 + (c - 0.5) * (1.0 + uContrast * 0.7);
  }

  // White balance: temperature (blue to amber), tint (green to magenta).
  c *= vec3(1.0 + 0.18 * uTemp + 0.05 * uTint, 1.0 - 0.10 * uTint, 1.0 - 0.18 * uTemp + 0.05 * uTint);
  c = clamp(c, 0.0, 1.0);

  if (uUseHsl == 1) c = applyHsl(c);

  // Vibrance boosts low-chroma pixels more; saturation scales everything.
  float g = luma(c);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float chroma = (mx - mn) / max(mx, 1.0e-4);
  c = clamp(mix(vec3(g), c, 1.0 + uSaturation + uVibrance * (1.0 - chroma)), 0.0, 1.0);

  // Curves: master RGB first, then per-channel R, G, B. LUT rows are 0.125, 0.375, 0.625, 0.875.
  if (uUseCurves == 1) {
    c = vec3(curveAt(c.r, 0.125), curveAt(c.g, 0.125), curveAt(c.b, 0.125));
    c = vec3(curveAt(c.r, 0.375), curveAt(c.g, 0.625), curveAt(c.b, 0.875));
  }

  // Vignette: negative darkens the edges, positive lifts them toward white.
  vec2 q = (uv - 0.5) * vec2(uAspect, 1.0);
  float vr = length(q) / (0.5 * length(vec2(uAspect, 1.0)));
  float vig = smoothstep(0.35, 1.0, vr);
  c *= 1.0 - max(-uVignette, 0.0) * 0.85 * vig;
  c = mix(c, vec3(1.0), max(uVignette, 0.0) * 0.5 * vig);

  // Grain: static, deterministic, sized relative to the image so preview and export match.
  vec2 cell = floor(uv * uGrainCells);
  float n = hash12(cell) + hash12(cell + vec2(17.0, 31.0)) - 1.0;
  c += n * uGrain * 0.12;

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

  // Block-average downsample: n*n bilinear taps spaced two source texels apart.
  const FRAG_DOWN = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform int uN;
void main() {
  vec3 acc = vec3(0.0);
  for (int j = 0; j < uN; j++) {
    for (int i = 0; i < uN; i++) {
      vec2 off = (vec2(float(i), float(j)) - float(uN - 1) * 0.5) * 2.0 * uSrcTexel;
      acc += texture(uSrc, vUv + off).rgb;
    }
  }
  fragColor = vec4(acc / float(uN * uN), 1.0);
}`;

  // Separable 9-tap Gaussian; uStep is one texel along the blur axis in UV units.
  const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uStep;
void main() {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    float x = float(i);
    float w = exp(-x * x / 16.0);
    acc += w * texture(uSrc, vUv + uStep * (2.0 * x)).rgb;
    wsum += w;
  }
  fragColor = vec4(acc / wsum, 1.0);
}`;

  const DEVELOP_UNIFORMS = [
    "uSrc",
    "uBlur",
    "uCurves",
    "uUseCurves",
    "uUseHsl",
    "uFlipY",
    "uHslHue",
    "uHslSat",
    "uHslLum",
    "uExposure",
    "uContrast",
    "uHighlights",
    "uShadows",
    "uWhites",
    "uBlacks",
    "uTemp",
    "uTint",
    "uVibrance",
    "uSaturation",
    "uClarity",
    "uDehaze",
    "uVignette",
    "uGrain",
    "uAspect",
    "uGrainCells",
  ];

  // ---- Small helpers --------------------------------------------------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function emptyHsl() {
    return { hue: new Array(8).fill(0), sat: new Array(8).fill(0), lum: new Array(8).fill(0) };
  }

  function checkValue(label, value, min, max) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new RangeError(
        `develop: ${label} must be a number from ${min} to ${max}, got ${value}`,
      );
    }
    return value;
  }

  function normalizeHsl(prev, next) {
    if (!next || typeof next !== "object")
      throw new TypeError("develop: hsl must be {hue?, sat?, lum?}");
    const out = { hue: prev.hue.slice(), sat: prev.sat.slice(), lum: prev.lum.slice() };
    for (const key of Object.keys(next)) {
      if (!(key in out))
        throw new Error(`develop: unknown hsl channel "${key}" (use hue, sat, lum)`);
      const arr = next[key];
      if (!arr || typeof arr.length !== "number" || arr.length !== 8) {
        throw new TypeError(`develop: hsl.${key} needs 8 numbers (Red..Magenta)`);
      }
      out[key] = Array.from(arr, (v, i) => checkValue(`hsl.${key}[${i}]`, v, -100, 100));
    }
    return out;
  }

  function identityLut() {
    return Array.from({ length: 256 }, (_, i) => i);
  }

  // Missing channels become identity; arrays and typed arrays are accepted.
  function normalizeCurves(curves) {
    if (curves === null) return null;
    if (!curves || typeof curves !== "object")
      throw new TypeError("develop: curves must be null or {rgb?, r?, g?, b?}");
    for (const key of Object.keys(curves)) {
      if (!CURVE_KEYS.includes(key))
        throw new Error(`develop: unknown curves channel "${key}" (use rgb, r, g, b)`);
    }
    const out = {};
    for (const key of CURVE_KEYS) {
      const arr = curves[key];
      if (arr === undefined || arr === null) {
        out[key] = identityLut();
        continue;
      }
      if (typeof arr.length !== "number" || arr.length !== 256) {
        throw new TypeError(`develop: curves.${key} needs 256 output levels (0-255)`);
      }
      out[key] = Array.from(arr, (v, i) => checkValue(`curves.${key}[${i}]`, v, 0, 255));
    }
    return out;
  }

  function fitSize(w, h, edge) {
    const s = Math.min(1, edge / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  function fitRect(cw, ch, w, h) {
    const s = Math.min(cw / w, ch / h);
    const rw = Math.max(1, Math.round(w * s));
    const rh = Math.max(1, Math.round(h * s));
    return { x: Math.round((cw - rw) / 2), y: Math.round((ch - rh) / 2), w: rw, h: rh };
  }

  function formatValue(key, v) {
    if (key === "exposure") return `${v > 0 ? "+" : ""}${v.toFixed(2)} EV`;
    if (key === "grain") return String(Math.round(v));
    const r = Math.round(v);
    return `${r > 0 ? "+" : ""}${r}`;
  }

  // ---- WebGL plumbing -------------------------------------------------------
  function compile(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`develop: shader compile failed: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  }

  function linkProgram(gl, vs, fs, uniformNames) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(prog, 0, "aPos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`develop: program link failed: ${gl.getProgramInfoLog(prog)}`);
    }
    const u = {};
    for (const name of uniformNames) u[name] = gl.getUniformLocation(prog, name);
    return { prog, u };
  }

  function newTexture(gl) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // A render target: texture plus framebuffer, reallocated only when its size changes.
  function newTarget(gl) {
    return { tex: newTexture(gl), fbo: gl.createFramebuffer(), w: 0, h: 0 };
  }

  function sizeTarget(gl, target, w, h) {
    if (target.w === w && target.h === h) return;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`develop: framebuffer incomplete at ${w}x${h}`);
    }
    target.w = w;
    target.h = h;
  }

  // Top row first, so ImageBitmap (export) and OffscreenCanvas (preview) uploads agree.
  function uploadImage(gl, tex, source) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  // 256 x 4 LUT: row 0 = master RGB, rows 1-3 = R, G, B.
  function uploadCurves(gl, tex, curves) {
    const px = new Uint8Array(256 * 4 * 4);
    CURVE_KEYS.forEach((key, y) => {
      const row = curves[key];
      for (let x = 0; x < 256; x++) {
        const v = Math.round(row[x]);
        const o = (y * 256 + x) * 4;
        px[o] = v;
        px[o + 1] = v;
        px[o + 2] = v;
        px[o + 3] = 255;
      }
    });
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 4, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }

  function createGpu(gl) {
    const develop = linkProgram(gl, VERT, FRAG_DEVELOP, DEVELOP_UNIFORMS);
    const down = linkProgram(gl, VERT, FRAG_DOWN, ["uSrc", "uSrcTexel", "uN"]);
    const blur = linkProgram(gl, VERT, FRAG_BLUR, ["uSrc", "uStep"]);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const curves = newTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.useProgram(develop.prog);
    gl.uniform1i(develop.u.uSrc, 0);
    gl.uniform1i(develop.u.uBlur, 1);
    gl.uniform1i(develop.u.uCurves, 2);

    return {
      gl,
      develop,
      down,
      blur,
      vao,
      curves,
      curvesRef: null, // the state.curves object last uploaded, so LUTs upload only on change
      src: newTexture(gl),
      blurA: newTarget(gl),
      blurB: newTarget(gl),
      hist: newTarget(gl),
    };
  }

  // Low-frequency copy of the preview. Built once per image; read by clarity and dehaze.
  function buildBlur(g, pw, ph) {
    const { gl } = g;
    const size = fitSize(pw, ph, BLUR_EDGE);
    sizeTarget(gl, g.blurA, size.w, size.h);
    sizeTarget(gl, g.blurB, size.w, size.h);
    const n = Math.max(1, Math.round(Math.max(pw / size.w, ph / size.h) / 2));

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);

    // Pass 1: block-average the preview into blurA.
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.blurA.fbo);
    gl.viewport(0, 0, size.w, size.h);
    gl.useProgram(g.down.prog);
    gl.bindTexture(gl.TEXTURE_2D, g.src);
    gl.uniform1i(g.down.u.uSrc, 0);
    gl.uniform2f(g.down.u.uSrcTexel, 1 / pw, 1 / ph);
    gl.uniform1i(g.down.u.uN, n);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 2: horizontal Gaussian, blurA to blurB.
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.blurB.fbo);
    gl.useProgram(g.blur.prog);
    gl.bindTexture(gl.TEXTURE_2D, g.blurA.tex);
    gl.uniform1i(g.blur.u.uSrc, 0);
    gl.uniform2f(g.blur.u.uStep, 1 / size.w, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 3: vertical Gaussian, blurB back to blurA.
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.blurA.fbo);
    gl.bindTexture(gl.TEXTURE_2D, g.blurB.tex);
    gl.uniform2f(g.blur.u.uStep, 0, 1 / size.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function setDevelopUniforms(g, look, dims, flipY) {
    const { gl } = g;
    const u = g.develop.u;
    const pct = (v) => v / 100;
    gl.uniform1f(u.uFlipY, flipY ? 1 : 0);
    gl.uniform1f(u.uExposure, 2 ** look.exposure);
    gl.uniform1f(u.uContrast, pct(look.contrast));
    gl.uniform1f(u.uHighlights, pct(look.highlights));
    gl.uniform1f(u.uShadows, pct(look.shadows));
    gl.uniform1f(u.uWhites, pct(look.whites));
    gl.uniform1f(u.uBlacks, pct(look.blacks));
    gl.uniform1f(u.uTemp, pct(look.temperature));
    gl.uniform1f(u.uTint, pct(look.tint));
    gl.uniform1f(u.uVibrance, pct(look.vibrance));
    gl.uniform1f(u.uSaturation, pct(look.saturation));
    gl.uniform1f(u.uClarity, pct(look.clarity));
    gl.uniform1f(u.uDehaze, pct(look.dehaze));
    gl.uniform1f(u.uVignette, pct(look.vignette));
    gl.uniform1f(u.uGrain, pct(look.grain));
    gl.uniform1i(u.uUseCurves, look.curves ? 1 : 0);
    const hasHsl = [...look.hsl.hue, ...look.hsl.sat, ...look.hsl.lum].some((v) => v !== 0);
    gl.uniform1i(u.uUseHsl, hasHsl ? 1 : 0);
    gl.uniform1fv(u.uHslHue, look.hsl.hue.map(pct));
    gl.uniform1fv(u.uHslSat, look.hsl.sat.map(pct));
    gl.uniform1fv(u.uHslLum, look.hsl.lum.map(pct));
    gl.uniform1f(u.uAspect, dims.width / dims.height);
    const long = Math.max(dims.width, dims.height);
    gl.uniform2f(
      u.uGrainCells,
      (dims.width / long) * GRAIN_CELLS,
      (dims.height / long) * GRAIN_CELLS,
    );
  }

  // One develop pass. target: null for the canvas (flipped to screen order) or a render target.
  function drawDevelop(g, target, rect, dims, look) {
    const { gl } = g;
    if (look.curves && g.curvesRef !== look.curves) {
      uploadCurves(gl, g.curves, look.curves);
      g.curvesRef = look.curves;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(rect.x, rect.y, rect.w, rect.h);
    gl.useProgram(g.develop.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, g.src);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, g.blurA.tex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, g.curves);
    setDevelopUniforms(g, look, dims, !target);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function readTarget(gl, target) {
    const pixels = new Uint8Array(target.w * target.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.readPixels(0, 0, target.w, target.h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return pixels;
  }

  async function fetchBlob(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`develop: could not fetch ${url} (${res.status})`);
    return res.blob();
  }

  // Decodes once (EXIF orientation applied) into a downscaled canvas for the GPU preview.
  // Only the Blob is kept for export, so a 24MP bitmap is not held in memory while editing.
  async function decodeSource(input, previewEdge) {
    const blob = typeof input === "string" ? await fetchBlob(input) : input;
    if (!(blob instanceof Blob))
      throw new TypeError("develop.setImage expects a Blob, File or URL string");
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const width = bitmap.width;
    const height = bitmap.height;
    const pv = fitSize(width, height, previewEdge);
    const preview = new OffscreenCanvas(pv.w, pv.h);
    const pctx = preview.getContext("2d");
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(bitmap, 0, 0, pv.w, pv.h);
    bitmap.close();
    return { blob, width, height, preview };
  }

  // ---- Built-in panel -------------------------------------------------------
  function sliderRow({ label, min, max, step, onInput, onReset }) {
    const row = el("label", "t3k-develop-row");
    const name = el("span", "t3k-develop-name", label);
    const output = el("output", "t3k-develop-value");
    const input = el("input", "t3k-develop-range");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.addEventListener("input", () => onInput(Number(input.value)));
    row.addEventListener("dblclick", onReset);
    row.title = "Double-click to reset";
    row.append(name, output, input);
    return { row, input, output };
  }

  function buildPanel(actions) {
    const node = el("div", "t3k-develop-panel");
    node.setAttribute("role", "region");
    node.setAttribute("aria-label", "Develop controls");
    const numeric = {};
    const hslRows = {};
    const bandButtons = [];
    let look = null;
    let enabled = false;
    let band = 0;

    for (const section of SECTIONS) {
      const wrap = el("section", "t3k-develop-section");
      wrap.append(el("h3", "t3k-develop-title", section.title));
      for (const key of section.keys) {
        const [min, max] = RANGE[key] ?? DEFAULT_RANGE;
        const control = sliderRow({
          label: LABEL[key],
          min,
          max,
          step: key === "exposure" ? 0.01 : 1,
          onInput: (v) => actions.edit({ [key]: v }),
          onReset: () => actions.edit({ [key]: DEFAULTS[key] }),
        });
        numeric[key] = control;
        wrap.append(control.row);
      }
      node.append(wrap);
    }

    const bandGroup = el("div", "t3k-develop-bands");
    bandGroup.setAttribute("role", "group");
    bandGroup.setAttribute("aria-label", "Hue band");
    BANDS.forEach((name, i) => {
      const button = el("button", "t3k-develop-band", name);
      button.type = "button";
      button.dataset.band = String(i);
      button.addEventListener("click", () => {
        band = i;
        render();
      });
      bandButtons.push(button);
      bandGroup.append(button);
    });
    const hslSection = el("section", "t3k-develop-section");
    hslSection.append(el("h3", "t3k-develop-title", "Color Mix"), bandGroup);
    for (const [key, label] of HSL_CHANNELS) {
      const writeBand = (v) => {
        const next = look.hsl[key].slice();
        next[band] = v;
        actions.edit({ hsl: { [key]: next } });
      };
      const control = sliderRow({
        label,
        min: -100,
        max: 100,
        step: 1,
        onInput: writeBand,
        onReset: () => writeBand(0),
      });
      hslRows[key] = control;
      hslSection.append(control.row);
    }
    node.append(hslSection);

    const reset = el("button", "t3k-develop-reset", "Reset All");
    reset.type = "button";
    reset.addEventListener("click", () => actions.resetAll());
    node.append(reset);

    function render() {
      for (const key of NUMERIC) {
        const v = look[key];
        numeric[key].input.value = String(v);
        numeric[key].output.textContent = formatValue(key, v);
        numeric[key].row.classList.toggle("t3k-develop-edited", v !== DEFAULTS[key]);
      }
      for (const [key] of HSL_CHANNELS) {
        const v = look.hsl[key][band];
        hslRows[key].input.value = String(v);
        hslRows[key].output.textContent = formatValue("hsl", v);
        hslRows[key].row.classList.toggle("t3k-develop-edited", v !== 0);
      }
      bandButtons.forEach((b, i) => {
        b.setAttribute("aria-pressed", String(i === band));
        b.classList.toggle(
          "t3k-develop-edited",
          HSL_CHANNELS.some(([k]) => look.hsl[k][i] !== 0),
        );
      });
      for (const control of node.querySelectorAll("input, button")) control.disabled = !enabled;
    }

    return {
      node,
      sync(nextLook, nextEnabled) {
        look = nextLook;
        enabled = nextEnabled;
        render();
      },
    };
  }

  // ---- Style (injected once) ------------------------------------------------
  const CSS = `
.t3k-develop-root{position:relative;display:flex;box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:12px;line-height:1.4}
.t3k-develop-root *{box-sizing:border-box}
.t3k-develop-root [hidden]{display:none!important}
.t3k-develop-root.t3k-develop-narrow{flex-direction:column}
.t3k-develop-stage{position:relative;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden;background:var(--background)}
.t3k-develop-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.t3k-develop-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;color:var(--muted-foreground)}
.t3k-develop-panel{flex:0 0 256px;display:flex;flex-direction:column;gap:16px;padding:14px 14px 16px;overflow-y:auto;scrollbar-width:thin;background:var(--card);color:var(--card-foreground);border-left:1px solid var(--border)}
.t3k-develop-narrow .t3k-develop-panel{flex:0 0 auto;max-height:44%;border-left:0;border-top:1px solid var(--border)}
.t3k-develop-section{display:flex;flex-direction:column;gap:7px}
.t3k-develop-section+.t3k-develop-section{padding-top:14px;border-top:1px solid var(--border)}
.t3k-develop-title{margin:0 0 2px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted-foreground)}
.t3k-develop-row{display:grid;grid-template-columns:1fr auto;gap:0 8px;align-items:baseline;cursor:default}
.t3k-develop-name{color:var(--foreground)}
.t3k-develop-range{grid-column:1 / -1;width:100%;height:16px;margin:0;accent-color:var(--primary);cursor:pointer}
.t3k-develop-value{font-family:var(--font-mono);font-size:11px;font-variant-numeric:tabular-nums;color:var(--muted-foreground)}
.t3k-develop-row.t3k-develop-edited .t3k-develop-value{color:var(--foreground)}
.t3k-develop-bands{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}
.t3k-develop-band,.t3k-develop-reset{font:inherit;font-size:11px;padding:5px 2px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);background:var(--background);color:var(--muted-foreground);cursor:pointer}
.t3k-develop-band:hover:not(:disabled),.t3k-develop-reset:hover:not(:disabled){color:var(--foreground);border-color:var(--input)}
.t3k-develop-band.t3k-develop-edited{color:var(--foreground)}
.t3k-develop-band[aria-pressed="true"]{border-color:var(--primary);background:var(--primary);color:var(--primary-foreground)}
.t3k-develop-reset{width:100%;padding:7px 8px;color:var(--foreground)}
.t3k-develop-root button:focus-visible,.t3k-develop-range:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.t3k-develop-root button:disabled,.t3k-develop-root input:disabled{opacity:.45;cursor:not-allowed}`;

  function injectStyle() {
    if (document.querySelector('style[data-t3kit="develop"]')) return;
    const style = el("style");
    style.dataset.t3kit = "develop";
    style.textContent = CSS;
    document.head.append(style);
  }

  // ---- Instance -------------------------------------------------------------
  function create(container, options = {}) {
    if (!(container instanceof HTMLElement))
      throw new TypeError("develop.create: container must be an HTMLElement");
    for (const key of Object.keys(options)) {
      if (!["controls", "values", "previewSize"].includes(key)) {
        throw new Error(
          `develop.create: unknown option "${key}" (use controls, values, previewSize)`,
        );
      }
    }
    const controls = options.controls !== false;
    const previewEdge = options.previewSize ?? 2048;
    if (!Number.isInteger(previewEdge) || previewEdge < 64) {
      throw new RangeError(
        `develop: previewSize must be an integer of at least 64, got ${previewEdge}`,
      );
    }
    injectStyle();

    const state = { values: { ...DEFAULTS }, hsl: emptyHsl(), curves: null };
    const listeners = { change: new Set(), load: new Set(), render: new Set() };
    let source = null; // { blob, width, height, preview } once an image is attached
    let gpu = null; // preview-context GPU state, created on first image
    let loadToken = 0;
    let rafId = 0;
    let lookDirty = false; // the look changed since the last 'render' event (re-presents alone do not emit)
    let inRenderEvent = false;
    let lost = false;
    let destroyed = false;

    const root = el("div", "t3k-develop-root");
    const stage = el("div", "t3k-develop-stage");
    const canvas = el("canvas", "t3k-develop-canvas");
    canvas.hidden = true;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Developed photo");
    const empty = el("div", "t3k-develop-empty", "Open a photo to start developing.");
    stage.append(canvas, empty);
    root.append(stage);
    const panel = controls ? buildPanel({ edit, resetAll }) : null;
    if (panel) root.append(panel.node);
    container.append(root);

    function currentLook() {
      return { ...state.values, hsl: state.hsl, curves: state.curves };
    }

    function emit(event, payload) {
      for (const cb of listeners[event]) cb(payload);
    }

    function ensureGpu() {
      if (!gpu) {
        const gl = canvas.getContext("webgl2", CTX_PREVIEW);
        if (!gl) throw new Error("develop: WebGL2 is not available");
        gpu = createGpu(gl);
      }
      return gpu;
    }

    function fitCanvas() {
      const dpr = window.devicePixelRatio || 1;
      let w = Math.max(1, Math.round(stage.clientWidth * dpr));
      let h = Math.max(1, Math.round(stage.clientHeight * dpr));
      const cap = Math.min(1, MAX_CANVAS_EDGE / Math.max(w, h));
      w = Math.max(1, Math.round(w * cap));
      h = Math.max(1, Math.round(h * cap));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        requestRender();
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      root.classList.toggle("t3k-develop-narrow", root.clientWidth < NARROW_PX);
      fitCanvas();
    });
    resizeObserver.observe(root);

    function onContextLost(event) {
      event.preventDefault();
      lost = true;
      gpu = null;
    }
    function onContextRestored() {
      lost = false;
      if (source) attachSource(source);
    }
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    // Coalesces any number of edits into one frame. Nothing is scheduled while idle.
    function requestRender() {
      if (rafId || (inRenderEvent && !lookDirty) || !source || destroyed) return;
      rafId = requestAnimationFrame(renderFrame);
    }

    function renderFrame() {
      rafId = 0;
      if (!source || lost || destroyed) return;
      const g = ensureGpu();
      const { gl } = g;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const dpr = window.devicePixelRatio || 1;
      const pad = Math.min(
        Math.round(STAGE_PAD * dpr),
        Math.floor(Math.min(canvas.width, canvas.height) / 8),
      );
      const rect = fitRect(
        canvas.width - 2 * pad,
        canvas.height - 2 * pad,
        source.width,
        source.height,
      );
      rect.x += pad;
      rect.y += pad;
      drawDevelop(g, null, rect, source, currentLook());
      if (lookDirty) {
        // Listeners usually read getImageData()/histogram(); those draw into their own framebuffer, so the frame
        // just drawn stays valid and needs no second render.
        lookDirty = false;
        inRenderEvent = true;
        try {
          emit("render", { width: source.width, height: source.height });
        } finally {
          inRenderEvent = false;
        }
      }
    }

    function attachSource(next) {
      const g = ensureGpu();
      uploadImage(g.gl, g.src, next.preview);
      buildBlur(g, next.preview.width, next.preview.height);
      source = next;
      empty.hidden = true;
      canvas.hidden = false;
      fitCanvas();
      panel?.sync(currentLook(), true);
      lookDirty = true;
      requestRender();
    }

    function requireImage(method) {
      if (destroyed) throw new Error(`develop.${method}: instance was destroyed`);
      if (!source) throw new Error(`develop.${method}: no image loaded; await setImage() first`);
      if (lost)
        throw new Error(`develop.${method}: WebGL context lost; wait for it to be restored`);
    }

    async function setImage(input) {
      if (destroyed) throw new Error("develop.setImage: instance was destroyed");
      const token = ++loadToken;
      const decoded = await decodeSource(input, previewEdge);
      if (destroyed || token !== loadToken) return null;
      attachSource(decoded);
      const dims = { width: decoded.width, height: decoded.height };
      emit("load", dims);
      return dims;
    }

    function get() {
      return {
        ...state.values,
        hsl: { hue: [...state.hsl.hue], sat: [...state.hsl.sat], lum: [...state.hsl.lum] },
        curves: state.curves && {
          rgb: [...state.curves.rgb],
          r: [...state.curves.r],
          g: [...state.curves.g],
          b: [...state.curves.b],
        },
      };
    }

    // Validates everything before applying, so a bad partial leaves the state untouched.
    function set(partial) {
      if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
        throw new TypeError("develop.set expects an object of params");
      }
      const next = { values: { ...state.values }, hsl: state.hsl, curves: state.curves };
      for (const [key, value] of Object.entries(partial)) {
        if (key === "hsl") {
          next.hsl = normalizeHsl(next.hsl, value);
        } else if (key === "curves") {
          next.curves = normalizeCurves(value);
        } else if (NUMERIC.includes(key)) {
          next.values[key] = checkValue(key, value, ...(RANGE[key] ?? DEFAULT_RANGE));
        } else {
          throw new Error(`develop: unknown param "${key}"; valid: ${PARAM_KEYS.join(", ")}`);
        }
      }
      state.values = next.values;
      state.hsl = next.hsl;
      state.curves = next.curves;
      panel?.sync(currentLook(), source !== null);
      lookDirty = true;
      requestRender();
    }

    function reset() {
      set({ ...DEFAULTS, hsl: emptyHsl(), curves: null });
    }

    // User-driven edits: apply, then notify 'change'.
    function edit(partial) {
      set(partial);
      emit("change", get());
    }

    function resetAll() {
      reset();
      emit("change", get());
    }

    function on(event, cb) {
      const bucket = listeners[event];
      if (!bucket) throw new Error(`develop: unknown event "${event}" (use change, load, render)`);
      if (typeof cb !== "function") throw new TypeError("develop.on: callback must be a function");
      bucket.add(cb);
      return () => bucket.delete(cb);
    }

    // Rendered into its own framebuffer (top row first), then the canvas is re-presented.
    function getImageData() {
      requireImage("getImageData");
      const g = ensureGpu();
      const { gl } = g;
      const size = fitSize(source.width, source.height, HIST_EDGE);
      sizeTarget(gl, g.hist, size.w, size.h);
      drawDevelop(g, g.hist, { x: 0, y: 0, w: size.w, h: size.h }, source, currentLook());
      const pixels = readTarget(gl, g.hist);
      requestRender();
      return new ImageData(new Uint8ClampedArray(pixels.buffer), size.w, size.h);
    }

    function histogram() {
      const { data } = getImageData();
      const out = {
        rgb: new Array(256).fill(0),
        r: new Array(256).fill(0),
        g: new Array(256).fill(0),
        b: new Array(256).fill(0),
      };
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const gr = data[i + 1];
        const b = data[i + 2];
        out.r[r]++;
        out.g[gr]++;
        out.b[b]++;
        out.rgb[Math.round(0.2126 * r + 0.7152 * gr + 0.0722 * b)]++;
      }
      return out;
    }

    // Export uses a separate offscreen context at full source size. The preview blur is read
    // back once and re-uploaded, so clarity and dehaze look identical at both resolutions.
    async function exportBlob(opts = {}) {
      requireImage("exportBlob");
      const type = opts.type ?? "image/jpeg";
      const quality = opts.quality ?? 0.92;
      if (!/^image\/(jpeg|png|webp)$/.test(type)) {
        throw new RangeError(
          `develop.exportBlob: type must be image/jpeg, image/png or image/webp, got ${type}`,
        );
      }
      checkValue("exportBlob quality", quality, 0, 1);
      const look = currentLook();
      const g = ensureGpu();
      const blur = { pixels: readTarget(g.gl, g.blurA), w: g.blurA.w, h: g.blurA.h };
      requestRender();
      const bitmap = await createImageBitmap(source.blob, { imageOrientation: "from-image" });
      const width = bitmap.width;
      const height = bitmap.height;
      const offscreen = new OffscreenCanvas(width, height);
      const egl = offscreen.getContext("webgl2", CTX_EXPORT);
      if (!egl) throw new Error("develop: WebGL2 is not available for export");
      try {
        const maxEdge = Math.min(
          egl.getParameter(egl.MAX_TEXTURE_SIZE),
          egl.getParameter(egl.MAX_VIEWPORT_DIMS)[0],
        );
        if (Math.max(width, height) > maxEdge) {
          throw new RangeError(
            `develop: image ${width}x${height} exceeds the GPU limit of ${maxEdge}px`,
          );
        }
        const eg = createGpu(egl);
        uploadImage(egl, eg.src, bitmap);
        egl.activeTexture(egl.TEXTURE1);
        egl.bindTexture(egl.TEXTURE_2D, eg.blurA.tex);
        egl.texImage2D(
          egl.TEXTURE_2D,
          0,
          egl.RGBA,
          blur.w,
          blur.h,
          0,
          egl.RGBA,
          egl.UNSIGNED_BYTE,
          blur.pixels,
        );
        drawDevelop(eg, null, { x: 0, y: 0, w: width, h: height }, { width, height }, look);
        return await offscreen.convertToBlob({ type, quality });
      } finally {
        bitmap.close();
        egl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(rafId);
      rafId = 0;
      resizeObserver.disconnect();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      gpu?.gl.getExtension("WEBGL_lose_context")?.loseContext();
      gpu = null;
      source = null;
      root.remove();
      for (const bucket of Object.values(listeners)) bucket.clear();
    }

    if (options.values !== undefined) set(options.values);
    panel?.sync(currentLook(), false);
    return { setImage, get, set, reset, on, getImageData, histogram, exportBlob, destroy };
  }

  t3kit.develop = { create };
})();
