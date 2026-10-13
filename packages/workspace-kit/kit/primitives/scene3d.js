/**
 * t3kit.scene3d: WebGL2 3D viewport (no deps): orbit camera, grid, axis gizmo, lights, PBR-ish materials, primitives,
 * glTF 2.0 import, move/rotate/scale gizmo, JSON scene graph, full-resolution export. Renders on demand.
 * create(container, options?) -> instance. options: any set() key, plus controls (default true: toolbar Move Rotate
 *   Scale | Grid Axes | Frame) and defaultLights (default true: ambient + key light while the scene has no light node).
 * value = get() -> {nodes, selected, mode, snap, camera, grid, axes}, plain JSON; set(get()) round-trips.
 *   camera {target:[x,y,z], azimuth, elevation, distance, fov} (degrees). mode 'move'|'rotate'|'scale'.
 *   snap {move, rotate}: grid step in units and degrees for gizmo drags (0 = off). grid, axes: booleans.
 * node {id, name?, parent? (id|null), visible?, position?, rotation? (Euler XYZ degrees), scale?, mesh?, material?, light?}
 *   mesh {shape:'box'|'sphere'|'plane'|'cylinder'|'torus', size?}: box [w,h,d] [1,1,1], sphere [r] [0.5], plane [w,d]
 *     on XZ [1,1], cylinder [r,h] [0.5,1], torus [R,tube] [0.5,0.15]. Or {shape:'custom', positions, normals?, indices?}.
 *   material {color, roughness 0..1, metalness 0..1}. light {type:'ambient'|'directional'|'point', color, intensity, range?}
 *   Colours: any CSS colour, var(--chart-1) etc. included (re-resolved on theme change). Directional lights shine
 *   along the node's -Z. Max 4 directional + 8 point lights. glTF meshes are custom nodes (arrays frozen, shared).
 * instance
 *   get() / set(partial): nodes (replaces all) | selected | mode | snap | camera (merged) | grid | axes. Throws on bad
 *     input. set, add, update and remove never emit 'change'.
 *   add(node) -> id (id optional) · update(id, partial) merges (material and light merge too; null clears a key)
 *   remove(id) removes the node and its children.
 *   load(blob, {parent?, name?}) -> Promise<rootId>  .glb or .gltf with data: URIs: triangle meshes, base colour,
 *     metal/rough factors, node tree (TRS or matrix). Textures/skins/animation ignored; sparse, strips, URLs throw.
 *   frame(id?) fits the camera to a node + children (default: selection, else all).
 *   exportBlob({type='image/png', quality, width, height}) -> Promise<Blob>  default canvas pixels (CSS size x DPR);
 *     scene + grid only, no gizmo or HUD.
 *   on(event, cb) -> unsubscribe. 'change' (payload get()): user edits, at most once per frame while dragging.
 *     'select' (id|null). 'camera' (payload get()): orbit/pan/zoom, at most once per frame.
 *   destroy()
 * Input: drag orbits; right/middle/Shift drag pans; wheel or pinch zooms; click picks (exact triangles, lights by icon);
 *   handles move (world axes), rotate (world rings), scale (local axes; centre square = uniform). Canvas keys:
 *   W/E/R tool, G grid, X axes, F frame, [ ] cycle selection, arrows nudge X/Z (PageUp/Down Y, Shift x10) or orbit
 *   when nothing is selected, +/- zoom, Delete removes, Escape deselects. Click an axis-HUD dot to view along it.
 * @example
 *   const s = t3kit.scene3d.create(el, { nodes: [{ id: 'box', mesh: { shape: 'box' }, position: [0, 0.5, 0] }] });
 *   s.add({ mesh: { shape: 'sphere' }, material: { color: 'var(--chart-2)', metalness: 1, roughness: 0.2 } });
 *   s.on('change', (v) => save(v.nodes));
 *   s.frame(await s.load(glbBlob));
 *   const png = await s.exportBlob({ type: 'image/png' });
 */
(function () {
  "use strict";
  const t3kit = (window.t3kit = window.t3kit || {});

  const DEG = Math.PI / 180;
  const TAU = Math.PI * 2;
  const MAX_DPR = 2;
  const INST = 30; // floats per instance: model (16), normal matrix columns (9), rgb + roughness (4), metalness (1)
  const MAX_DIR = 4;
  const MAX_POINT = 8;
  const HIT_PX = 8;
  const AXIS_VEC = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const AXIS_TOKEN = ["destructive", "success", "info"];
  const MODES = ["move", "rotate", "scale"];
  const SHAPE_SIZE = {
    box: [1, 1, 1],
    sphere: [0.5],
    plane: [1, 1],
    cylinder: [0.5, 1],
    torus: [0.5, 0.15],
  };
  const SHAPE_ARITY = { box: 3, sphere: 1, plane: 2, cylinder: 2, torus: 2 };
  const DEFAULT_MATERIAL = { color: "#cccccc", roughness: 0.5, metalness: 0 };
  const DEFAULT_CAMERA = { target: [0, 0, 0], azimuth: 35, elevation: 25, distance: 12, fov: 40 };
  const THEME_TOKENS = {
    bg: "--background",
    fg: "--foreground",
    muted: "--muted-foreground",
    border: "--border",
    primary: "--primary",
    primaryFg: "--primary-foreground",
    destructive: "--destructive",
    success: "--success",
    info: "--info",
    warning: "--warning",
    ring: "--ring",
  };
  const KEYS = {
    option: [
      "nodes",
      "selected",
      "mode",
      "snap",
      "camera",
      "grid",
      "axes",
      "controls",
      "defaultLights",
    ],
    node: [
      "id",
      "name",
      "parent",
      "visible",
      "position",
      "rotation",
      "scale",
      "mesh",
      "material",
      "light",
    ],
    camera: ["target", "azimuth", "elevation", "distance", "fov"],
    set: ["nodes", "selected", "mode", "snap", "camera", "grid", "axes"],
    snap: ["move", "rotate"],
    light: ["type", "color", "intensity", "range"],
    material: ["color", "roughness", "metalness"],
    shape: ["shape", "size"],
    custom: ["shape", "positions", "normals", "indices"],
  };
  const CSS = `
.t3k-scene3d-root{position:relative;width:100%;height:100%;min-height:160px;overflow:hidden;box-sizing:border-box;background:var(--background);color:var(--foreground);font-family:var(--font-sans);border-radius:var(--radius)}
.t3k-scene3d-canvas,.t3k-scene3d-overlay{position:absolute;inset:0;width:100%;height:100%;display:block}
.t3k-scene3d-canvas{touch-action:none;outline:none}
.t3k-scene3d-canvas:focus-visible{box-shadow:inset 0 0 0 2px var(--ring)}
.t3k-scene3d-overlay{pointer-events:none}
.t3k-scene3d-toolbar{position:absolute;top:8px;left:8px;max-width:calc(100% - 16px);display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:4px;box-sizing:border-box;background:var(--card);border:1px solid var(--border);border-radius:var(--radius)}
.t3k-scene3d-sep{width:1px;align-self:stretch;margin:2px 4px;background:var(--border)}
.t3k-scene3d-tool{font:inherit;font-size:12px;line-height:1;min-height:28px;padding:0 8px;border:1px solid transparent;border-radius:calc(var(--radius) - 2px);background:transparent;color:var(--muted-foreground);cursor:pointer}
.t3k-scene3d-tool:hover{color:var(--foreground);background:var(--muted)}
.t3k-scene3d-tool[aria-pressed="true"]{color:var(--primary-foreground);background:var(--primary)}
.t3k-scene3d-tool:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
`;

  // ---- Errors and validation ---------------------------------------------------
  function fail(message) {
    throw new Error(`scene3d: ${message}`);
  }
  function rejectUnknown(obj, allowed, what) {
    for (const key of Object.keys(obj))
      if (!allowed.includes(key)) fail(`${what} has unknown key "${key}"`);
  }
  function finite(value, what) {
    if (typeof value !== "number" || !Number.isFinite(value))
      fail(`${what} must be a finite number`);
    return value;
  }
  function positive(value, what) {
    if (finite(value, what) <= 0) fail(`${what} must be greater than 0`);
    return value;
  }
  function unit(value, what) {
    if (finite(value, what) < 0 || value > 1) fail(`${what} must be between 0 and 1`);
    return value;
  }
  function vec3(value, fallback, what, nonZero) {
    if (value === undefined) return fallback.slice();
    if (!Array.isArray(value) || value.length !== 3) fail(`${what} must be [x, y, z]`);
    return value.map((v, i) => {
      const n = finite(v, `${what}[${i}]`);
      if (nonZero && n === 0) fail(`${what} must not contain zero`);
      return n;
    });
  }
  // Any CSS colour, var(--token) included. Validated by resolving it now; stored as written.
  function colourOf(value, what) {
    if (typeof value !== "string" || value.trim() === "")
      fail(`${what} must be a CSS colour string`);
    resolveColour(value, what);
    return value.trim();
  }
  function bool(value, what) {
    if (typeof value !== "boolean") fail(`${what} must be true or false`);
    return value;
  }

  // ---- Colour ------------------------------------------------------------------
  // CSS colour -> sRGB 0..1 through a 1x1 canvas. var(--x) is read from :root. The cache is cleared on theme change.
  let probe = null;
  const colourCache = new Map();
  function probeContext() {
    if (!probe) {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      probe = c.getContext("2d", { willReadFrequently: true });
    }
    return probe;
  }
  function resolveColour(value, what) {
    const hit = colourCache.get(value);
    if (hit) return hit;
    const styles = getComputedStyle(document.documentElement);
    const css = value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name) => {
      const v = styles.getPropertyValue(name).trim();
      if (v === "") fail(`${what}: ${name} is not set`);
      return v;
    });
    const p = probeContext();
    p.fillStyle = "#010203";
    p.fillStyle = css;
    if (p.fillStyle === "#010203" && !/^#010203$/i.test(css))
      fail(`${what}: "${value}" is not a CSS colour`);
    p.clearRect(0, 0, 1, 1);
    p.fillRect(0, 0, 1, 1);
    const px = p.getImageData(0, 0, 1, 1).data;
    const rgb = [px[0] / 255, px[1] / 255, px[2] / 255];
    colourCache.set(value, rgb);
    return rgb;
  }
  function srgbOf(value) {
    return resolveColour(value, "colour");
  }
  function linearOf(value) {
    return srgbOf(value).map((c) => Math.pow(c, 2.2));
  }
  function hexOfLinear(c) {
    return (
      "#" +
      [0, 1, 2]
        .map((i) =>
          Math.round(Math.pow(Math.min(1, Math.max(0, c[i])), 1 / 2.2) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
    );
  }

  // ---- Matrices (column-major Float32Array(16), like WebGL) --------------------
  const M = {
    id() {
      const m = new Float32Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      return m;
    },
    mul(a, b) {
      const r = new Float32Array(16);
      for (let c = 0; c < 4; c++) {
        for (let row = 0; row < 4; row++) {
          r[c * 4 + row] =
            a[row] * b[c * 4] +
            a[4 + row] * b[c * 4 + 1] +
            a[8 + row] * b[c * 4 + 2] +
            a[12 + row] * b[c * 4 + 3];
        }
      }
      return r;
    },
    trs(p, r, s) {
      const rx = r[0] * DEG,
        ry = r[1] * DEG,
        rz = r[2] * DEG;
      const cx = Math.cos(rx),
        sx = Math.sin(rx);
      const cy = Math.cos(ry),
        sy = Math.sin(ry);
      const cz = Math.cos(rz),
        sz = Math.sin(rz);
      const rotX = Float32Array.from([1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1]);
      const rotY = Float32Array.from([cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]);
      const rotZ = Float32Array.from([cz, sz, 0, 0, -sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const scale = Float32Array.from([s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1]);
      const out = M.mul(M.mul(rotZ, M.mul(rotY, rotX)), scale);
      out[12] = p[0];
      out[13] = p[1];
      out[14] = p[2];
      return out;
    },
    fromQuat(t, q, s) {
      const [x, y, z, w] = q;
      const xx = x * x,
        yy = y * y,
        zz = z * z,
        xy = x * y,
        xz = x * z,
        yz = y * z,
        wx = w * x,
        wy = w * y,
        wz = w * z;
      return Float32Array.from([
        (1 - 2 * (yy + zz)) * s[0],
        2 * (xy + wz) * s[0],
        2 * (xz - wy) * s[0],
        0,
        2 * (xy - wz) * s[1],
        (1 - 2 * (xx + zz)) * s[1],
        2 * (yz + wx) * s[1],
        0,
        2 * (xz + wy) * s[2],
        2 * (yz - wx) * s[2],
        (1 - 2 * (xx + yy)) * s[2],
        0,
        t[0],
        t[1],
        t[2],
        1,
      ]);
    },
    // Inverse of a TRS-like matrix (general Gauss-Jordan, so shear and mirror both work). Null if singular.
    invert(m) {
      const a = [];
      for (let r = 0; r < 4; r++) {
        a.push([
          m[r],
          m[4 + r],
          m[8 + r],
          m[12 + r],
          r === 0 ? 1 : 0,
          r === 1 ? 1 : 0,
          r === 2 ? 1 : 0,
          r === 3 ? 1 : 0,
        ]);
      }
      for (let c = 0; c < 4; c++) {
        let p = c;
        for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
        if (Math.abs(a[p][c]) < 1e-12) return null;
        [a[c], a[p]] = [a[p], a[c]];
        const d = a[c][c];
        for (let k = 0; k < 8; k++) a[c][k] /= d;
        for (let r = 0; r < 4; r++) {
          if (r === c) continue;
          const f = a[r][c];
          for (let k = 0; k < 8; k++) a[r][k] -= f * a[c][k];
        }
      }
      const o = new Float32Array(16);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = a[r][4 + c];
      return o;
    },
    lookAt(eye, target, up) {
      let zx = eye[0] - target[0],
        zy = eye[1] - target[1],
        zz = eye[2] - target[2];
      let l = Math.hypot(zx, zy, zz) || 1;
      zx /= l;
      zy /= l;
      zz /= l;
      let xx = up[1] * zz - up[2] * zy,
        xy = up[2] * zx - up[0] * zz,
        xz = up[0] * zy - up[1] * zx;
      l = Math.hypot(xx, xy, xz) || 1;
      xx /= l;
      xy /= l;
      xz /= l;
      const yx = zy * xz - zz * xy,
        yy = zz * xx - zx * xz,
        yz = zx * xy - zy * xx;
      return Float32Array.from([
        xx,
        yx,
        zx,
        0,
        xy,
        yy,
        zy,
        0,
        xz,
        yz,
        zz,
        0,
        -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
        -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
        -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
        1,
      ]);
    },
    perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2);
      const nf = 1 / (near - far);
      return Float32Array.from([
        f / aspect,
        0,
        0,
        0,
        0,
        f,
        0,
        0,
        0,
        0,
        (far + near) * nf,
        -1,
        0,
        0,
        2 * far * near * nf,
        0,
      ]);
    },
    // Euler decomposition of a column-major matrix (no shear), using R = Rz * Ry * Rx.
    decompose(m) {
      const sc = [
        Math.hypot(m[0], m[1], m[2]),
        Math.hypot(m[4], m[5], m[6]),
        Math.hypot(m[8], m[9], m[10]),
      ];
      const R = (row, col) => m[col * 4 + row] / sc[col];
      const sb = Math.max(-1, Math.min(1, -R(2, 0)));
      const b = Math.asin(sb);
      let a, c;
      if (Math.abs(sb) < 0.9999) {
        a = Math.atan2(R(2, 1), R(2, 2));
        c = Math.atan2(R(1, 0), R(0, 0));
      } else {
        a = 0;
        c = Math.atan2(-R(0, 1), R(1, 1));
      }
      return { position: [m[12], m[13], m[14]], rotation: [a / DEG, b / DEG, c / DEG], scale: sc };
    },
  };

  function invert3(a) {
    const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
    const c00 = a11 * a22 - a12 * a21,
      c01 = a12 * a20 - a10 * a22,
      c02 = a10 * a21 - a11 * a20;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    if (det === 0) fail("transform is singular");
    const id = 1 / det;
    return [
      c00 * id,
      (a02 * a21 - a01 * a22) * id,
      (a01 * a12 - a02 * a11) * id,
      c01 * id,
      (a00 * a22 - a02 * a20) * id,
      (a02 * a10 - a00 * a12) * id,
      c02 * id,
      (a01 * a20 - a00 * a21) * id,
      (a00 * a11 - a01 * a10) * id,
    ];
  }
  // Row-major 3x3 upper-left of a column-major 4x4.
  function rows3(m) {
    return [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  }
  function mulVec3(a, v) {
    return [
      a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
      a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
      a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
    ];
  }
  function xformPoint(m, p) {
    return [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ];
  }
  function xformDir(m, d) {
    return [
      m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
      m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
      m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
    ];
  }
  // Rotation of `rad` about the unit axis a (column-major 4x4).
  function axisAngle(a, rad) {
    const c = Math.cos(rad),
      s = Math.sin(rad),
      t = 1 - c;
    const [x, y, z] = a;
    return Float32Array.from([
      t * x * x + c,
      t * x * y + s * z,
      t * x * z - s * y,
      0,
      t * x * y - s * z,
      t * y * y + c,
      t * y * z + s * x,
      0,
      t * x * z + s * y,
      t * y * z - s * x,
      t * z * z + c,
      0,
      0,
      0,
      0,
      1,
    ]);
  }
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross3 = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  function norm3(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  // Parameter t of the point on the line o + a t (a unit) closest to the ray r. Null when they are near parallel.
  function axisParam(r, o, a) {
    const w = sub3(r.o, o);
    const b = dot3(a, r.d),
      d = dot3(a, w),
      e = dot3(r.d, w);
    const den = 1 - b * b;
    if (den < 1e-4) return null;
    return (d - b * e) / den;
  }
  // Ray hit on the plane through o with normal n. Null when parallel or behind the eye.
  function planeHit(r, o, n) {
    const den = dot3(r.d, n);
    if (Math.abs(den) < 1e-6) return null;
    const t = dot3(sub3(o, r.o), n) / den;
    if (t < 0) return null;
    return [r.o[0] + r.d[0] * t, r.o[1] + r.d[1] * t, r.o[2] + r.d[2] * t];
  }
  // Moller-Trumbore over an indexed triangle list in the mesh's local space; smallest t >= 0 or null.
  function rayTriangles(o, d, pos, idx) {
    let best = Infinity;
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 3,
        b = idx[k + 1] * 3,
        c = idx[k + 2] * 3;
      const e1x = pos[b] - pos[a],
        e1y = pos[b + 1] - pos[a + 1],
        e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a],
        e2y = pos[c + 1] - pos[a + 1],
        e2z = pos[c + 2] - pos[a + 2];
      const px = d[1] * e2z - d[2] * e2y,
        py = d[2] * e2x - d[0] * e2z,
        pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const tx = o[0] - pos[a],
        ty = o[1] - pos[a + 1],
        tz = o[2] - pos[a + 2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y,
        qy = tz * e1x - tx * e1z,
        qz = tx * e1y - ty * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t >= 0 && t < best) best = t;
    }
    return best === Infinity ? null : best;
  }

  // World travel direction of a directional light: local -Z under the node's world transform.
  function travelDir(world) {
    const d = [-world[8], -world[9], -world[10]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return d.map((v) => v / l);
  }
  const DEFAULT_KEY_DIR = travelDir(M.trs([0, 0, 0], [-50, 35, 0], [1, 1, 1]));
  const DEFAULT_FILL_DIR = travelDir(M.trs([0, 0, 0], [-20, 215, 0], [1, 1, 1]));

  // ---- Geometry (CPU) ---------------------------------------------------------
  function newMesh() {
    return { p: [], n: [], i: [] };
  }
  function addQuad(m, a, b, c, d, n) {
    const base = m.p.length / 3;
    for (const v of [a, b, c, d]) {
      m.p.push(v[0], v[1], v[2]);
      m.n.push(n[0], n[1], n[2]);
    }
    m.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  function boxMesh(w, h, d) {
    const x = w / 2,
      y = h / 2,
      z = d / 2;
    const m = newMesh();
    addQuad(m, [x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z], [1, 0, 0]);
    addQuad(m, [-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z], [-1, 0, 0]);
    addQuad(m, [-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z], [0, 1, 0]);
    addQuad(m, [-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [0, -1, 0]);
    addQuad(m, [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], [0, 0, 1]);
    addQuad(m, [x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z], [0, 0, -1]);
    return m;
  }
  function planeMesh(w, d) {
    const m = newMesh();
    const x = w / 2,
      z = d / 2;
    addQuad(m, [-x, 0, z], [x, 0, z], [x, 0, -z], [-x, 0, -z], [0, 1, 0]);
    return m;
  }
  function sphereMesh(r, seg = 32, rings = 16) {
    const m = newMesh();
    for (let y = 0; y <= rings; y++) {
      const phi = (Math.PI * y) / rings;
      for (let x = 0; x <= seg; x++) {
        const th = (TAU * x) / seg;
        const nx = Math.sin(phi) * Math.cos(th),
          ny = Math.cos(phi),
          nz = Math.sin(phi) * Math.sin(th);
        m.p.push(nx * r, ny * r, nz * r);
        m.n.push(nx, ny, nz);
      }
    }
    for (let y = 0; y < rings; y++) {
      for (let x = 0; x < seg; x++) {
        const a = y * (seg + 1) + x,
          b = a + seg + 1;
        m.i.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return m;
  }
  function cylinderMesh(r, h, seg = 40) {
    const m = newMesh();
    const y = h / 2;
    for (let x = 0; x <= seg; x++) {
      const th = (TAU * x) / seg,
        c = Math.cos(th),
        s = Math.sin(th);
      m.p.push(r * c, y, r * s, r * c, -y, r * s);
      m.n.push(c, 0, s, c, 0, s);
    }
    for (let x = 0; x < seg; x++) {
      const a = 2 * x;
      m.i.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    for (const sign of [1, -1]) {
      const center = m.p.length / 3;
      m.p.push(0, sign * y, 0);
      m.n.push(0, sign, 0);
      for (let x = 0; x <= seg; x++) {
        const th = (TAU * x) / seg;
        m.p.push(r * Math.cos(th), sign * y, r * Math.sin(th));
        m.n.push(0, sign, 0);
      }
      for (let x = 0; x < seg; x++) m.i.push(center, center + 1 + x, center + 2 + x);
    }
    return m;
  }
  function torusMesh(R, tube, radial = 24, tubular = 40) {
    const m = newMesh();
    for (let j = 0; j <= radial; j++) {
      const v = (TAU * j) / radial,
        cv = Math.cos(v),
        sv = Math.sin(v);
      for (let i = 0; i <= tubular; i++) {
        const u = (TAU * i) / tubular,
          cu = Math.cos(u),
          su = Math.sin(u);
        m.p.push((R + tube * cv) * cu, tube * sv, (R + tube * cv) * su);
        m.n.push(cv * cu, sv, cv * su);
      }
    }
    for (let j = 0; j < radial; j++) {
      for (let i = 0; i < tubular; i++) {
        const a = j * (tubular + 1) + i,
          b = a + tubular + 1;
        m.i.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    return m;
  }
  // Generated meshes: flip any triangle whose winding disagrees with its vertex normals, so front faces point out.
  function finishMesh(m) {
    const { p, n, i } = m;
    for (let t = 0; t < i.length; t += 3) {
      const a = i[t] * 3,
        b = i[t + 1] * 3,
        c = i[t + 2] * 3;
      const e1x = p[b] - p[a],
        e1y = p[b + 1] - p[a + 1],
        e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a],
        e2y = p[c + 1] - p[a + 1],
        e2z = p[c + 2] - p[a + 2];
      const cx = e1y * e2z - e1z * e2y,
        cy = e1z * e2x - e1x * e2z,
        cz = e1x * e2y - e1y * e2x;
      const dot =
        cx * (n[a] + n[b] + n[c]) +
        cy * (n[a + 1] + n[b + 1] + n[c + 1]) +
        cz * (n[a + 2] + n[b + 2] + n[c + 2]);
      if (dot < 0) [i[t + 1], i[t + 2]] = [i[t + 2], i[t + 1]];
    }
    return {
      positions: Float32Array.from(p),
      normals: Float32Array.from(n),
      indices: Uint32Array.from(i),
    };
  }
  function shapeCpu(shape, s) {
    switch (shape) {
      case "box":
        return finishMesh(boxMesh(s[0], s[1], s[2]));
      case "sphere":
        return finishMesh(sphereMesh(s[0]));
      case "plane":
        return finishMesh(planeMesh(s[0], s[1]));
      case "cylinder":
        return finishMesh(cylinderMesh(s[0], s[1]));
      case "torus":
        return finishMesh(torusMesh(s[0], s[1]));
      default:
        return fail(`unknown shape "${shape}"`);
    }
  }
  function shapeBounds(shape, s) {
    switch (shape) {
      case "box":
        return { min: [-s[0] / 2, -s[1] / 2, -s[2] / 2], max: [s[0] / 2, s[1] / 2, s[2] / 2] };
      case "sphere":
        return { min: [-s[0], -s[0], -s[0]], max: [s[0], s[0], s[0]] };
      case "plane":
        return { min: [-s[0] / 2, -0.01, -s[1] / 2], max: [s[0] / 2, 0.01, s[1] / 2] };
      case "cylinder":
        return { min: [-s[0], -s[1] / 2, -s[0]], max: [s[0], s[1] / 2, s[0]] };
      default: {
        const R = s[0] + s[1];
        return { min: [-R, -s[1], -R], max: [R, s[1], R] };
      }
    }
  }
  function arrayBounds(positions) {
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], positions[i + k]);
        max[k] = Math.max(max[k], positions[i + k]);
      }
    }
    return { min, max };
  }
  function computeNormals(positions, indices) {
    const n = new Array(positions.length).fill(0);
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3,
        b = indices[t + 1] * 3,
        c = indices[t + 2] * 3;
      const e1x = positions[b] - positions[a],
        e1y = positions[b + 1] - positions[a + 1],
        e1z = positions[b + 2] - positions[a + 2];
      const e2x = positions[c] - positions[a],
        e2y = positions[c + 1] - positions[a + 1],
        e2z = positions[c + 2] - positions[a + 2];
      const cx = e1y * e2z - e1z * e2y,
        cy = e1z * e2x - e1x * e2z,
        cz = e1x * e2y - e1y * e2x;
      for (const v of [a, b, c]) {
        n[v] += cx;
        n[v + 1] += cy;
        n[v + 2] += cz;
      }
    }
    for (let v = 0; v < n.length; v += 3) {
      const l = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1;
      n[v] /= l;
      n[v + 1] /= l;
      n[v + 2] /= l;
    }
    return n;
  }

  // ---- Scene graph normalisation ------------------------------------------------
  // Custom mesh arrays are frozen and shared by reference: get() stays cheap and set(get()) reuses GPU geometry.
  let customSeq = 0;
  const customKeys = new WeakMap();

  function normalizeMaterial(raw, id) {
    if (raw === undefined) return { ...DEFAULT_MATERIAL };
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      fail(`${id}.material must be an object`);
    rejectUnknown(raw, KEYS.material, `${id}.material`);
    return {
      color:
        raw.color === undefined
          ? DEFAULT_MATERIAL.color
          : colourOf(raw.color, `${id}.material.color`),
      roughness:
        raw.roughness === undefined
          ? DEFAULT_MATERIAL.roughness
          : unit(raw.roughness, `${id}.material.roughness`),
      metalness:
        raw.metalness === undefined
          ? DEFAULT_MATERIAL.metalness
          : unit(raw.metalness, `${id}.material.metalness`),
    };
  }

  function normalizeLight(raw, id) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      fail(`${id}.light must be an object`);
    rejectUnknown(raw, KEYS.light, `${id}.light`);
    if (!["ambient", "directional", "point"].includes(raw.type))
      fail(`${id}.light.type must be ambient, directional or point`);
    return {
      type: raw.type,
      color: raw.color === undefined ? "#ffffff" : colourOf(raw.color, `${id}.light.color`),
      intensity:
        raw.intensity === undefined
          ? 1
          : Math.max(0, finite(raw.intensity, `${id}.light.intensity`)),
      range: raw.range === undefined ? 20 : positive(raw.range, `${id}.light.range`),
    };
  }

  function normalizeShapeMesh(node, raw) {
    rejectUnknown(raw, KEYS.shape, `${node.id}.mesh`);
    const shape = raw.shape;
    if (!Object.prototype.hasOwnProperty.call(SHAPE_SIZE, shape))
      fail(`${node.id}.mesh.shape "${shape}" is unknown`);
    const size = raw.size === undefined ? SHAPE_SIZE[shape].slice() : raw.size;
    if (!Array.isArray(size) || size.length !== SHAPE_ARITY[shape]) {
      fail(`${node.id}.mesh.size must have ${SHAPE_ARITY[shape]} numbers for ${shape}`);
    }
    size.forEach((v, i) => positive(v, `${node.id}.mesh.size[${i}]`));
    node.mesh = { shape, size: size.slice() };
    node.geomKey = `${shape}:${size.join(",")}`;
    node.bounds = shapeBounds(shape, size);
  }

  function normalizeCustomMesh(node, raw) {
    rejectUnknown(raw, KEYS.custom, `${node.id}.mesh`);
    const pos = raw.positions;
    const known = Array.isArray(pos) ? customKeys.get(pos) : undefined;
    if (known && known.normals === raw.normals && known.indices === raw.indices) {
      node.mesh = {
        shape: "custom",
        positions: pos,
        normals: known.normals,
        indices: known.indices,
      };
      node.geomKey = known.key;
      node.bounds = known.bounds;
      return;
    }
    if (!Array.isArray(pos) || pos.length === 0 || pos.length % 3 !== 0) {
      fail(`${node.id}.mesh.positions must be a flat [x, y, z, ...] array`);
    }
    pos.forEach((v, i) => finite(v, `${node.id}.mesh.positions[${i}]`));
    const count = pos.length / 3;
    let normals = raw.normals;
    if (normals !== undefined) {
      if (!Array.isArray(normals) || normals.length !== pos.length)
        fail(`${node.id}.mesh.normals must match positions`);
      normals.forEach((v, i) => finite(v, `${node.id}.mesh.normals[${i}]`));
    }
    let indices = raw.indices;
    if (indices === undefined) {
      indices = Array.from({ length: count }, (_, i) => i);
    } else if (!Array.isArray(indices) || indices.length % 3 !== 0 || indices.length === 0) {
      fail(`${node.id}.mesh.indices must be a multiple of 3`);
    } else if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) {
      fail(`${node.id}.mesh.indices must be vertex indices`);
    }
    if (normals === undefined) normals = computeNormals(pos, indices);
    const entry = {
      key: `custom:${++customSeq}`,
      normals: Object.freeze(normals.slice()),
      indices: Object.freeze(indices.slice()),
      bounds: null,
    };
    const frozenPos = Object.freeze(pos.slice());
    entry.bounds = arrayBounds(frozenPos);
    customKeys.set(frozenPos, entry);
    node.mesh = {
      shape: "custom",
      positions: frozenPos,
      normals: entry.normals,
      indices: entry.indices,
    };
    node.geomKey = entry.key;
    node.bounds = entry.bounds;
  }

  function normalizeNode(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("a node must be an object");
    rejectUnknown(raw, KEYS.node, "node");
    if (typeof raw.id !== "string" || raw.id === "") fail("node.id must be a non-empty string");
    const id = raw.id;
    if (raw.parent !== undefined && raw.parent !== null && typeof raw.parent !== "string")
      fail(`${id}.parent must be an id or null`);
    if (raw.mesh !== undefined && raw.light !== undefined)
      fail(`${id} cannot be both a mesh and a light`);
    const node = {
      id,
      parent: raw.parent == null ? null : raw.parent,
      visible: raw.visible === undefined ? true : bool(raw.visible, `${id}.visible`),
      position: vec3(raw.position, [0, 0, 0], `${id}.position`, false),
      rotation: vec3(raw.rotation, [0, 0, 0], `${id}.rotation`, false),
      scale: vec3(raw.scale, [1, 1, 1], `${id}.scale`, true),
      mesh: null,
      geomKey: null,
      bounds: null,
      material: null,
      light: null,
    };
    if (raw.name !== undefined) {
      if (typeof raw.name !== "string") fail(`${id}.name must be a string`);
      node.name = raw.name;
    }
    if (raw.mesh !== undefined) {
      if (raw.mesh === null || typeof raw.mesh !== "object") fail(`${id}.mesh must be an object`);
      if (raw.mesh.shape === "custom") normalizeCustomMesh(node, raw.mesh);
      else normalizeShapeMesh(node, raw.mesh);
      node.material = normalizeMaterial(raw.material, id);
    } else if (raw.material !== undefined) {
      fail(`${id} has a material but no mesh`);
    }
    if (raw.light !== undefined) node.light = normalizeLight(raw.light, id);
    return node;
  }

  function serializeNode(n) {
    const out = {
      id: n.id,
      parent: n.parent,
      visible: n.visible,
      position: n.position.slice(),
      rotation: n.rotation.slice(),
      scale: n.scale.slice(),
    };
    if (n.name !== undefined) out.name = n.name;
    if (n.mesh) {
      out.mesh =
        n.mesh.shape === "custom"
          ? {
              shape: "custom",
              positions: n.mesh.positions,
              normals: n.mesh.normals,
              indices: n.mesh.indices,
            }
          : { shape: n.mesh.shape, size: n.mesh.size.slice() };
      out.material = { ...n.material };
    }
    if (n.light) out.light = { ...n.light };
    return out;
  }

  function validateGraph(map) {
    let dirs = 0,
      points = 0;
    for (const node of map.values()) {
      let p = node.parent,
        steps = 0;
      while (p !== null) {
        const parent = map.get(p);
        if (!parent) fail(`node "${node.id}" has unknown parent "${p}"`);
        if (++steps > map.size) fail(`parent cycle at node "${node.id}"`);
        p = parent.parent;
      }
      if (node.light && node.light.type === "directional") dirs++;
      if (node.light && node.light.type === "point") points++;
    }
    if (dirs > MAX_DIR) fail(`at most ${MAX_DIR} directional lights are supported`);
    if (points > MAX_POINT) fail(`at most ${MAX_POINT} point lights are supported`);
  }

  function descendantsOf(map, id) {
    const doomed = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of map.values()) {
        if (!doomed.has(n.id) && n.parent !== null && doomed.has(n.parent)) {
          doomed.add(n.id);
          grew = true;
        }
      }
    }
    return doomed;
  }

  // ---- glTF 2.0 import ----------------------------------------------------------
  const GLB_MAGIC = 0x46546c67,
    CHUNK_JSON = 0x4e4f534a,
    CHUNK_BIN = 0x004e4942;
  const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const COMP_NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
  const ARITY = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  let loadSeq = 0;

  function parseGltf(bytes) {
    const view = new DataView(bytes);
    let json = null,
      bin = null;
    if (bytes.byteLength >= 12 && view.getUint32(0, true) === GLB_MAGIC) {
      if (view.getUint32(4, true) !== 2) fail("GLB version must be 2");
      const total = Math.min(view.getUint32(8, true), bytes.byteLength);
      let off = 12;
      while (off + 8 <= total) {
        const len = view.getUint32(off, true),
          type = view.getUint32(off + 4, true);
        const chunk = bytes.slice(off + 8, off + 8 + len);
        if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(chunk));
        else if (type === CHUNK_BIN && bin === null) bin = chunk;
        off += 8 + len;
      }
    } else {
      json = JSON.parse(new TextDecoder().decode(bytes));
    }
    if (!json) fail("glTF has no JSON chunk");
    const buffers = (json.buffers || []).map((b, i) => {
      if (b.uri === undefined) {
        if (i === 0 && bin) return bin;
        fail(`buffer ${i} has no data`);
      }
      if (!b.uri.startsWith("data:"))
        fail("external glTF buffers are not supported; embed them as data: URIs");
      const text = atob(b.uri.slice(b.uri.indexOf(",") + 1));
      return Uint8Array.from(text, (c) => c.charCodeAt(0)).buffer;
    });
    return { json, buffers };
  }

  function readComponent(view, type, o) {
    switch (type) {
      case 5120:
        return view.getInt8(o);
      case 5121:
        return view.getUint8(o);
      case 5122:
        return view.getInt16(o, true);
      case 5123:
        return view.getUint16(o, true);
      case 5125:
        return view.getUint32(o, true);
      case 5126:
        return view.getFloat32(o, true);
      default:
        return fail(`accessor componentType ${type} is not supported`);
    }
  }

  function readAccessor(json, buffers, index) {
    const acc = json.accessors[index];
    if (!acc) fail(`accessor ${index} is missing`);
    if (acc.sparse) fail("sparse accessors are not supported");
    const bv = json.bufferViews[acc.bufferView];
    const buf = buffers[bv.buffer];
    if (!buf) fail(`buffer ${bv.buffer} is missing`);
    const size = COMP_SIZE[acc.componentType],
      n = ARITY[acc.type];
    if (!size || !n)
      fail(`accessor ${index} has unsupported type ${acc.type}/${acc.componentType}`);
    const stride = bv.byteStride || size * n;
    const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const view = new DataView(buf);
    const out = new Float32Array(acc.count * n);
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < n; c++) {
        let v = readComponent(view, acc.componentType, base + i * stride + c * size);
        if (acc.normalized && COMP_NORM[acc.componentType])
          v = Math.max(v / COMP_NORM[acc.componentType], -1);
        out[i * n + c] = v;
      }
    }
    return out;
  }

  function materialOf(m) {
    const pbr = m.pbrMetallicRoughness || {};
    const bc = pbr.baseColorFactor || [1, 1, 1, 1];
    return {
      color: hexOfLinear(bc),
      roughness: pbr.roughnessFactor === undefined ? 1 : pbr.roughnessFactor,
      metalness: pbr.metallicFactor === undefined ? 1 : pbr.metallicFactor,
    };
  }

  function gltfNodes(json, buffers, prefix, parentId, name) {
    const materials = (json.materials || []).map(materialOf);
    const rootId = `${prefix}root`;
    const out = [{ id: rootId, name, parent: parentId }];
    const visit = (index, parent) => {
      const g = json.nodes[index];
      if (!g) fail(`glTF node ${index} is missing`);
      const id = `${prefix}node${index}`;
      const t = g.matrix
        ? M.decompose(Float32Array.from(g.matrix))
        : M.decompose(
            M.fromQuat(
              g.translation || [0, 0, 0],
              g.rotation || [0, 0, 0, 1],
              g.scale || [1, 1, 1],
            ),
          );
      const node = { id, parent, position: t.position, rotation: t.rotation, scale: t.scale };
      if (typeof g.name === "string") node.name = g.name;
      out.push(node);
      if (g.mesh !== undefined) {
        const mesh = json.meshes[g.mesh];
        if (!mesh) fail(`glTF mesh ${g.mesh} is missing`);
        const parts = mesh.primitives.map((p) => {
          if ((p.mode ?? 4) !== 4) fail(`primitive mode ${p.mode} is not supported; use triangles`);
          if (p.attributes.POSITION === undefined) fail("primitive has no POSITION");
          return {
            mesh: {
              shape: "custom",
              positions: Array.from(readAccessor(json, buffers, p.attributes.POSITION)),
              normals:
                p.attributes.NORMAL === undefined
                  ? undefined
                  : Array.from(readAccessor(json, buffers, p.attributes.NORMAL)),
              indices:
                p.indices === undefined
                  ? undefined
                  : Array.from(readAccessor(json, buffers, p.indices)),
            },
            material:
              p.material === undefined ? { ...DEFAULT_MATERIAL } : { ...materials[p.material] },
          };
        });
        // One primitive sits on the node itself; several become child nodes "<node>/p<k>".
        if (parts.length === 1) Object.assign(node, parts[0]);
        else parts.forEach((part, k) => out.push({ id: `${id}/p${k}`, parent: id, ...part }));
      }
      for (const c of g.children || []) visit(c, id);
    };
    const scene = json.scenes ? json.scenes[json.scene ?? 0] : null;
    let roots;
    if (scene) roots = scene.nodes || [];
    else {
      const child = new Set((json.nodes || []).flatMap((n) => n.children || []));
      roots = (json.nodes || []).map((_, i) => i).filter((i) => !child.has(i));
    }
    for (const r of roots) visit(r, rootId);
    return out;
  }

  // ---- WebGL resources -----------------------------------------------------------
  const SCENE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=3) in vec4 aM0;
layout(location=4) in vec4 aM1;
layout(location=5) in vec4 aM2;
layout(location=6) in vec4 aM3;
layout(location=7) in vec3 aN0;
layout(location=8) in vec3 aN1;
layout(location=9) in vec3 aN2;
layout(location=10) in vec4 aMat;
layout(location=11) in float aMetal;
uniform mat4 uViewProj;
out vec3 vPos;
out vec3 vNormal;
out vec3 vColor;
out float vRough;
out float vMetal;
void main() {
  mat4 model = mat4(aM0, aM1, aM2, aM3);
  vec4 wp = model * vec4(aPos, 1.0);
  vPos = wp.xyz;
  vNormal = normalize(mat3(aN0, aN1, aN2) * aNormal);
  vColor = aMat.rgb;
  vRough = aMat.a;
  vMetal = aMetal;
  gl_Position = uViewProj * wp;
}`;

  const SCENE_FS = `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNormal;
in vec3 vColor;
in float vRough;
in float vMetal;
out vec4 outColor;
uniform vec3 uCamPos;
uniform vec3 uAmbient;
uniform vec3 uEnv;
uniform int uDirCount;
uniform vec3 uDirDir[4];
uniform vec3 uDirCol[4];
uniform int uPointCount;
uniform vec3 uPointPos[8];
uniform vec3 uPointCol[8];
uniform float uPointRange[8];
const float PI = 3.14159265;
vec3 brdf(vec3 N, vec3 V, vec3 L, vec3 radiance, vec3 albedo, vec3 F0, float rough, float metal) {
  vec3 H = normalize(V + L);
  float NdotL = max(dot(N, L), 0.0);
  float NdotV = max(dot(N, V), 1e-3);
  float NdotH = max(dot(N, H), 0.0);
  float VdotH = max(dot(V, H), 0.0);
  float a = rough * rough;
  float a2 = a * a;
  float dn = NdotH * NdotH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dn * dn);
  float k = (rough + 1.0) * (rough + 1.0) / 8.0;
  float G = (NdotL / (NdotL * (1.0 - k) + k)) * (NdotV / (NdotV * (1.0 - k) + k));
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VdotH, 5.0);
  vec3 spec = D * G * F / max(4.0 * NdotL * NdotV, 1e-4);
  vec3 diff = (1.0 - F) * (1.0 - metal) * albedo / PI;
  return (diff + spec) * radiance * NdotL;
}
void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCamPos - vPos);
  vec3 albedo = pow(max(vColor, vec3(0.0)), vec3(2.2));
  float rough = clamp(vRough, 0.04, 1.0);
  float metal = clamp(vMetal, 0.0, 1.0);
  vec3 F0 = mix(vec3(0.04), albedo, metal);
  // Image-based light stand-in: a procedural sky (bright above, dark below the horizon) lit by the scene's lights.
  // Diffuse takes the hemisphere average; specular samples it along the reflection, blurred by roughness.
  float NdotV = max(dot(N, V), 0.0);
  vec3 Fa = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(1.0 - NdotV, 5.0);
  vec3 R = reflect(-V, N);
  float sky = mix(smoothstep(-0.15, 0.5, R.y), 0.5 + 0.5 * R.y, rough);
  vec3 env = uEnv * mix(0.15, 1.6, sky);
  vec3 col = uAmbient * (0.7 + 0.3 * N.y) * albedo * (1.0 - metal) * (1.0 - Fa) + env * Fa;
  for (int i = 0; i < 4; i++) {
    if (i >= uDirCount) break;
    col += brdf(N, V, -uDirDir[i], uDirCol[i], albedo, F0, rough, metal);
  }
  for (int i = 0; i < 8; i++) {
    if (i >= uPointCount) break;
    vec3 d = uPointPos[i] - vPos;
    float dist = length(d);
    vec3 L = d / max(dist, 1e-4);
    float falloff = clamp(1.0 - pow(dist / uPointRange[i], 4.0), 0.0, 1.0);
    falloff *= falloff;
    col += brdf(N, V, L, uPointCol[i] * falloff / (dist * dist + 1.0), albedo, F0, rough, metal);
  }
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  outColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

  const GRID_VS = `#version 300 es
layout(location=0) in vec2 aXZ;
uniform mat4 uViewProj;
uniform float uExtent;
out vec2 vXZ;
void main() {
  vec2 p = aXZ * uExtent;
  vXZ = p;
  gl_Position = uViewProj * vec4(p.x, 0.0, p.y, 1.0);
}`;

  const GRID_FS = `#version 300 es
precision highp float;
in vec2 vXZ;
out vec4 outColor;
uniform vec2 uCamXZ;
uniform float uFade;
uniform vec3 uLine;
uniform vec3 uAxisX;
uniform vec3 uAxisZ;
float gridLine(vec2 coord, float spacing) {
  vec2 c = coord / spacing;
  vec2 d = fwidth(c);
  vec2 g = abs(fract(c - 0.5) - 0.5) / max(d, vec2(1e-5));
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  float dist = length(vXZ - uCamXZ);
  float fade = 1.0 - smoothstep(uFade * 0.35, uFade, dist);
  vec2 d = fwidth(vXZ);
  // Lines thinner than a pixel alias into moire, so they fade out as they approach that size.
  float tiny = 1.0 - smoothstep(0.25, 0.6, max(d.x, d.y));
  float minor = gridLine(vXZ, 1.0) * tiny;
  float major = gridLine(vXZ, 10.0);
  float axX = 1.0 - min(abs(vXZ.y) / max(d.y, 1e-5), 1.0);
  float axZ = 1.0 - min(abs(vXZ.x) / max(d.x, 1e-5), 1.0);
  float a = max(minor * 0.18, major * 0.34);
  vec3 rgb = uLine;
  if (axX > 0.0) { rgb = uAxisX; a = max(a, axX * 0.9); }
  if (axZ > 0.0) { rgb = uAxisZ; a = max(a, axZ * 0.9); }
  a *= fade;
  if (a < 0.003) discard;
  outColor = vec4(rgb, a);
}`;

  function compile(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) fail(gl.getShaderInfoLog(shader));
    return shader;
  }
  function link(gl, vsSrc, fsSrc, uniforms) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) fail(gl.getProgramInfoLog(prog));
    const u = {};
    for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
    return { prog, u };
  }

  // ---- Instance -----------------------------------------------------------------
  function createEmitter() {
    const handlers = new Map();
    return {
      on(name, cb) {
        if (!["change", "select", "camera"].includes(name)) fail(`unknown event "${name}"`);
        if (typeof cb !== "function") fail("on() needs a callback");
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name).add(cb);
        return () => handlers.get(name).delete(cb);
      },
      emit(name, payload) {
        const set = handlers.get(name);
        if (set) for (const cb of [...set]) cb(payload);
      },
    };
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function injectStyle() {
    if (document.querySelector('style[data-t3kit="scene3d"]')) return;
    const style = el("style");
    style.setAttribute("data-t3kit", "scene3d");
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function create(container, options) {
    if (!(container instanceof HTMLElement)) fail("create() needs an HTMLElement container");
    const opts = options ?? {};
    if (typeof opts !== "object" || Array.isArray(opts)) fail("options must be an object");
    rejectUnknown(opts, KEYS.option, "options");
    injectStyle();

    const controller = new AbortController();
    const signal = controller.signal;
    const emitter = createEmitter();
    const state = {
      nodes: new Map(),
      selected: null,
      mode: "move",
      snap: { move: 0, rotate: 0 },
      camera: { ...DEFAULT_CAMERA, target: DEFAULT_CAMERA.target.slice() },
      grid: true,
      axes: true,
      defaultLights:
        opts.defaultLights === undefined ? true : bool(opts.defaultLights, "options.defaultLights"),
    };
    let idSeq = 0;
    let hover = null; // gizmo handle under the mouse: 0..2 axis, 3 = uniform scale
    let cameraMoved = false; // a user camera move waiting for its once-per-frame 'camera' event
    let editPending = false; // a user drag edit waiting for its once-per-frame 'change' event
    const cpuCache = new Map(); // geomKey -> {positions, indices} for exact picking
    const size = { w: 1, h: 1 };
    let dpr = 1;
    let theme = null;
    let themeDirty = true;
    let derived = { entries: new Map(), buckets: [], data: new Float32Array(0), light: null };
    let sceneDirty = true;
    let gpuDirty = true;
    let lost = false;
    let destroyed = false;
    let rafId = 0;
    let drag = null;
    let gpu = null;
    let vaos = [];
    const geoCache = new Map();
    const pointers = new Map();
    const cam = { eye: [0, 0, 0], view: null, viewProj: null, inv: null };

    // DOM
    const root = el("div", "t3k-scene3d-root");
    const canvas = el("canvas", "t3k-scene3d-canvas");
    canvas.setAttribute("role", "application");
    canvas.setAttribute(
      "aria-label",
      "3D viewport: drag to orbit, shift-drag to pan, scroll to zoom, W E R to switch tools",
    );
    canvas.tabIndex = 0;
    const overlay = el("canvas", "t3k-scene3d-overlay");
    overlay.setAttribute("aria-hidden", "true");
    root.append(canvas, overlay);
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) fail("WebGL2 is unavailable");
    const overlayCtx = overlay.getContext("2d");
    container.appendChild(root);

    // Toolbar
    const buttons = {};
    if (opts.controls === undefined ? true : bool(opts.controls, "options.controls")) {
      const bar = el("div", "t3k-scene3d-toolbar");
      bar.setAttribute("role", "toolbar");
      bar.setAttribute("aria-label", "Scene tools");
      const add = (key, label, title, act, pressed) => {
        const b = el("button", "t3k-scene3d-tool");
        b.type = "button";
        b.textContent = label;
        b.title = title;
        b.addEventListener("click", () => act(), { signal });
        if (pressed) b.setAttribute("aria-pressed", "false");
        buttons[key] = b;
        bar.appendChild(b);
      };
      add("move", "Move", "Move (W)", () => setMode("move", true), true);
      add("rotate", "Rotate", "Rotate (E)", () => setMode("rotate", true), true);
      add("scale", "Scale", "Scale (R)", () => setMode("scale", true), true);
      bar.appendChild(el("span", "t3k-scene3d-sep"));
      add("grid", "Grid", "Grid (G)", () => toggleView("grid"), true);
      add("axes", "Axes", "Axis gizmo (X)", () => toggleView("axes"), true);
      bar.appendChild(el("span", "t3k-scene3d-sep"));
      add(
        "frame",
        "Frame",
        "Frame selection, or everything (F)",
        () => {
          frameNodes(state.selected);
          cameraMoved = true;
        },
        false,
      );
      root.appendChild(bar);
    }

    // ---- Theme -------------------------------------------------------------
    function readTheme() {
      const p = probeContext();
      const styles = getComputedStyle(document.documentElement);
      const css = {},
        rgb = {};
      for (const key of Object.keys(THEME_TOKENS)) {
        const token = THEME_TOKENS[key];
        const raw = styles.getPropertyValue(token).trim();
        if (raw === "") fail(`theme token ${token} is not set`);
        p.fillStyle = "#000001";
        p.fillStyle = raw;
        if (p.fillStyle === "#000001" && raw.toLowerCase() !== "#000001")
          fail(`theme token ${token} is not a colour`);
        p.clearRect(0, 0, 1, 1);
        p.fillRect(0, 0, 1, 1);
        const px = p.getImageData(0, 0, 1, 1).data;
        css[key] = raw;
        rgb[key] = [px[0] / 255, px[1] / 255, px[2] / 255];
      }
      const font = styles.getPropertyValue("--font-sans").trim();
      if (font === "") fail("theme token --font-sans is not set");
      theme = { css, rgb, font };
      themeDirty = false;
    }

    // ---- GL resources --------------------------------------------------------
    function initGL() {
      const sceneU = [
        "uViewProj",
        "uCamPos",
        "uAmbient",
        "uEnv",
        "uDirCount",
        "uDirDir",
        "uDirCol",
        "uPointCount",
        "uPointPos",
        "uPointCol",
        "uPointRange",
      ];
      const gridU = ["uViewProj", "uExtent", "uCamXZ", "uFade", "uLine", "uAxisX", "uAxisZ"];
      const scene = link(gl, SCENE_VS, SCENE_FS, sceneU);
      const grid = link(gl, GRID_VS, GRID_FS, gridU);
      const quad = gl.createVertexArray();
      gl.bindVertexArray(quad);
      const quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        Float32Array.from([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      gpu = { scene, grid: { ...grid, vao: quad }, instBuf: gl.createBuffer() };
      geoCache.clear();
      vaos = [];
      gpuDirty = true;
    }

    // CPU geometry for a mesh source, cached by geometry key (shared by the GPU upload and exact picking).
    function cpuGeometry(key, source) {
      const hit = cpuCache.get(key);
      if (hit) return hit;
      const cpu = source.shape === "custom" ? source : shapeCpu(source.shape, source.size);
      cpuCache.set(key, cpu);
      return cpu;
    }

    function ensureGeometry(key, source) {
      const hit = geoCache.get(key);
      if (hit) return hit;
      const src = cpuGeometry(key, source);
      const cpu = {
        positions: Float32Array.from(src.positions),
        normals: Float32Array.from(src.normals),
        indices: Uint32Array.from(src.indices),
      };
      const n = cpu.positions.length / 3;
      const inter = new Float32Array(n * 6);
      for (let i = 0; i < n; i++) {
        inter.set(cpu.positions.subarray(i * 3, i * 3 + 3), i * 6);
        inter.set(cpu.normals.subarray(i * 3, i * 3 + 3), i * 6 + 3);
      }
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);
      const ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cpu.indices, gl.STATIC_DRAW);
      const geo = { vbo, ibo, indexCount: cpu.indices.length };
      geoCache.set(key, geo);
      return geo;
    }

    function makeVao(geo, start) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, geo.vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, geo.ibo);
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.instBuf);
      const base = start * INST * 4;
      for (let k = 0; k < 4; k++) {
        gl.enableVertexAttribArray(3 + k);
        gl.vertexAttribPointer(3 + k, 4, gl.FLOAT, false, INST * 4, base + k * 16);
        gl.vertexAttribDivisor(3 + k, 1);
      }
      for (let k = 0; k < 3; k++) {
        gl.enableVertexAttribArray(7 + k);
        gl.vertexAttribPointer(7 + k, 3, gl.FLOAT, false, INST * 4, base + 64 + k * 12);
        gl.vertexAttribDivisor(7 + k, 1);
      }
      gl.enableVertexAttribArray(10);
      gl.vertexAttribPointer(10, 4, gl.FLOAT, false, INST * 4, base + 100);
      gl.vertexAttribDivisor(10, 1);
      gl.enableVertexAttribArray(11);
      gl.vertexAttribPointer(11, 1, gl.FLOAT, false, INST * 4, base + 116);
      gl.vertexAttribDivisor(11, 1);
      gl.bindVertexArray(null);
      return vao;
    }

    function uploadDerived() {
      for (const v of vaos) gl.deleteVertexArray(v);
      vaos = [];
      const used = new Set(derived.buckets.map((b) => b.key));
      for (const [key, geo] of geoCache) {
        if (used.has(key)) continue;
        gl.deleteBuffer(geo.vbo);
        gl.deleteBuffer(geo.ibo);
        geoCache.delete(key);
      }
      for (const key of cpuCache.keys()) if (!used.has(key)) cpuCache.delete(key);
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, derived.data, gl.DYNAMIC_DRAW);
      for (const b of derived.buckets) {
        const geo = ensureGeometry(b.key, b.source);
        b.indexCount = geo.indexCount;
        b.vao = makeVao(geo, b.start);
        vaos.push(b.vao);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    // ---- Derived scene (CPU) ---------------------------------------------------
    function writeInstance(out, o, w, mat) {
      for (let i = 0; i < 16; i++) out[o + i] = w[i];
      const inv = invert3(rows3(w));
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++) out[o + 16 + j * 3 + k] = inv[j * 3 + k];
      const rgb = srgbOf(mat.color);
      out[o + 25] = rgb[0];
      out[o + 26] = rgb[1];
      out[o + 27] = rgb[2];
      out[o + 28] = mat.roughness;
      out[o + 29] = mat.metalness;
    }

    function computeDerived() {
      const entries = new Map();
      const resolve = (id) => {
        const hit = entries.get(id);
        if (hit) return hit;
        const node = state.nodes.get(id);
        const parent = node.parent === null ? null : resolve(node.parent);
        const local = M.trs(node.position, node.rotation, node.scale);
        const world = parent ? M.mul(parent.world, local) : local;
        const entry = {
          id,
          node,
          world,
          visible: node.visible && (parent === null || parent.visible),
          inv: null,
        };
        entries.set(id, entry);
        return entry;
      };
      for (const id of state.nodes.keys()) resolve(id);

      const groups = new Map();
      let total = 0;
      for (const e of entries.values()) {
        if (!e.visible || !e.node.mesh) continue;
        if (!groups.has(e.node.geomKey)) groups.set(e.node.geomKey, []);
        groups.get(e.node.geomKey).push(e);
        total++;
      }
      const data = new Float32Array(total * INST);
      const buckets = [];
      let at = 0;
      for (const [key, list] of groups) {
        const start = at;
        for (const e of list) {
          writeInstance(data, at * INST, e.world, e.node.material);
          at++;
        }
        buckets.push({
          key,
          source: list[0].node.mesh,
          start,
          count: list.length,
          vao: null,
          indexCount: 0,
        });
      }

      let anyLight = false;
      const amb = [0, 0, 0];
      const dirs = [],
        pts = [];
      for (const n of state.nodes.values()) if (n.light) anyLight = true;
      for (const e of entries.values()) {
        if (!e.visible || !e.node.light) continue;
        const L = e.node.light;
        const c = linearOf(L.color);
        if (L.type === "ambient") {
          for (let k = 0; k < 3; k++) amb[k] += c[k] * L.intensity;
        } else if (L.type === "directional") {
          dirs.push({ dir: travelDir(e.world), col: c.map((v) => v * L.intensity * Math.PI) });
        } else {
          pts.push({
            pos: [e.world[12], e.world[13], e.world[14]],
            col: c.map((v) => v * L.intensity * Math.PI),
            range: L.range,
          });
        }
      }
      if (!anyLight && state.defaultLights) {
        for (let k = 0; k < 3; k++) amb[k] = 0.35;
        dirs.push({ dir: DEFAULT_KEY_DIR, col: [1.1 * Math.PI, 1.1 * Math.PI, 1.1 * Math.PI] });
        dirs.push({ dir: DEFAULT_FILL_DIR, col: [0.3 * Math.PI, 0.3 * Math.PI, 0.3 * Math.PI] });
      }
      // Sky radiance for reflections: ambient plus a share of every directional light.
      const env = amb.slice();
      for (const d of dirs) for (let k = 0; k < 3; k++) env[k] += (d.col[k] / Math.PI) * 0.3;
      const light = {
        amb: Float32Array.from(amb),
        env: Float32Array.from(env),
        dirCount: dirs.length,
        dirDir: new Float32Array(MAX_DIR * 3),
        dirCol: new Float32Array(MAX_DIR * 3),
        pointCount: pts.length,
        pointPos: new Float32Array(MAX_POINT * 3),
        pointCol: new Float32Array(MAX_POINT * 3),
        pointRange: new Float32Array(MAX_POINT),
      };
      dirs.forEach((d, i) => {
        light.dirDir.set(d.dir, i * 3);
        light.dirCol.set(d.col, i * 3);
      });
      pts.forEach((p, i) => {
        light.pointPos.set(p.pos, i * 3);
        light.pointCol.set(p.col, i * 3);
        light.pointRange[i] = p.range;
      });
      derived = { entries, buckets, data, light };
    }

    function ensureDerived() {
      if (sceneDirty) {
        computeDerived();
        sceneDirty = false;
        gpuDirty = true;
      }
      if (gpuDirty && !lost) {
        uploadDerived();
        gpuDirty = false;
      }
    }

    // ---- Camera ----------------------------------------------------------------
    function updateCamera(aspect) {
      const c = state.camera;
      const el = Math.max(-89, Math.min(89, c.elevation)) * DEG;
      const az = c.azimuth * DEG;
      const t = c.target;
      const eye = [
        t[0] + c.distance * Math.cos(el) * Math.sin(az),
        t[1] + c.distance * Math.sin(el),
        t[2] + c.distance * Math.cos(el) * Math.cos(az),
      ];
      const near = Math.max(0.02, c.distance * 0.01);
      const far = Math.max(1000, c.distance * 200);
      cam.eye = eye;
      cam.view = M.lookAt(eye, t, [0, 1, 0]);
      cam.proj = M.perspective(c.fov * DEG, aspect ?? size.w / size.h, near, far);
      cam.viewProj = M.mul(cam.proj, cam.view);
      cam.inv = M.invert(cam.viewProj);
    }

    function project(p) {
      const vp = cam.viewProj;
      const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
      const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
      const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
      if (w <= 1e-6) return null;
      return { x: ((x / w) * 0.5 + 0.5) * size.w, y: (0.5 - (y / w) * 0.5) * size.h };
    }

    function screenRay(px, py) {
      const nx = (px / size.w) * 2 - 1,
        ny = 1 - (py / size.h) * 2;
      const unproject = (z) => {
        const m = cam.inv;
        const x = m[0] * nx + m[4] * ny + m[8] * z + m[12];
        const y = m[1] * nx + m[5] * ny + m[9] * z + m[13];
        const zz = m[2] * nx + m[6] * ny + m[10] * z + m[14];
        const w = m[3] * nx + m[7] * ny + m[11] * z + m[15];
        return [x / w, y / w, zz / w];
      };
      const near = unproject(-1),
        far = unproject(1);
      const d = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      return { o: near, d: [d[0] / l, d[1] / l, d[2] / l] };
    }

    // ---- Picking -----------------------------------------------------------------
    // Ray against the node's local bounds first, then its triangles (boxes are exact already). Returns world distance.
    function rayHit(e, r) {
      if (!e.inv) e.inv = M.invert(e.world);
      if (!e.inv) return null;
      const o = xformPoint(e.inv, r.o);
      const d = xformDir(e.inv, r.d);
      const b = e.node.bounds;
      let tmin = -Infinity,
        tmax = Infinity;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(d[k]) < 1e-12) {
          if (o[k] < b.min[k] || o[k] > b.max[k]) return null;
          continue;
        }
        let t1 = (b.min[k] - o[k]) / d[k],
          t2 = (b.max[k] - o[k]) / d[k];
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) return null;
      }
      if (tmax < 0) return null;
      // The local ray is o + d t with the same t as the world ray (an affine map keeps the parameter).
      if (e.node.mesh.shape === "box") return Math.max(tmin, 0);
      const cpu = cpuGeometry(e.node.geomKey, e.node.mesh);
      return rayTriangles(o, d, cpu.positions, cpu.indices);
    }

    function pickMesh(px, py) {
      const r = screenRay(px, py);
      let best = null,
        bestT = Infinity;
      for (const e of derived.entries.values()) {
        if (!e.visible || !e.node.mesh) continue;
        const t = rayHit(e, r);
        if (t !== null && t < bestT) {
          bestT = t;
          best = e.id;
        }
      }
      return best;
    }

    function pickLight(px, py) {
      let best = null,
        bestD = 14;
      for (const e of derived.entries.values()) {
        if (!e.visible || !e.node.light) continue;
        const s = project([e.world[12], e.world[13], e.world[14]]);
        if (!s) continue;
        const d = Math.hypot(px - s.x, py - s.y);
        if (d < bestD) {
          bestD = d;
          best = e.id;
        }
      }
      return best;
    }

    // ---- Transform gizmo -----------------------------------------------------------
    // Move uses world axes, rotate world rings, scale the node's own (local) axes. Handle length is constant on screen.
    function gizmoAxes(e) {
      if (state.mode !== "scale") return AXIS_VEC;
      return [0, 1, 2].map((i) => norm3([e.world[i * 4], e.world[i * 4 + 1], e.world[i * 4 + 2]]));
    }

    function gizmoGeometry(id) {
      const e = derived.entries.get(id);
      if (!e || !e.visible) return null;
      const o = [e.world[12], e.world[13], e.world[14]];
      const so = project(o);
      if (!so) return null;
      // Keep the gizmo ~90 px long whatever the depth: scale by the eye distance to the node.
      const depth = Math.hypot(o[0] - cam.eye[0], o[1] - cam.eye[1], o[2] - cam.eye[2]);
      const L = (depth * Math.tan((state.camera.fov * DEG) / 2) * 2 * 90) / size.h;
      const dirs = gizmoAxes(e);
      const axes = [0, 1, 2].map((i) => ({
        i,
        dir: dirs[i],
        se: project([o[0] + dirs[i][0] * L, o[1] + dirs[i][1] * L, o[2] + dirs[i][2] * L]),
      }));
      const rings = [0, 1, 2].map((i) => {
        const u = AXIS_VEC[(i + 1) % 3],
          v = AXIS_VEC[(i + 2) % 3];
        const pts = [];
        for (let k = 0; k <= 64; k++) {
          const t = (TAU * k) / 64,
            c = Math.cos(t) * L,
            s = Math.sin(t) * L;
          pts.push(
            project([
              o[0] + u[0] * c + v[0] * s,
              o[1] + u[1] * c + v[1] * s,
              o[2] + u[2] * c + v[2] * s,
            ]),
          );
        }
        return pts;
      });
      return { e, o, so, L, axes, rings };
    }

    function segDist(p, a, b) {
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t =
        len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    }

    // Handle under p: 0..2 = axis, 3 = uniform scale (centre square in scale mode), null = none.
    function hitGizmo(p) {
      if (!state.selected) return null;
      const g = gizmoGeometry(state.selected);
      if (!g) return null;
      if (state.mode === "scale" && Math.max(Math.abs(p.x - g.so.x), Math.abs(p.y - g.so.y)) <= 7)
        return 3;
      let best = null,
        bestD = HIT_PX;
      for (const a of g.axes) {
        let d = Infinity;
        if (state.mode === "rotate") {
          const pts = g.rings[a.i];
          for (let k = 0; k < pts.length - 1; k++) {
            if (pts[k] && pts[k + 1]) d = Math.min(d, segDist(p, pts[k], pts[k + 1]));
          }
        } else if (a.se) {
          d = segDist(p, g.so, a.se);
        }
        if (d < bestD) {
          bestD = d;
          best = a.i;
        }
      }
      return best;
    }

    // Rotation-only 3x3 (row-major) of a world matrix: columns normalised, so parent scale does not skew the axis.
    function rotRows(w) {
      const c = [0, 1, 2].map((i) => norm3([w[i * 4], w[i * 4 + 1], w[i * 4 + 2]]));
      return [c[0][0], c[1][0], c[2][0], c[0][1], c[1][1], c[2][1], c[0][2], c[1][2], c[2][2]];
    }

    function startGizmo(handle, p) {
      const id = state.selected;
      const g = gizmoGeometry(id);
      const node = state.nodes.get(id);
      const pe = node.parent === null ? null : derived.entries.get(node.parent);
      const ray = screenRay(p.x, p.y);
      const d = {
        mode: "gizmo",
        tool: state.mode,
        id,
        axis: handle,
        start: p,
        latest: p,
        down: p,
        dirty: false,
        moved: 0,
        o: g.o,
        dir: handle < 3 ? g.axes[handle].dir : null,
        parentInv: pe ? invert3(rows3(pe.world)) : null,
        parentRot: pe ? rotRows(pe.world) : null,
        startPos: node.position.slice(),
        startRot: node.rotation.slice(),
        startScale: node.scale.slice(),
        t0: null,
        v0: null,
      };
      if (d.tool === "rotate") {
        const hit = planeHit(ray, d.o, d.dir);
        d.v0 = hit ? norm3(sub3(hit, d.o)) : null;
      } else if (handle < 3) {
        const t = axisParam(ray, d.o, d.dir);
        // Scale divides by t0, so keep it away from the origin: at least a quarter of the handle.
        d.t0 =
          t === null
            ? null
            : d.tool === "scale"
              ? Math.sign(t || 1) * Math.max(Math.abs(t), g.L * 0.25)
              : t;
      }
      return d;
    }

    function snapTo(v, step) {
      return step > 0 ? Math.round(v / step) * step : v;
    }

    // Applies the newest pointer position. Returns true when the node changed.
    function applyGizmo(d) {
      const node = state.nodes.get(d.id);
      if (!node) return false;
      const ray = screenRay(d.latest.x, d.latest.y);
      if (d.tool === "move") {
        if (d.t0 === null) return false;
        const t = axisParam(ray, d.o, d.dir);
        if (t === null) return false;
        const delta = snapTo(t - d.t0, state.snap.move);
        const w = [d.dir[0] * delta, d.dir[1] * delta, d.dir[2] * delta];
        const local = d.parentInv ? mulVec3(d.parentInv, w) : w;
        node.position = [0, 1, 2].map((k) => d.startPos[k] + local[k]);
      } else if (d.tool === "rotate") {
        if (!d.v0) return false;
        const hit = planeHit(ray, d.o, d.dir);
        if (!hit) return false;
        const v1 = norm3(sub3(hit, d.o));
        let ang = Math.atan2(dot3(cross3(d.v0, v1), d.dir), dot3(d.v0, v1));
        ang = snapTo(ang / DEG, state.snap.rotate) * DEG;
        // World axis in the parent's frame, then R_local' = R(axis, ang) * R_local.
        const a = d.parentRot
          ? norm3(
              [0, 1, 2].map(
                (k) =>
                  d.parentRot[k] * d.dir[0] +
                  d.parentRot[3 + k] * d.dir[1] +
                  d.parentRot[6 + k] * d.dir[2],
              ),
            )
          : d.dir;
        const r = M.decompose(
          M.mul(axisAngle(a, ang), M.trs([0, 0, 0], d.startRot, [1, 1, 1])),
        ).rotation;
        node.rotation = r.map((v) => Math.round(v * 1e6) / 1e6);
      } else if (d.axis === 3) {
        const f = Math.exp((d.latest.x - d.start.x - (d.latest.y - d.start.y)) / 150);
        node.scale = d.startScale.map((v) => v * f);
      } else {
        if (d.t0 === null) return false;
        const t = axisParam(ray, d.o, d.dir);
        if (t === null) return false;
        const f = Math.max(0.01, t / d.t0);
        const s = d.startScale.slice();
        s[d.axis] = d.startScale[d.axis] * f;
        node.scale = s;
      }
      sceneDirty = true;
      return true;
    }

    // ---- Overlay ---------------------------------------------------------------
    function paintLine(ctx, a, b, color, width) {
      if (!a || !b) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    function paintArrowHead(ctx, from, tip, color) {
      const dx = tip.x - from.x,
        dy = tip.y - from.y;
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l,
        uy = dy / l;
      const bx = tip.x - ux * 9,
        by = tip.y - uy * 9;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(bx - uy * 5, by + ux * 5);
      ctx.lineTo(bx + uy * 5, by - ux * 5);
      ctx.closePath();
      ctx.fill();
    }

    function paintSelection(ctx) {
      const e = derived.entries.get(state.selected);
      if (!e || !e.visible || !e.node.bounds) return;
      const b = e.node.bounds;
      const c = [];
      for (let k = 0; k < 8; k++) {
        const local = [
          k & 1 ? b.max[0] : b.min[0],
          k & 2 ? b.max[1] : b.min[1],
          k & 4 ? b.max[2] : b.min[2],
        ];
        c.push(project(xformPoint(e.world, local)));
      }
      const edges = [
        [0, 1],
        [2, 3],
        [4, 5],
        [6, 7],
        [0, 2],
        [1, 3],
        [4, 6],
        [5, 7],
        [0, 4],
        [1, 5],
        [2, 6],
        [3, 7],
      ];
      ctx.setLineDash([4, 3]);
      for (const [a, z] of edges) paintLine(ctx, c[a], c[z], theme.css.primary, 1.5);
      ctx.setLineDash([]);
    }

    function paintGizmo(ctx) {
      const g = gizmoGeometry(state.selected);
      if (!g) return;
      const active = drag && drag.mode === "gizmo" ? drag.axis : hover;
      for (const a of g.axes) {
        const color = theme.css[AXIS_TOKEN[a.i]];
        const width = active === a.i ? 3.5 : 2;
        if (state.mode === "rotate") {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          let pen = false;
          for (const p of g.rings[a.i]) {
            if (!p) {
              pen = false;
              continue;
            }
            if (pen) ctx.lineTo(p.x, p.y);
            else ctx.moveTo(p.x, p.y);
            pen = true;
          }
          ctx.stroke();
        } else if (a.se) {
          paintLine(ctx, g.so, a.se, color, width);
          if (state.mode === "move") {
            paintArrowHead(ctx, g.so, a.se, color);
          } else {
            const r = active === a.i ? 5 : 4;
            ctx.fillStyle = color;
            ctx.fillRect(a.se.x - r, a.se.y - r, r * 2, r * 2);
          }
        }
      }
      if (state.mode === "scale") {
        ctx.strokeStyle = theme.css.fg;
        ctx.lineWidth = active === 3 ? 2.5 : 1.5;
        ctx.strokeRect(g.so.x - 6, g.so.y - 6, 12, 12);
      } else {
        ctx.fillStyle = theme.css.fg;
        ctx.beginPath();
        ctx.arc(g.so.x, g.so.y, 2.5, 0, TAU);
        ctx.fill();
      }
    }

    function paintLights(ctx) {
      for (const e of derived.entries.values()) {
        if (!e.visible || !e.node.light) continue;
        const type = e.node.light.type;
        if (type === "ambient") continue;
        const s = project([e.world[12], e.world[13], e.world[14]]);
        if (!s) continue;
        const color = theme.css.warning;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.5;
        if (type === "point") {
          ctx.beginPath();
          ctx.arc(s.x, s.y, 9, 0, TAU);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(s.x, s.y, 3, 0, TAU);
          ctx.fill();
        } else {
          const d = travelDir(e.world);
          const tip = project([
            e.world[12] + d[0] * state.camera.distance * 0.2,
            e.world[13] + d[1] * state.camera.distance * 0.2,
            e.world[14] + d[2] * state.camera.distance * 0.2,
          ]);
          paintLine(ctx, s, tip, color, 1.5);
          if (tip) paintArrowHead(ctx, s, tip, color);
          ctx.beginPath();
          ctx.arc(s.x, s.y, 3, 0, TAU);
          ctx.fill();
        }
      }
    }

    function axisLabels() {
      const v = cam.view;
      const cx = 44,
        cy = size.h - 44,
        R = 30;
      return [0, 1, 2]
        .map((i) => ({ i, x: cx + R * v[i * 4], y: cy - R * v[i * 4 + 1], z: v[i * 4 + 2] }))
        .sort((a, b) => a.z - b.z);
    }

    function paintAxes(ctx) {
      const cx = 44,
        cy = size.h - 44;
      for (const a of axisLabels()) {
        const color = theme.css[AXIS_TOKEN[a.i]];
        paintLine(ctx, { x: cx, y: cy }, { x: a.x, y: a.y }, color, 2);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(a.x, a.y, 8, 0, TAU);
        ctx.fill();
        ctx.fillStyle = theme.css.bg;
        ctx.font = `600 10px ${theme.font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(["X", "Y", "Z"][a.i], a.x, a.y + 0.5);
      }
    }

    function hitAxisLabel(p) {
      for (const a of axisLabels()) {
        if (Math.hypot(p.x - a.x, p.y - a.y) < 10) return a.i;
      }
      return null;
    }

    function paintOverlay() {
      const ctx = overlayCtx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);
      if (state.selected) paintSelection(ctx);
      paintLights(ctx);
      if (state.axes) paintAxes(ctx);
      if (state.selected) paintGizmo(ctx);
    }

    // ---- Drawing ---------------------------------------------------------------
    function drawGrid() {
      const d = state.camera.distance;
      const u = gpu.grid.u;
      gl.useProgram(gpu.grid.prog);
      gl.bindVertexArray(gpu.grid.vao);
      gl.uniformMatrix4fv(u.uViewProj, false, cam.viewProj);
      gl.uniform1f(u.uExtent, Math.max(200, d * 20));
      gl.uniform2f(u.uCamXZ, state.camera.target[0], state.camera.target[2]);
      gl.uniform1f(u.uFade, d * 3);
      gl.uniform3fv(u.uLine, theme.rgb.muted);
      gl.uniform3fv(u.uAxisX, theme.rgb.destructive);
      gl.uniform3fv(u.uAxisZ, theme.rgb.info);
      // The grid sits on y = 0 like a floor plane, so pull it toward the camera to win the depth test.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-2, -2);
      gl.depthMask(false);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.depthMask(true);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    }

    function drawScene(w, h) {
      gl.viewport(0, 0, w, h);
      const bg = theme.rgb.bg;
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clearDepth(1);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (derived.buckets.length) {
        const u = gpu.scene.u;
        const L = derived.light;
        gl.useProgram(gpu.scene.prog);
        gl.uniformMatrix4fv(u.uViewProj, false, cam.viewProj);
        gl.uniform3fv(u.uCamPos, cam.eye);
        gl.uniform3fv(u.uAmbient, L.amb);
        gl.uniform3fv(u.uEnv, L.env);
        gl.uniform1i(u.uDirCount, L.dirCount);
        gl.uniform3fv(u.uDirDir, L.dirDir);
        gl.uniform3fv(u.uDirCol, L.dirCol);
        gl.uniform1i(u.uPointCount, L.pointCount);
        gl.uniform3fv(u.uPointPos, L.pointPos);
        gl.uniform3fv(u.uPointCol, L.pointCol);
        gl.uniform1fv(u.uPointRange, L.pointRange);
        for (const b of derived.buckets) {
          gl.bindVertexArray(b.vao);
          gl.drawElementsInstanced(gl.TRIANGLES, b.indexCount, gl.UNSIGNED_INT, 0, b.count);
        }
        gl.bindVertexArray(null);
      }
      if (state.grid) drawGrid();
    }

    function renderFrame() {
      rafId = 0;
      if (destroyed || lost) return;
      if (drag && drag.dirty) applyDrag(drag);
      if (themeDirty) readTheme();
      updateCamera();
      ensureDerived();
      drawScene(canvas.width, canvas.height);
      paintOverlay();
      flushEvents();
    }

    // User edits and camera moves coalesce to one event each per frame.
    function flushEvents() {
      if (editPending) {
        editPending = false;
        emitter.emit("change", snapshot());
      }
      if (cameraMoved) {
        cameraMoved = false;
        emitter.emit("camera", snapshot());
      }
    }

    function requestFrame() {
      if (rafId === 0 && !destroyed) rafId = requestAnimationFrame(renderFrame);
    }

    function cancelFrame() {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      rafId = 0;
    }

    // ---- State edits -----------------------------------------------------------
    function commit(map) {
      state.nodes = map;
      if (state.selected && !map.has(state.selected)) state.selected = null;
      sceneDirty = true;
      requestFrame();
    }

    function buildNodeMap(list, base) {
      const map = new Map(base ?? []);
      for (const raw of list) {
        const node = normalizeNode(raw);
        if (map.has(node.id)) fail(`duplicate node id "${node.id}"`);
        map.set(node.id, node);
      }
      validateGraph(map);
      return map;
    }

    function setSelected(id, emitEvent) {
      if (state.selected === id) return;
      state.selected = id;
      syncToolbar();
      requestFrame();
      if (emitEvent) emitter.emit("select", id);
    }

    function setMode(mode, emitEvent) {
      if (state.mode === mode) return;
      state.mode = mode;
      syncToolbar();
      requestFrame();
      if (emitEvent) emitter.emit("change", snapshot());
    }

    function toggleView(key) {
      state[key] = !state[key];
      syncToolbar();
      requestFrame();
      emitter.emit("change", snapshot());
    }

    function syncToolbar() {
      for (const key of ["move", "rotate", "scale"]) {
        if (buttons[key]) buttons[key].setAttribute("aria-pressed", String(state.mode === key));
      }
      for (const key of ["grid", "axes"]) {
        if (buttons[key]) buttons[key].setAttribute("aria-pressed", String(state[key]));
      }
    }

    function removeSelected() {
      const id = state.selected;
      if (!id) return;
      const doomed = descendantsOf(state.nodes, id);
      const next = new Map();
      for (const [k, v] of state.nodes) if (!doomed.has(k)) next.set(k, v);
      commit(next);
      setSelected(null, true);
      emitter.emit("change", snapshot());
    }

    function applyCameraPartial(c) {
      if (!c || typeof c !== "object" || Array.isArray(c)) fail("camera must be an object");
      rejectUnknown(c, KEYS.camera, "camera");
      const cam2 = state.camera;
      if (c.target !== undefined) cam2.target = vec3(c.target, cam2.target, "camera.target", false);
      if (c.azimuth !== undefined) cam2.azimuth = finite(c.azimuth, "camera.azimuth");
      if (c.elevation !== undefined)
        cam2.elevation = Math.max(-89, Math.min(89, finite(c.elevation, "camera.elevation")));
      if (c.distance !== undefined) cam2.distance = positive(c.distance, "camera.distance");
      if (c.fov !== undefined) {
        const v = finite(c.fov, "camera.fov");
        if (v <= 5 || v >= 120) fail("camera.fov must be between 5 and 120 degrees");
        cam2.fov = v;
      }
    }

    function frameNodes(id) {
      if (id && !state.nodes.has(id)) fail(`no node "${id}" to frame`);
      ensureDerived();
      const ids = id ? descendantsOf(state.nodes, id) : null;
      let min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      let found = false;
      const include = (p) => {
        found = true;
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[k]);
          max[k] = Math.max(max[k], p[k]);
        }
      };
      for (const e of derived.entries.values()) {
        if (!e.visible || (ids && !ids.has(e.id))) continue;
        if (e.node.bounds) {
          const b = e.node.bounds;
          for (let k = 0; k < 8; k++) {
            include(
              xformPoint(e.world, [
                k & 1 ? b.max[0] : b.min[0],
                k & 2 ? b.max[1] : b.min[1],
                k & 4 ? b.max[2] : b.min[2],
              ]),
            );
          }
        } else if (e.node.light) {
          include([e.world[12], e.world[13], e.world[14]]);
        }
      }
      if (!found) {
        min = [-1, -1, -1];
        max = [1, 1, 1];
      }
      const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
      state.camera.target = center;
      state.camera.distance = Math.max(
        (radius / Math.sin((state.camera.fov * DEG) / 2)) * 1.15,
        0.05,
      );
      requestFrame();
    }

    // ---- Input -----------------------------------------------------------------
    function localPoint(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function viewAlongAxis(i) {
      if (i === 0) Object.assign(state.camera, { azimuth: 90, elevation: 0 });
      else if (i === 1) state.camera.elevation = 89;
      else Object.assign(state.camera, { azimuth: 0, elevation: 0 });
    }

    function panBy(dx, dy) {
      updateCamera();
      const right = [cam.view[0], cam.view[4], cam.view[8]];
      const up = [cam.view[1], cam.view[5], cam.view[9]];
      const k = (2 * Math.tan((state.camera.fov * DEG) / 2) * state.camera.distance) / size.h;
      const t = state.camera.target;
      state.camera.target = [0, 1, 2].map((j) => t[j] + (-right[j] * dx + up[j] * dy) * k);
    }

    function applyDrag(d) {
      if (!d.dirty) return;
      d.dirty = false;
      if (d.mode === "orbit") {
        const dx = d.latest.x - d.last.x,
          dy = d.latest.y - d.last.y;
        state.camera.azimuth -= dx * 0.4;
        state.camera.elevation = Math.max(-89, Math.min(89, state.camera.elevation + dy * 0.4));
        d.last = d.latest;
        cameraMoved = true;
      } else if (d.mode === "pan") {
        panBy(d.latest.x - d.last.x, d.latest.y - d.last.y);
        d.last = d.latest;
        cameraMoved = true;
      } else if (d.mode === "gizmo") {
        updateCamera();
        if (applyGizmo(d)) editPending = true;
      } else if (d.mode === "pinch") {
        applyPinch(d);
        cameraMoved = true;
      }
    }

    function pinchState() {
      const [a, b] = [...pointers.values()];
      return {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }

    function applyPinch(d) {
      if (pointers.size < 2) return;
      const now = pinchState();
      if (d.dist > 0 && now.dist > 0)
        state.camera.distance = Math.max(0.02, (state.camera.distance * d.dist) / now.dist);
      panBy(now.mid.x - d.mid.x, now.mid.y - d.mid.y);
      d.dist = now.dist;
      d.mid = now.mid;
    }

    function selectAt(p) {
      ensureDerived();
      updateCamera();
      const id = pickLight(p.x, p.y) ?? pickMesh(p.x, p.y);
      setSelected(id, true);
    }

    function setHover(h) {
      if (hover === h) return;
      hover = h;
      canvas.style.cursor = h === null ? "" : "pointer";
      requestFrame();
    }

    function onDown(e) {
      if (destroyed || lost || e.button > 2) return;
      const p = localPoint(e);
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        const s = pinchState();
        drag = { mode: "pinch", dirty: false, dist: s.dist, mid: s.mid };
        return;
      }
      if (pointers.size > 2 || drag) return;
      ensureDerived();
      updateCamera();
      if (e.button !== 0 || e.shiftKey) {
        drag = { mode: "pan", dirty: false, last: p, latest: p, down: p, moved: 0 };
        return;
      }
      const axis = hitAxisLabel(p);
      if (axis !== null) {
        viewAlongAxis(axis);
        cameraMoved = true;
        requestFrame();
        return;
      }
      const handle = hitGizmo(p);
      if (handle !== null) {
        drag = startGizmo(handle, p);
        requestFrame();
        return;
      }
      drag = { mode: "orbit", dirty: false, last: p, latest: p, down: p, moved: 0 };
    }

    function onMove(e) {
      if (!pointers.has(e.pointerId)) {
        // Hover feedback for gizmo handles (mouse only, no buttons). Uses the last frame's camera.
        if (e.pointerType === "mouse" && !drag && !sceneDirty && cam.viewProj)
          setHover(hitGizmo(localPoint(e)));
        return;
      }
      const p = localPoint(e);
      pointers.set(e.pointerId, p);
      if (!drag) return;
      if (drag.mode === "pinch") {
        drag.dirty = true;
      } else {
        drag.latest = p;
        drag.dirty = true;
        drag.moved = Math.max(drag.moved, Math.hypot(p.x - drag.down.x, p.y - drag.down.y));
      }
      requestFrame();
    }

    function onUp(e) {
      if (!pointers.has(e.pointerId)) return;
      const p = localPoint(e);
      pointers.delete(e.pointerId);
      if (!drag) return;
      const d = drag;
      if (d.mode === "pinch") {
        drag = null;
        flushEvents();
        requestFrame();
        return;
      }
      if (p.x !== d.latest.x || p.y !== d.latest.y) {
        d.latest = p;
        d.dirty = true;
      }
      applyDrag(d);
      drag = null;
      if (d.mode === "orbit" && Math.max(d.moved, Math.hypot(p.x - d.down.x, p.y - d.down.y)) < 4) {
        cameraMoved = false;
        selectAt(p);
      }
      if (editPending) ensureDerived();
      flushEvents();
      requestFrame();
    }

    function onWheel(e) {
      if (destroyed || lost) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      zoomBy(Math.exp(dy * 0.0015));
    }

    function zoomBy(f) {
      state.camera.distance = Math.max(0.02, Math.min(5000, state.camera.distance * f));
      cameraMoved = true;
      requestFrame();
    }

    // Keyboard nudge of the selection along a world axis (converted into the parent's frame).
    function nudge(axis, amount) {
      const node = state.nodes.get(state.selected);
      ensureDerived();
      const pe = node.parent === null ? null : derived.entries.get(node.parent);
      const w = [0, 0, 0];
      w[axis] = amount;
      const local = pe ? mulVec3(invert3(rows3(pe.world)), w) : w;
      node.position = node.position.map((v, k) => v + local[k]);
      sceneDirty = true;
      editPending = true;
      requestFrame();
    }

    // Cycle the selection through mesh and light nodes in list order.
    function cycleSelection(step) {
      const ids = [...state.nodes.values()].filter((n) => n.mesh || n.light).map((n) => n.id);
      if (ids.length === 0) return;
      const at = ids.indexOf(state.selected);
      const next = at < 0 ? (step > 0 ? 0 : ids.length - 1) : (at + step + ids.length) % ids.length;
      setSelected(ids[next], true);
    }

    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const step = (state.snap.move > 0 ? state.snap.move : 0.1) * (e.shiftKey ? 10 : 1);
      const sel = state.selected;
      switch (e.key) {
        case "w":
        case "W":
          setMode("move", true);
          break;
        case "e":
        case "E":
          setMode("rotate", true);
          break;
        case "r":
        case "R":
          setMode("scale", true);
          break;
        case "g":
        case "G":
          toggleView("grid");
          break;
        case "x":
        case "X":
          toggleView("axes");
          break;
        case "f":
        case "F":
          frameNodes(sel);
          cameraMoved = true;
          break;
        case "[":
          cycleSelection(-1);
          break;
        case "]":
          cycleSelection(1);
          break;
        case "+":
        case "=":
          zoomBy(1 / 1.15);
          break;
        case "-":
        case "_":
          zoomBy(1.15);
          break;
        case "ArrowLeft":
        case "ArrowRight":
          if (sel) nudge(0, e.key === "ArrowLeft" ? -step : step);
          else {
            state.camera.azimuth += e.key === "ArrowLeft" ? 5 : -5;
            cameraMoved = true;
          }
          break;
        case "ArrowUp":
        case "ArrowDown":
          if (sel) nudge(2, e.key === "ArrowUp" ? -step : step);
          else {
            state.camera.elevation = Math.max(
              -89,
              Math.min(89, state.camera.elevation + (e.key === "ArrowUp" ? 5 : -5)),
            );
            cameraMoved = true;
          }
          break;
        case "PageUp":
        case "PageDown":
          if (sel) nudge(1, e.key === "PageUp" ? step : -step);
          break;
        case "Escape":
          setSelected(null, true);
          break;
        case "Delete":
        case "Backspace":
          removeSelected();
          break;
        default:
          return;
      }
      e.preventDefault();
      requestFrame();
    }

    canvas.addEventListener("pointerdown", onDown, { signal });
    canvas.addEventListener("pointermove", onMove, { signal });
    canvas.addEventListener("pointerup", onUp, { signal });
    canvas.addEventListener("pointercancel", onUp, { signal });
    canvas.addEventListener("pointerleave", () => setHover(null), { signal });
    canvas.addEventListener("wheel", onWheel, { passive: false, signal });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
    canvas.addEventListener("keydown", onKey, { signal });
    canvas.addEventListener(
      "webglcontextlost",
      (e) => {
        e.preventDefault();
        lost = true;
        cancelFrame();
      },
      { signal },
    );
    canvas.addEventListener(
      "webglcontextrestored",
      () => {
        lost = false;
        initGL();
        sceneDirty = true;
        requestFrame();
      },
      { signal },
    );

    // ---- Size and theme observers ----------------------------------------------
    function resize() {
      const w = root.clientWidth,
        h = root.clientHeight;
      if (w < 1 || h < 1) return;
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      size.w = w;
      size.h = h;
      const bw = Math.round(w * dpr),
        bh = Math.round(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
        overlay.width = bw;
        overlay.height = bh;
      }
      requestFrame();
    }
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(root);

    const onTheme = () => {
      themeDirty = true;
      colourCache.clear();
      sceneDirty = true;
      requestFrame();
    };
    const themeObserver = new MutationObserver(onTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme"],
    });
    themeObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", onTheme, { signal });

    // ---- Public instance ---------------------------------------------------------
    function alive() {
      if (destroyed) fail("instance was destroyed");
    }

    function snapshot() {
      const c = state.camera;
      return {
        nodes: [...state.nodes.values()].map(serializeNode),
        selected: state.selected,
        mode: state.mode,
        snap: { ...state.snap },
        camera: {
          target: c.target.slice(),
          azimuth: c.azimuth,
          elevation: c.elevation,
          distance: c.distance,
          fov: c.fov,
        },
        grid: state.grid,
        axes: state.axes,
      };
    }

    function applySnap(raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        fail("snap must be an object {move, rotate}");
      rejectUnknown(raw, KEYS.snap, "snap");
      const next = { ...state.snap };
      for (const key of KEYS.snap) {
        if (raw[key] === undefined) continue;
        if (finite(raw[key], `snap.${key}`) < 0) fail(`snap.${key} must be 0 or more`);
        next[key] = raw[key];
      }
      state.snap = next;
    }

    // Shared by create(options) and set(): validates everything before it changes anything visible.
    function applyPartial(partial, what) {
      if (!partial || typeof partial !== "object" || Array.isArray(partial))
        fail(`${what} needs an object`);
      if (partial.nodes !== undefined) {
        if (!Array.isArray(partial.nodes)) fail("nodes must be an array");
        commit(buildNodeMap(partial.nodes, null));
      }
      if (partial.selected !== undefined) {
        if (partial.selected !== null && !state.nodes.has(partial.selected))
          fail(`no node "${partial.selected}" to select`);
        state.selected = partial.selected;
      }
      if (partial.mode !== undefined) {
        if (!MODES.includes(partial.mode)) fail("mode must be move, rotate or scale");
        state.mode = partial.mode;
      }
      if (partial.snap !== undefined) applySnap(partial.snap);
      if (partial.camera !== undefined) applyCameraPartial(partial.camera);
      if (partial.grid !== undefined) state.grid = bool(partial.grid, "grid");
      if (partial.axes !== undefined) state.axes = bool(partial.axes, "axes");
      syncToolbar();
      requestFrame();
    }

    function existing(id, what) {
      if (typeof id !== "string" || !state.nodes.has(id)) fail(`${what}: no node "${id}"`);
      return state.nodes.get(id);
    }

    function nextId(base) {
      let id;
      do id = `${base}-${++idSeq}`;
      while (state.nodes.has(id));
      return id;
    }

    // Replaces one node, keeping list order. The graph is re-validated before the commit.
    function replaceNode(node) {
      const map = new Map(state.nodes);
      map.set(node.id, node);
      validateGraph(map);
      commit(map);
    }

    const inst = {
      get() {
        alive();
        return snapshot();
      },
      set(partial) {
        alive();
        if (partial && typeof partial === "object" && !Array.isArray(partial))
          rejectUnknown(partial, KEYS.set, "set()");
        applyPartial(partial, "set()");
      },
      add(raw) {
        alive();
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          fail("add() needs a node object");
        const spec = { ...raw };
        if (spec.id === undefined)
          spec.id = nextId(spec.mesh ? spec.mesh.shape : spec.light ? spec.light.type : "group");
        const node = normalizeNode(spec);
        if (state.nodes.has(node.id)) fail(`duplicate node id "${node.id}"`);
        replaceNode(node);
        return node.id;
      },
      update(id, partial) {
        alive();
        const old = existing(id, "update()");
        if (!partial || typeof partial !== "object" || Array.isArray(partial))
          fail("update() needs an object");
        if (partial.id !== undefined && partial.id !== id) fail("update() cannot change a node id");
        const raw = serializeNode(old);
        for (const [key, value] of Object.entries(partial)) {
          if (!KEYS.node.includes(key)) fail(`node has unknown key "${key}"`);
          if (value === null && key !== "parent") delete raw[key];
          else if (
            (key === "material" || key === "light") &&
            raw[key] &&
            value &&
            typeof value === "object"
          ) {
            raw[key] = { ...raw[key], ...value };
          } else raw[key] = value;
        }
        if (raw.material !== undefined && raw.mesh === undefined) delete raw.material;
        replaceNode(normalizeNode(raw));
      },
      remove(id) {
        alive();
        existing(id, "remove()");
        const doomed = descendantsOf(state.nodes, id);
        const next = new Map();
        for (const [k, v] of state.nodes) if (!doomed.has(k)) next.set(k, v);
        commit(next);
      },
      async load(blob, loadOpts) {
        alive();
        if (!(blob instanceof Blob)) fail("load() needs a Blob or File");
        const o = loadOpts ?? {};
        rejectUnknown(o, ["parent", "name"], "load() options");
        if (o.parent !== undefined && o.parent !== null && !state.nodes.has(o.parent))
          fail(`no parent node "${o.parent}"`);
        if (o.name !== undefined && typeof o.name !== "string")
          fail("load() name must be a string");
        const bytes = await blob.arrayBuffer();
        alive();
        const { json, buffers } = parseGltf(bytes);
        const name =
          o.name ?? (typeof blob.name === "string" && blob.name ? blob.name : "glTF import");
        const list = gltfNodes(json, buffers, `gltf${++loadSeq}:`, o.parent ?? null, name);
        commit(buildNodeMap(list, state.nodes));
        return list[0].id;
      },
      frame(id) {
        alive();
        frameNodes(id === undefined ? state.selected : id);
      },
      async exportBlob(exportOpts) {
        alive();
        if (lost) fail("WebGL context is lost");
        const o = exportOpts ?? {};
        rejectUnknown(o, ["type", "quality", "width", "height"], "exportBlob() options");
        const type = o.type ?? "image/png";
        if (typeof type !== "string" || !type.startsWith("image/"))
          fail("exportBlob type must be an image/* string");
        if (o.quality !== undefined) unit(o.quality, "exportBlob quality");
        const w = o.width ?? canvas.width,
          h = o.height ?? canvas.height;
        positive(w, "exportBlob width");
        positive(h, "exportBlob height");
        const max = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
        if (w > max || h > max) fail(`export size exceeds ${max}px`);
        if (themeDirty) readTheme();
        ensureDerived();
        updateCamera(w / h);
        const prevW = canvas.width,
          prevH = canvas.height;
        canvas.width = Math.round(w);
        canvas.height = Math.round(h);
        drawScene(canvas.width, canvas.height);
        // Copy the drawing buffer synchronously, before the canvas is restored.
        const blob = new Promise((resolve, reject) => {
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("scene3d: toBlob returned no data"))),
            type,
            o.quality,
          );
        });
        canvas.width = prevW;
        canvas.height = prevH;
        updateCamera();
        requestFrame();
        return blob;
      },
      on(name, cb) {
        alive();
        return emitter.on(name, cb);
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        cancelFrame();
        controller.abort();
        resizeObserver.disconnect();
        themeObserver.disconnect();
        const lose = gl.getExtension("WEBGL_lose_context");
        if (lose && !lost) lose.loseContext();
        root.remove();
      },
    };

    // Initial state
    initGL();
    readTheme();
    const initial = { ...opts };
    delete initial.controls;
    delete initial.defaultLights;
    applyPartial(initial, "create() options");
    if (opts.camera === undefined) frameNodes(null);
    syncToolbar();
    resize();
    requestFrame();
    return inst;
  }

  t3kit.scene3d = { create };
})();
