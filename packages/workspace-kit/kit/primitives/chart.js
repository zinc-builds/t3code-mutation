/**
 * t3kit.chart: canvas chart for tabular data (line, area, bar, scatter, histogram) with column mappings, axes,
 * legend toggles, tooltips, x-range brushing that emits a filter, and PNG/SVG export. Colours: --chart-1..6.
 *
 * create(container, options) -> instance     fills container; every option can change later with set()
 *   type       'line' | 'area' | 'bar' | 'scatter' | 'histogram'                                default 'line'
 *   x          column (required): number, time or category (category x: bar, line, area only)
 *   y          column or array of columns; omit to count rows. Scatter needs exactly one
 *   series     column: one line or bar group per distinct value;   color  column: colour per value (with series)
 *   aggregate  'count' | 'sum' | 'mean' | 'min' | 'max' | 'none'. Default count without y, else bar and histogram
 *              sum, line and area mean. 'none' draws raw line points, decimated per pixel. Not for scatter
 *   bins       integer 1..200, or 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' for a time x,
 *              or 'auto' (time x: the finest unit that keeps the span at about 100 bins). Default: histogram
 *              Sturges; bar, line, area use distinct x values up to 40 (bar) or 240, else that many bins
 *   stacked    boolean: stack bar, histogram and area groups. Default true for histogram, else false
 *   categories 'natural' (default) sorts category values; 'data' keeps their first-appearance order (a SQL ORDER BY)
 *   legend, axes, tooltips   booleans, default true;   hidden: legend labels to hide (see get().groups)
 *   brush      { min, max } (epoch ms for time x) | { values: [...] } for a category x | null
 *   rows       row indices to draw (a linked view, e.g. a grid's filtered rows) or null = all; bins, categories
 *              and colours stay those of the full data. setData resets it. get().shownRows = rows drawn
 *
 * instance.setData(source) -> Promise<{ columns, rowCount } | null>   source: CSV File/Blob, CSV text, an array of
 *   row objects, or null to clear. columns: [{ name, kind: 'number' | 'time' | 'category', min, max | distinct }].
 *   Time = ISO date or datetime, local. Clears the brush. Resolves null when a newer setData superseded it.
 * instance.get() -> { ...options with effective aggregate and stacked, groups, hasData, rowCount, shownRows, columns }
 * instance.set(partial)   validated as a whole; errors name the valid columns or values. Never emits.
 * instance.exportBlob({ type: 'image/png' | 'image/svg+xml', scale = 2 }) -> Promise<Blob>   includes the legend
 * instance.on(event, cb) -> unsubscribe     instance.destroy()
 *   'change'  user brushed, cleared or toggled a legend item; payload get()
 *   'filter'  user brushed: { column, kind, min, max, count } or { column, kind: 'category', values, count }, null
 *             when cleared. count = rows whose x is inside. Marks outside the brush are dimmed.
 *
 * Mouse: hover for a tooltip, drag across the plot to brush (bars and histograms snap to whole bins), click to
 * clear. Keyboard on the focused plot: arrows move the cursor, Shift+arrows brush, PageUp/PageDown jump 10,
 * Home/End, Escape clears. Legend items are buttons that hide or show a group.
 * Example:
 *   const c = t3kit.chart.create(el, { type: 'bar', x: 'city', y: 'fare_usd', aggregate: 'mean', series: 'member' });
 *   await c.setData(csvFile);                                      // File/Blob from t3.workspace.assets()
 *   c.on('filter', (f) => console.log(f ? `${f.count} rows` : 'cleared'));
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});

  const TYPES = ["line", "area", "bar", "scatter", "histogram"];
  const AGGREGATES = ["count", "sum", "mean", "min", "max", "none"];
  const UNITS = ["second", "minute", "hour", "day", "week", "month", "year"];
  const AUTO_BINS = "auto";
  const AUTO_TARGET = 100;
  const UNIT_MS = {
    second: 1e3,
    minute: 6e4,
    hour: 36e5,
    day: 864e5,
    week: 6048e5,
    month: 2629800e3,
    year: 31557600e3,
  };
  const STACKABLE = ["bar", "histogram", "area"];
  const DEFAULTS = {
    type: "line",
    x: null,
    y: null,
    series: null,
    color: null,
    aggregate: null,
    bins: null,
    stacked: null,
    categories: "natural",
    legend: true,
    axes: true,
    tooltips: true,
  };
  const CONFIG_KEYS = Object.keys(DEFAULTS);
  const SETTINGS = [...CONFIG_KEYS, "brush", "hidden", "rows"];
  const STRUCTURAL = ["type", "x", "y", "series", "color", "aggregate", "bins", "categories"];
  const CATEGORY_ORDERS = ["natural", "data"];
  const EVENTS = ["change", "filter"];
  const EXPORT_TYPES = ["image/png", "image/svg+xml"];
  const CHART_VARS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6"];
  const THEME_TOKENS = [
    "--background",
    "--foreground",
    "--muted-foreground",
    "--border",
    "--card",
    "--card-foreground",
    "--ring",
    "--font-sans",
    ...CHART_VARS,
  ];
  const LINE_BINS = 240;
  const BAR_BINS = 40;
  const DOT_LIMIT = 60;
  const MAX_GROUPS = 64;
  const MAX_BINS = 5000;
  const MAX_DPR = 2;
  const LEGEND_ROW = 22;
  const FONT = 11;
  const SEC = 1e3;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const ISO =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;
  const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const NUM_SIG = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });
  const NUM_INT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const dtf = (o) => new Intl.DateTimeFormat(undefined, o);
  const FULL_TIME = dtf({ dateStyle: "medium", timeStyle: "short" });
  const FULL_DATE = dtf({ dateStyle: "medium" });
  const TICK_FMT = {
    time: dtf({ hour: "2-digit", minute: "2-digit" }),
    daytime: dtf({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    day: dtf({ month: "short", day: "numeric" }),
    month: dtf({ month: "short" }),
    monthYear: dtf({ month: "short", year: "numeric" }),
    year: dtf({ year: "numeric" }),
  };
  const BIN_FMT = {
    second: dtf({ hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    minute: dtf({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    hour: dtf({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    day: FULL_DATE,
    week: FULL_DATE,
    month: dtf({ month: "long", year: "numeric" }),
    year: TICK_FMT.year,
  };
  const MEASURE = document.createElement("canvas").getContext("2d");
  const CSS = `
.t3k-chart-root{display:flex;flex-direction:column;gap:2px;box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;font:12px/1.4 var(--font-sans);color:var(--muted-foreground);}
.t3k-chart-legend{display:flex;flex-wrap:wrap;flex:none;gap:0 2px;}
.t3k-chart-legend[hidden]{display:none;}
.t3k-chart-plot{position:relative;flex:1 1 auto;min-width:0;min-height:0;}
.t3k-chart-base,.t3k-chart-over{position:absolute;inset:0;display:block;width:100%;height:100%;}
.t3k-chart-over{cursor:crosshair;touch-action:none;}
.t3k-chart-over:focus-visible{outline:2px solid var(--ring);outline-offset:-2px;}
.t3k-chart-root .t3k-chart-item{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 6px;border:0;border-radius:calc(var(--radius) - 4px);background:transparent;color:var(--foreground);font:inherit;font-size:12px;cursor:pointer;}
.t3k-chart-item:hover{background:color-mix(in srgb, var(--foreground) 8%, transparent);}
.t3k-chart-item[aria-pressed="false"]{color:var(--muted-foreground);text-decoration:line-through;}
.t3k-chart-item[aria-pressed="false"] .t3k-chart-sw{opacity:.35;}
.t3k-chart-item:focus-visible{outline:2px solid var(--ring);outline-offset:-1px;}
.t3k-chart-sw{display:inline-block;flex:none;width:10px;height:10px;border-radius:2px;}
`;

  // ---------- Shared theme hub: one observer for every instance ----------
  const instances = new Set();
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  let theme = null;
  let themeKey = "";
  let observer = null;

  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const token of THEME_TOKENS) {
      const value = cs.getPropertyValue(token).trim();
      if (!value)
        fail(`theme token ${token} is not defined; load tools/theme.css or run inside T3`);
      out[token] = value;
    }
    return out;
  }

  function refreshTheme() {
    const next = readTheme();
    const key = JSON.stringify(next);
    if (key === themeKey) return;
    themeKey = key;
    theme = next;
    for (const inst of instances) inst.repaint();
  }

  function startHub() {
    observer = new MutationObserver(refreshTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    scheme.addEventListener("change", refreshTheme);
    refreshTheme();
  }

  function stopHub() {
    observer.disconnect();
    observer = null;
    scheme.removeEventListener("change", refreshTheme);
    theme = null;
    themeKey = "";
  }

  function injectStyle() {
    if (document.querySelector('style[data-t3kit="chart"]')) return;
    const style = document.createElement("style");
    style.dataset.t3kit = "chart";
    style.textContent = CSS;
    document.head.append(style);
  }

  // ---------- Small helpers ----------
  function fail(message) {
    throw new Error(`t3kit.chart: ${message}`);
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const el = (tag, className) => {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  };
  const fontOf = (size, weight, family) => `${weight} ${size}px ${family}`;
  const quoteList = (names) => names.map((n) => `"${n}"`).join(", ");

  function measureText(text, size, weight, family) {
    MEASURE.font = fontOf(size, weight, family);
    return MEASURE.measureText(text).width;
  }

  function fmtValue(v) {
    if (!Number.isFinite(v)) return "–";
    return Math.abs(v) >= 1000 ? NUM_INT.format(v) : NUM_SIG.format(v);
  }

  function fmtAxis(v, step) {
    const digits = clamp(-Math.floor(Math.log10(step) + 1e-9), 0, 6);
    return v.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function fmtTime(v) {
    const d = new Date(v);
    return d.getHours() || d.getMinutes() || d.getSeconds()
      ? FULL_TIME.format(v)
      : FULL_DATE.format(v);
  }

  function fmtX(model, v) {
    if (model.labels) return model.labels[Math.round(v)] ?? "";
    return model.xKind === "time" ? fmtTime(v) : fmtValue(v);
  }

  function binLabel(model, k) {
    const b = model.bins;
    if (b.mode === "category") return b.labels[k];
    if (b.mode === "distinct") return fmtX(model, b.pos[k]);
    if (b.mode === "width") {
      const edge = (v) =>
        model.xKind === "time"
          ? (b.step >= DAY ? FULL_DATE : FULL_TIME).format(v)
          : fmtAxis(v, b.step / 10);
      return `${edge(b.lo[k])} – ${edge(b.hi[k])}`;
    }
    const text = BIN_FMT[b.mode].format(b.lo[k]);
    return b.mode === "week" ? `Week of ${text}` : text;
  }

  function lowerBound(arr, v) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function nearestIndex(arr, v) {
    if (arr.length === 0) return -1;
    const i = Math.min(lowerBound(arr, v), arr.length - 1);
    if (i > 0 && Math.abs(arr[i - 1] - v) <= Math.abs(arr[i] - v)) return i - 1;
    return i;
  }

  // ---------- Ticks ----------
  function niceTicks(lo, hi, count) {
    if (!(hi > lo)) {
      const pad = Math.abs(lo) * 0.1 || 1;
      lo -= pad;
      hi += pad;
    }
    const raw = (hi - lo) / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const f = raw / mag;
    const step = (f >= 7.5 ? 10 : f >= 3.5 ? 5 : f >= 1.5 ? 2 : 1) * mag;
    const k0 = Math.floor(lo / step + 1e-9);
    const k1 = Math.ceil(hi / step - 1e-9);
    const ticks = [];
    for (let k = k0; k <= k1; k++) ticks.push(k * step);
    return { lo: k0 * step, hi: k1 * step, ticks, step };
  }

  const CALENDAR = [
    { unit: "day", n: 1, ms: DAY },
    { unit: "day", n: 2, ms: 2 * DAY },
    { unit: "day", n: 7, ms: 7 * DAY },
    { unit: "day", n: 14, ms: 14 * DAY },
    { unit: "month", n: 1, ms: 30.44 * DAY },
    { unit: "month", n: 3, ms: 91.3 * DAY },
    { unit: "month", n: 6, ms: 182.6 * DAY },
    { unit: "year", n: 1, ms: 365.25 * DAY },
    { unit: "year", n: 2, ms: 730.5 * DAY },
    { unit: "year", n: 5, ms: 1826 * DAY },
    { unit: "year", n: 10, ms: 3652 * DAY },
  ];
  const FIXED = [
    SEC,
    5 * SEC,
    15 * SEC,
    30 * SEC,
    MIN,
    5 * MIN,
    15 * MIN,
    30 * MIN,
    HOUR,
    3 * HOUR,
    6 * HOUR,
    12 * HOUR,
  ].map((ms) => ({ unit: "ms", n: ms, ms }));

  function calendarTicks(lo, hi, step) {
    const values = [];
    const d = new Date(lo);
    d.setHours(0, 0, 0, 0);
    if (step.unit === "month") d.setMonth(Math.floor(d.getMonth() / step.n) * step.n, 1);
    if (step.unit === "year") d.setFullYear(Math.floor(d.getFullYear() / step.n) * step.n, 0, 1);
    const advance = () => {
      if (step.unit === "day") d.setDate(d.getDate() + step.n);
      else if (step.unit === "month") d.setMonth(d.getMonth() + step.n);
      else d.setFullYear(d.getFullYear() + step.n);
    };
    while (d.getTime() < lo) advance();
    while (d.getTime() <= hi && values.length < 200) {
      values.push(d.getTime());
      advance();
    }
    return values;
  }

  // The smallest step that fits maxTicks labels, with at least two ticks in range.
  function timeTicks(lo, hi, maxTicks) {
    let step = null;
    let values = [];
    for (const cand of [...FIXED, ...CALENDAR]) {
      let found;
      if (cand.unit === "ms") {
        found = [];
        for (let t = Math.ceil(lo / cand.ms) * cand.ms; t <= hi && found.length < 200; t += cand.ms)
          found.push(t);
      } else {
        found = calendarTicks(lo, hi, cand);
      }
      if (found.length >= 2) {
        step = cand;
        values = found;
      }
      if (step && (hi - lo) / cand.ms <= maxTicks) break;
    }
    if (!step) return [];
    if (step.unit === "month") {
      return values.map((v, i) => {
        const d = new Date(v);
        return {
          pos: v,
          label: (i === 0 || d.getMonth() === 0 ? TICK_FMT.monthYear : TICK_FMT.month).format(v),
        };
      });
    }
    let fmt = TICK_FMT.year;
    if (step.unit === "ms") fmt = hi - lo > 2 * DAY ? TICK_FMT.daytime : TICK_FMT.time;
    else if (step.unit === "day") fmt = TICK_FMT.day;
    return values.map((v) => ({ pos: v, label: fmt.format(v) }));
  }

  // Drops ticks whose labels would collide.
  function thinTicks(ticks, X, family) {
    const kept = [];
    let lastRight = -Infinity;
    for (const t of ticks) {
      const x = X(t.pos);
      const half = measureText(t.label, FONT, 400, family) / 2;
      if (x - half < lastRight + 10) continue;
      kept.push(t);
      lastRight = x + half;
    }
    return kept;
  }

  // ---------- CSV and typed columns ----------
  const isDelimiter = (c) => c === 44 || c === 10 || c === 13;

  function parseCsv(text) {
    const records = [];
    const n = text.length;
    let row = [];
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (i < n) {
      let value;
      if (text.charCodeAt(i) === 34) {
        let buf = "";
        let j = i + 1;
        for (;;) {
          const q = text.indexOf('"', j);
          if (q < 0) {
            buf += text.slice(j);
            j = n;
            break;
          }
          buf += text.slice(j, q);
          if (text.charCodeAt(q + 1) === 34) {
            buf += '"';
            j = q + 2;
          } else {
            j = q + 1;
            break;
          }
        }
        value = buf;
        while (j < n && !isDelimiter(text.charCodeAt(j))) j++;
        i = j;
      } else {
        let j = i;
        while (j < n && !isDelimiter(text.charCodeAt(j))) j++;
        value = text.slice(i, j);
        i = j;
      }
      row.push(value.trim());
      if (text.charCodeAt(i) === 44) {
        i++;
        if (i === n) row.push("");
        continue;
      }
      if (text.charCodeAt(i) === 13) i++;
      if (text.charCodeAt(i) === 10) i++;
      if (row.length > 1 || row[0] !== "") records.push(row);
      row = [];
    }
    if (row.length > 1 || (row.length === 1 && row[0] !== "")) records.push(row);
    return { names: records[0] ?? [], rows: records.slice(1) };
  }

  const pad2 = (v) => String(v).padStart(2, "0");

  function cellOf(v) {
    if (v === null || v === undefined) return "";
    if (v instanceof Date)
      return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())} ${pad2(v.getHours())}:${pad2(v.getMinutes())}:${pad2(v.getSeconds())}`;
    return String(v).trim();
  }

  function fromObjects(objects) {
    const names = [];
    const seen = new Set();
    for (const obj of objects) {
      if (!obj || typeof obj !== "object") fail("setData row arrays must contain plain objects");
      for (const key of Object.keys(obj)) {
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(key);
      }
    }
    return { names, rows: objects.map((obj) => names.map((key) => cellOf(obj[key]))) };
  }

  async function readSource(source) {
    if (typeof source === "string") return parseCsv(source);
    if (source instanceof Blob) return parseCsv(await source.text());
    if (Array.isArray(source)) return fromObjects(source);
    return fail("setData takes a CSV File/Blob, CSV text, an array of row objects, or null");
  }

  function isoMs(text) {
    const m = ISO.exec(text);
    if (!m) return NaN;
    if (m[8]) return Date.parse(text.replace(" ", "T"));
    const ms = m[7] ? Math.round(Number(m[7]) * 1000) : 0;
    return new Date(
      +m[1],
      +m[2] - 1,
      +m[3],
      +(m[4] ?? 0),
      +(m[5] ?? 0),
      +(m[6] ?? 0),
      ms,
    ).getTime();
  }

  function columnFrom(name, rows, j, n, categories) {
    let numeric = true;
    let temporal = true;
    let any = false;
    for (let i = 0; i < n; i++) {
      const v = rows[i][j] ?? "";
      if (v === "") continue;
      any = true;
      if (numeric && !Number.isFinite(Number(v))) numeric = false;
      if (temporal && !ISO.test(v)) temporal = false;
      if (!numeric && !temporal) break;
    }
    if (any && (numeric || temporal)) {
      const num = new Float64Array(n);
      let min = Infinity;
      let max = -Infinity;
      let valid = 0;
      for (let i = 0; i < n; i++) {
        const v = rows[i][j] ?? "";
        const x = v === "" ? NaN : numeric ? Number(v) : isoMs(v);
        num[i] = x;
        if (x !== x) continue;
        valid++;
        if (x < min) min = x;
        if (x > max) max = x;
      }
      return {
        name,
        kind: numeric ? "number" : "time",
        num,
        codes: null,
        labels: null,
        min,
        max,
        valid,
      };
    }
    // Category: codes index labels sorted naturally, so bars and legends read in a stable order, or in the order
    // the data lists them (categories: 'data').
    const index = new Map();
    const first = [];
    const codes = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const v = rows[i][j] ?? "";
      if (v === "") {
        codes[i] = -1;
        continue;
      }
      let c = index.get(v);
      if (c === undefined) {
        c = first.length;
        index.set(v, c);
        first.push(v);
      }
      codes[i] = c;
    }
    const order = first.map((_, k) => k);
    if (categories !== "data") order.sort((a, b) => COLLATOR.compare(first[a], first[b]));
    const remap = new Int32Array(first.length);
    order.forEach((old, k) => {
      remap[old] = k;
    });
    for (let i = 0; i < n; i++) if (codes[i] >= 0) codes[i] = remap[codes[i]];
    return {
      name,
      kind: "category",
      num: null,
      codes,
      labels: order.map((k) => first[k]),
      min: NaN,
      max: NaN,
      valid: n,
    };
  }

  function tableFrom(names, rows, categories) {
    const n = rows.length;
    const columns = names.map((name, j) => columnFrom(name, rows, j, n, categories));
    const byName = new Map();
    for (const col of columns) {
      if (byName.has(col.name)) fail(`duplicate column "${col.name}"`);
      byName.set(col.name, col);
    }
    return { n, columns, byName };
  }

  function describeColumn(c) {
    if (c.kind === "category") return { name: c.name, kind: c.kind, distinct: c.labels.length };
    return { name: c.name, kind: c.kind, min: c.valid ? c.min : null, max: c.valid ? c.max : null };
  }

  function need(table, name, role) {
    const col = table.byName.get(name);
    if (!col)
      fail(`no column "${name}" for ${role}; columns are ${quoteList([...table.byName.keys()])}`);
    return col;
  }

  // Group keys for any column: integer codes (-1 when missing) and one label per code.
  function keysOf(col) {
    if (col.keys) return col.keys;
    if (col.kind === "category") {
      col.keys = { codes: col.codes, labels: col.labels };
      return col.keys;
    }
    const values = [...new Set(col.num)].filter((v) => v === v).sort((a, b) => a - b);
    if (values.length > MAX_GROUPS) {
      col.keys = { codes: null, labels: values };
      return col.keys;
    }
    const index = new Map(values.map((v, k) => [v, k]));
    const codes = new Int32Array(col.num.length);
    for (let i = 0; i < codes.length; i++)
      codes[i] = col.num[i] === col.num[i] ? index.get(col.num[i]) : -1;
    col.keys = {
      codes,
      labels: values.map((v) => (col.kind === "time" ? fmtTime(v) : fmtValue(v))),
    };
    return col.keys;
  }

  // Row indexes sorted by x, cached per column: raw lines fill each series in order without sorting.
  function orderOf(col) {
    if (col.order) return col.order;
    const xv = col.num;
    const idx = [];
    for (let i = 0; i < xv.length; i++) if (xv[i] === xv[i]) idx.push(i);
    idx.sort((a, b) => xv[a] - xv[b]);
    col.order = Uint32Array.from(idx);
    return col.order;
  }

  // ---------- Bins: every aggregated chart maps rows to bins with centre, low and high edges ----------
  function emptyBins(mode) {
    const z = new Float64Array(0);
    return { mode, count: 0, pos: z, lo: z, hi: z, rowBin: null, step: 1, labels: null };
  }

  function categoryBins(col) {
    const n = col.labels.length;
    return {
      mode: "category",
      count: n,
      pos: Float64Array.from({ length: n }, (_, k) => k),
      lo: Float64Array.from({ length: n }, (_, k) => k - 0.5),
      hi: Float64Array.from({ length: n }, (_, k) => k + 0.5),
      rowBin: col.codes,
      step: 1,
      labels: col.labels,
    };
  }

  function distinctValues(col, cap) {
    const seen = new Set();
    for (const v of col.num) {
      if (v !== v) continue;
      seen.add(v);
      if (seen.size > cap) return null;
    }
    return [...seen].sort((a, b) => a - b);
  }

  function distinctBins(col, values) {
    const n = values.length;
    let gap = Infinity;
    for (let k = 1; k < n; k++) gap = Math.min(gap, values[k] - values[k - 1]);
    if (!Number.isFinite(gap)) gap = col.kind === "time" ? DAY : 1;
    const index = new Map(values.map((v, k) => [v, k]));
    const rowBin = new Int32Array(col.num.length);
    for (let i = 0; i < rowBin.length; i++)
      rowBin[i] = col.num[i] === col.num[i] ? index.get(col.num[i]) : -1;
    return {
      mode: "distinct",
      count: n,
      pos: Float64Array.from(values),
      lo: Float64Array.from(values, (v) => v - gap / 2),
      hi: Float64Array.from(values, (v) => v + gap / 2),
      rowBin,
      step: gap,
      labels: null,
    };
  }

  function widthBins(col, count) {
    if (col.valid === 0) return emptyBins("width");
    let lo = col.min;
    let hi = col.max;
    if (!(hi > lo)) {
      const pad = col.kind === "time" ? 12 * HOUR : 0.5;
      lo -= pad;
      hi += pad;
    }
    const w = (hi - lo) / count;
    const rowBin = new Int32Array(col.num.length);
    for (let i = 0; i < rowBin.length; i++) {
      const v = col.num[i];
      rowBin[i] = v === v ? clamp(Math.floor((v - lo) / w), 0, count - 1) : -1;
    }
    return {
      mode: "width",
      count,
      pos: Float64Array.from({ length: count }, (_, k) => lo + (k + 0.5) * w),
      lo: Float64Array.from({ length: count }, (_, k) => lo + k * w),
      hi: Float64Array.from({ length: count }, (_, k) => lo + (k + 1) * w),
      rowBin,
      step: w,
      labels: null,
    };
  }

  function floorUnit(t, unit) {
    const d = new Date(t);
    if (unit === "second") d.setMilliseconds(0);
    else if (unit === "minute") d.setSeconds(0, 0);
    else if (unit === "hour") d.setMinutes(0, 0, 0);
    else {
      d.setHours(0, 0, 0, 0);
      if (unit === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      else if (unit === "month") d.setDate(1);
      else if (unit === "year") d.setMonth(0, 1);
    }
    return d.getTime();
  }

  function nextUnit(t, unit) {
    const d = new Date(t);
    if (unit === "second") d.setSeconds(d.getSeconds() + 1);
    else if (unit === "minute") d.setMinutes(d.getMinutes() + 1);
    else if (unit === "hour") d.setHours(d.getHours() + 1);
    else if (unit === "day") d.setDate(d.getDate() + 1);
    else if (unit === "week") d.setDate(d.getDate() + 7);
    else if (unit === "month") d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
    return d.getTime();
  }

  function unitBins(col, unit) {
    if (col.kind !== "time")
      fail(`bins "${unit}" needs a time x; "${col.name}" is a ${col.kind} column`);
    if (col.valid === 0) return emptyBins(unit);
    const edges = [];
    let t = floorUnit(col.min, unit);
    while (t <= col.max) {
      edges.push(t);
      t = nextUnit(t, unit);
      if (edges.length > MAX_BINS)
        fail(
          `bins "${unit}" makes more than ${MAX_BINS} bins for "${col.name}"; use a larger unit`,
        );
    }
    edges.push(t);
    const count = edges.length - 1;
    const rowBin = new Int32Array(col.num.length);
    for (let i = 0; i < rowBin.length; i++) {
      const v = col.num[i];
      if (v !== v) rowBin[i] = -1;
      else {
        const k = lowerBound(edges, v);
        rowBin[i] = clamp(edges[k] === v ? k : k - 1, 0, count - 1);
      }
    }
    const lo = Float64Array.from(edges.slice(0, count));
    const hi = Float64Array.from(edges.slice(1));
    return {
      mode: unit,
      count,
      pos: lo.map((v, k) => (v + hi[k]) / 2),
      lo,
      hi,
      rowBin,
      step: (edges[count] - edges[0]) / count,
      labels: null,
    };
  }

  // The finest unit whose bin count over the column's span stays at or under AUTO_TARGET.
  function autoUnit(col) {
    const span = Math.max(0, col.max - col.min);
    for (const unit of UNITS) if (span / UNIT_MS[unit] <= AUTO_TARGET) return unit;
    return "year";
  }

  function binsFor(col, cfg) {
    if (col.kind === "category") return categoryBins(col);
    if (cfg.bins === AUTO_BINS)
      return unitBins(col, col.kind === "time" ? autoUnit(col) : AUTO_BINS);
    if (typeof cfg.bins === "string") return unitBins(col, cfg.bins);
    if (cfg.type === "histogram")
      return widthBins(
        col,
        cfg.bins ?? clamp(Math.ceil(Math.log2(Math.max(col.valid, 1)) + 1), 1, 200),
      );
    if (cfg.bins !== null) return widthBins(col, cfg.bins);
    const cap = cfg.type === "bar" ? BAR_BINS : LINE_BINS;
    const values = distinctValues(col, cap);
    return values ? distinctBins(col, values) : widthBins(col, cap);
  }

  // ---------- Settings ----------
  const yList = (cfg) => (cfg.y === null ? [] : [].concat(cfg.y));

  function effAggregate(cfg) {
    if (cfg.type === "scatter") return "none";
    if (yList(cfg).length === 0) return "count";
    if (cfg.aggregate !== null) return cfg.aggregate;
    return cfg.type === "bar" || cfg.type === "histogram" ? "sum" : "mean";
  }

  const effStacked = (cfg) =>
    STACKABLE.includes(cfg.type) && (cfg.stacked ?? cfg.type === "histogram");

  function normaliseConfig(c) {
    if (!TYPES.includes(c.type)) fail(`type must be one of ${TYPES.join(", ")}; got "${c.type}"`);
    if (typeof c.x !== "string" || c.x === "")
      fail(`${c.type} needs x: the column for the horizontal axis`);
    for (const key of ["series", "color"]) {
      if (c[key] !== null && typeof c[key] !== "string")
        fail(`${key} must be a column name or null`);
    }
    const yOk =
      c.y === null ||
      typeof c.y === "string" ||
      (Array.isArray(c.y) && c.y.length > 0 && c.y.every((v) => typeof v === "string"));
    if (!yOk) fail("y must be a column name, a non-empty array of names, or null to count rows");
    if (c.aggregate !== null && !AGGREGATES.includes(c.aggregate))
      fail(`aggregate must be one of ${AGGREGATES.join(", ")}`);
    if (
      c.bins !== null &&
      c.bins !== AUTO_BINS &&
      !UNITS.includes(c.bins) &&
      !(Number.isInteger(c.bins) && c.bins >= 1 && c.bins <= 200)
    ) {
      fail(
        `bins must be an integer from 1 to 200, one of ${UNITS.join(", ")}, ${AUTO_BINS}, or null`,
      );
    }
    for (const key of ["legend", "axes", "tooltips"]) {
      if (typeof c[key] !== "boolean") fail(`${key} must be true or false`);
    }
    if (c.stacked !== null && typeof c.stacked !== "boolean")
      fail("stacked must be true, false or null");
    if (!CATEGORY_ORDERS.includes(c.categories))
      fail(`categories must be one of ${CATEGORY_ORDERS.join(", ")}`);
    const ys = yList(c);
    if (c.type === "scatter") {
      if (ys.length !== 1) fail("scatter needs exactly one y column");
      if (c.aggregate !== null && c.aggregate !== "none")
        fail("scatter plots every row: remove aggregate");
      if (c.bins !== null) fail("scatter plots every row: remove bins");
    }
    if (ys.length === 0 && c.aggregate !== null && c.aggregate !== "count")
      fail(`aggregate "${c.aggregate}" needs y; without y the chart counts rows`);
    const agg = effAggregate(c);
    if ((c.type === "bar" || c.type === "histogram") && agg === "none")
      fail(`${c.type} needs an aggregate: count, sum, mean, min or max`);
    if (c.type !== "scatter" && agg === "none" && c.bins !== null)
      fail('bins needs an aggregate other than "none"');
    if (c.stacked && !STACKABLE.includes(c.type))
      fail("stacked applies to bar, histogram and area");
    if (c.stacked && agg === "none")
      fail("a stacked area needs an aggregate so groups share x positions");
    return { ...c, y: Array.isArray(c.y) ? [...c.y] : c.y };
  }

  // ---------- Model: everything derived from data and settings, built once per structural change ----------
  // mask: null, or { bits: Uint8Array(table.n), count } from validRows; groups and bins come from every row.
  function buildModel(table, cfg, mask = null) {
    const { type } = cfg;
    const xCol = need(table, cfg.x, "x");
    const agg = effAggregate(cfg);
    const scatter = type === "scatter";
    const raw = scatter || agg === "none";
    if (xCol.kind === "category" && (scatter || type === "histogram"))
      fail(`${type} needs a number or time x; "${cfg.x}" is a category column`);
    if (xCol.kind === "category" && raw)
      fail(`aggregate "none" needs a number or time x; "${cfg.x}" is a category column`);
    if (xCol.kind === "category" && cfg.bins !== null)
      fail(`bins needs a number or time x; "${cfg.x}" is a category column`);
    const measures = yList(cfg).length
      ? yList(cfg).map((name) => {
          const col = need(table, name, "y");
          if (col.kind !== "number")
            fail(
              `y column "${name}" is a ${col.kind} column; y must be numeric (omit y to count rows)`,
            );
          return { name, num: col.num };
        })
      : [{ name: "count", num: null }];
    const M = measures.length;

    const keyCols = [];
    for (const role of ["series", "color"]) {
      if (cfg[role] === null) {
        keyCols.push(null);
        continue;
      }
      const keys = keysOf(need(table, cfg[role], role));
      if (!keys.codes || keys.labels.length > MAX_GROUPS)
        fail(
          `${role} column "${cfg[role]}" has ${keys.labels.length} distinct values; the limit is ${MAX_GROUPS}`,
        );
      keyCols.push(keys);
    }
    const [sKeys, cKeys] = keyCols;

    // Groups: one per distinct (series, color) pair, ordered by code so legends are stable.
    const n = table.n;
    const Kc = cKeys ? cKeys.labels.length : 1;
    const rowKey = new Int32Array(n);
    const present = new Set();
    for (let r = 0; r < n; r++) {
      const s = sKeys ? sKeys.codes[r] : 0;
      const c = cKeys ? cKeys.codes[r] : 0;
      if (s < 0 || c < 0) {
        rowKey[r] = -1;
        continue;
      }
      rowKey[r] = s * Kc + c;
      present.add(rowKey[r]);
    }
    const keys = [...present].sort((a, b) => a - b);
    const groupOf = new Map(keys.map((key, g) => [key, g]));
    const rowGroup = new Int32Array(n);
    for (let r = 0; r < n; r++) rowGroup[r] = rowKey[r] < 0 ? -1 : groupOf.get(rowKey[r]);
    const groups = keys.map((key) => {
      const s = Math.floor(key / Kc);
      const c = key - s * Kc;
      const parts = [];
      if (sKeys) parts.push(sKeys.labels[s]);
      if (cKeys && cfg.color !== cfg.series) parts.push(cKeys.labels[c]);
      return { label: parts.join(" · "), c };
    });

    const G = groups.length;
    const S = G * M;
    const xv = xCol.kind === "category" ? null : xCol.num;
    const series = [];
    let bins = null;

    if (!raw) {
      bins = binsFor(xCol, cfg);
      const B = bins.count;
      const size = S * B;
      const sum = new Float64Array(size);
      const cnt = new Float64Array(size);
      const lo = new Float64Array(size).fill(Infinity);
      const hi = new Float64Array(size).fill(-Infinity);
      for (let r = 0; r < n && B > 0; r++) {
        const g = rowGroup[r];
        const b = bins.rowBin[r];
        if (g < 0 || b < 0 || (mask && !mask.bits[r])) continue;
        for (let m = 0; m < M; m++) {
          const v = measures[m].num === null ? 1 : measures[m].num[r];
          if (v !== v) continue;
          const k = (g * M + m) * B + b;
          sum[k] += v;
          cnt[k] += 1;
          if (v < lo[k]) lo[k] = v;
          if (v > hi[k]) hi[k] = v;
        }
      }
      for (let s = 0; s < S; s++) {
        const vals = new Float64Array(B);
        let any = false;
        for (let b = 0; b < B; b++) {
          const k = s * B + b;
          const c = cnt[k];
          if (c === 0) {
            vals[b] = agg === "count" || agg === "sum" ? 0 : NaN;
            continue;
          }
          any = true;
          if (agg === "sum") vals[b] = sum[k];
          else if (agg === "mean") vals[b] = sum[k] / c;
          else if (agg === "count") vals[b] = c;
          else if (agg === "min") vals[b] = lo[k];
          else vals[b] = hi[k];
        }
        if (any) series.push({ g: Math.floor(s / M), m: s % M, vals });
      }
    } else {
      const order = scatter ? null : orderOf(xCol);
      const count = order ? order.length : n;
      const xsOut = Array.from({ length: S }, () => []);
      const ysOut = Array.from({ length: S }, () => []);
      for (let i = 0; i < count; i++) {
        const r = order ? order[i] : i;
        const g = rowGroup[r];
        if (g < 0 || xv[r] !== xv[r] || (mask && !mask.bits[r])) continue;
        for (let m = 0; m < M; m++) {
          const v = measures[m].num[r];
          if (v !== v) continue;
          xsOut[g * M + m].push(xv[r]);
          ysOut[g * M + m].push(v);
        }
      }
      for (let s = 0; s < S; s++) {
        if (xsOut[s].length === 0) continue;
        series.push({
          g: Math.floor(s / M),
          m: s % M,
          xs: Float64Array.from(xsOut[s]),
          ys: Float64Array.from(ysOut[s]),
        });
      }
    }

    // Labels and colours: colour follows the color column when given, else the group and measure index (stable when
    // a rows view leaves a group empty).
    const built = series.map((s) => {
      const base = groups[s.g].label;
      const label =
        M > 1
          ? base
            ? `${base} · ${measures[s.m].name}`
            : measures[s.m].name
          : base || measures[0].name;
      return {
        ...s,
        label,
        colour: cKeys ? groups[s.g].c % CHART_VARS.length : (s.g * M + s.m) % CHART_VARS.length,
        dash: cKeys && M > 1 && s.m > 0 ? [5, 3] : null,
      };
    });

    let xLo = Infinity;
    let xHi = -Infinity;
    if (bins && bins.count > 0) {
      const last = bins.count - 1;
      const edges = type === "bar" || type === "histogram" || bins.mode === "category";
      xLo = edges ? bins.lo[0] : bins.pos[0];
      xHi = edges ? bins.hi[last] : bins.pos[last];
    } else if (raw) {
      for (const s of built) {
        for (const x of s.xs) {
          if (x < xLo) xLo = x;
          if (x > xHi) xHi = x;
        }
      }
    }
    if (!Number.isFinite(xLo) || !Number.isFinite(xHi)) {
      xLo = 0;
      xHi = 1;
    } else if (!(xHi > xLo)) {
      const pad = xCol.kind === "time" ? 12 * HOUR : 0.5;
      xLo -= pad;
      xHi += pad;
    }

    const yNames = measures.map((m) => m.name);
    let yTitle = yNames.join(", ");
    if (!yList(cfg).length) yTitle = "count";
    else if (!raw) yTitle = `${agg} of ${yTitle}`;
    return {
      type,
      aggregate: agg,
      xName: cfg.x,
      xKind: xCol.kind,
      xTitle: typeof cfg.bins === "string" ? `${cfg.x} by ${cfg.bins}` : cfg.x,
      yNames,
      yTitle,
      scatter,
      raw,
      bars: type === "bar" || type === "histogram",
      bins,
      labels: xCol.kind === "category" ? xCol.labels : null,
      xLo,
      xHi,
      series: built,
      rowCount: mask ? mask.count : n,
    };
  }

  // ---------- Geometry shared by the live canvases and the export ----------
  const visibleOf = (model, hidden) => model.series.filter((s) => !hidden.has(s.label));

  // Stacked tops and bases per visible series; positives stack up from zero, negatives down.
  function stackOf(model, visible) {
    const B = model.bins.count;
    const up = new Float64Array(B);
    const down = new Float64Array(B);
    const out = new Map();
    for (const s of visible) {
      const base = new Float64Array(B);
      const top = new Float64Array(B);
      for (let b = 0; b < B; b++) {
        const v = s.vals[b] === s.vals[b] ? s.vals[b] : 0;
        const acc = v >= 0 ? up : down;
        base[b] = acc[b];
        acc[b] += v;
        top[b] = acc[b];
      }
      out.set(s, { base, top });
    }
    return out;
  }

  function yExtent(model, visible, stack) {
    let lo = Infinity;
    let hi = -Infinity;
    const take = (v) => {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    };
    for (const s of visible) {
      const values = stack ? stack.get(s).top : model.raw ? s.ys : s.vals;
      for (let i = 0; i < values.length; i++) if (values[i] === values[i]) take(values[i]);
      if (stack) for (const v of stack.get(s).base) take(v);
    }
    if (model.bars || model.type === "area") take(0);
    if (!Number.isFinite(lo)) return { lo: 0, hi: 1 };
    return { lo, hi };
  }

  function xTicksFor(model, X, plotW, family) {
    const { xLo, xHi } = model;
    const span = xHi - xLo;
    const inRange = (v) => v >= xLo - span * 1e-9 && v <= xHi + span * 1e-9;
    let ticks;
    if (model.labels) {
      ticks = model.labels.map((label, k) => ({ pos: k, label }));
    } else if (model.bins && model.bins.mode === "distinct" && model.bins.count <= plotW / 28) {
      ticks = Array.from(model.bins.pos, (v) => ({ pos: v, label: fmtX(model, v) }));
    } else if (model.bins && UNITS.includes(model.bins.mode) && model.bins.count <= plotW / 56) {
      const b = model.bins;
      const fmt = {
        second: BIN_FMT.second,
        minute: TICK_FMT.time,
        hour: TICK_FMT.time,
        day: TICK_FMT.day,
        week: TICK_FMT.day,
        year: TICK_FMT.year,
      }[b.mode];
      ticks = Array.from(b.pos, (v, k) => {
        const start = b.lo[k];
        const yearly = k === 0 || new Date(start).getMonth() === 0;
        return {
          pos: v,
          label:
            b.mode === "month"
              ? (yearly ? TICK_FMT.monthYear : TICK_FMT.month).format(start)
              : fmt.format(start),
        };
      });
    } else {
      if (model.xKind === "time") ticks = timeTicks(xLo, xHi, clamp(Math.floor(plotW / 56), 2, 16));
      else {
        const t = niceTicks(xLo, xHi, clamp(Math.floor(plotW / 80), 2, 12));
        ticks = t.ticks.map((v) => ({ pos: v, label: fmtAxis(v, t.step) }));
      }
    }
    return thinTicks(
      ticks.filter((t) => inRange(t.pos)),
      X,
      family,
    );
  }

  function frameFor(w, h, model, cfg, th, legendH, hidden) {
    const family = th["--font-sans"];
    const visible = visibleOf(model, hidden);
    const stack = effStacked(cfg) && model.bins ? stackOf(model, visible) : null;
    const ext = yExtent(model, visible, stack);
    const plotT = legendH + 8;
    const bottom = cfg.axes ? 40 : 8;
    const yT = niceTicks(ext.lo, ext.hi, clamp(Math.floor((h - plotT - bottom) / 40), 2, 8));
    const yLabels = yT.ticks.map((v) => fmtAxis(v, yT.step));
    const labelW = cfg.axes
      ? Math.max(0, ...yLabels.map((t) => measureText(t, FONT, 400, family)))
      : 0;
    const plotL = cfg.axes ? Math.ceil(labelW) + 30 : 8;
    const plotR = w - (cfg.axes ? 16 : 8);
    const plotB = h - bottom;
    if (plotR - plotL < 24 || plotB - plotT < 24) return null;
    const plotW = plotR - plotL;
    const plotH = plotB - plotT;
    const xSpan = model.xHi - model.xLo;
    const ySpan = yT.hi - yT.lo;
    const X = (v) => plotL + ((v - model.xLo) / xSpan) * plotW;
    return {
      w,
      h,
      axes: cfg.axes,
      stacked: Boolean(stack),
      stack,
      visible,
      plotL,
      plotR,
      plotT,
      plotB,
      plotW,
      plotH,
      xSpan,
      yTicks: yT.ticks,
      yLabels,
      xTicks: cfg.axes ? xTicksFor(model, X, plotW, family) : [],
      screen: new Map(),
      X,
      inv: (px) => model.xLo + ((px - plotL) / plotW) * xSpan,
      Y: (v) => plotB - ((v - yT.lo) / ySpan) * plotH,
    };
  }

  function legendRowsFor(model, width, family) {
    const rows = [[]];
    let x = 8;
    for (const s of model.series) {
      const item = 14 + measureText(s.label, FONT, 400, family) + 16;
      if (x + item > width - 8 && rows[rows.length - 1].length) {
        rows.push([]);
        x = 8;
      }
      rows[rows.length - 1].push({ s, x });
      x += item;
    }
    return model.series.length ? rows : [];
  }

  // ---------- Painters: one drawing routine, a canvas backend and an SVG backend ----------
  function canvasPainter(ctx, family) {
    const path = (xs, ys) => {
      let pen = false;
      for (let i = 0; i < xs.length; i++) {
        if (xs[i] !== xs[i] || ys[i] !== ys[i]) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(xs[i], ys[i]);
        else ctx.moveTo(xs[i], ys[i]);
        pen = true;
      }
    };
    return {
      rect(x, y, w, h, fill, alpha = 1, rx = 0, stroke = null) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = fill;
        ctx.beginPath();
        if (rx > 0) ctx.roundRect(x, y, w, h, rx);
        else ctx.rect(x, y, w, h);
        ctx.fill();
        if (stroke) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.restore();
      },
      line(xs, ys, colour, width, dash, alpha = 1) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = colour;
        ctx.lineWidth = width;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.setLineDash(dash ?? []);
        ctx.beginPath();
        path(xs, ys);
        ctx.stroke();
        ctx.restore();
      },
      area(xs, ys, bases, colour, alpha) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = colour;
        ctx.beginPath();
        for (const [a, b] of runsOf(xs, ys)) {
          ctx.moveTo(xs[a], ys[a]);
          for (let i = a + 1; i <= b; i++) ctx.lineTo(xs[i], ys[i]);
          for (let i = b; i >= a; i--) ctx.lineTo(xs[i], bases[i]);
          ctx.closePath();
        }
        ctx.fill();
        ctx.restore();
      },
      dots(xs, ys, colour, r, alpha, stroke = null) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = colour;
        ctx.beginPath();
        for (let i = 0; i < xs.length; i++) {
          if (xs[i] !== xs[i] || ys[i] !== ys[i]) continue;
          ctx.moveTo(xs[i] + r, ys[i]);
          ctx.arc(xs[i], ys[i], r, 0, Math.PI * 2);
        }
        ctx.fill();
        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.restore();
      },
      text(x, y, s, size, colour, align, baseline, weight = 400, rotate = false) {
        ctx.save();
        ctx.font = fontOf(size, weight, family);
        ctx.fillStyle = colour;
        ctx.textAlign = align;
        ctx.textBaseline = baseline;
        if (rotate) {
          ctx.translate(x, y);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(s, 0, 0);
        } else ctx.fillText(s, x, y);
        ctx.restore();
      },
    };
  }

  // Index ranges [a, b] of consecutive finite points.
  function runsOf(xs, ys) {
    const runs = [];
    let start = -1;
    for (let i = 0; i <= xs.length; i++) {
      const ok = i < xs.length && xs[i] === xs[i] && ys[i] === ys[i];
      if (ok && start < 0) start = i;
      else if (!ok && start >= 0) {
        runs.push([start, i - 1]);
        start = -1;
      }
    }
    return runs;
  }

  function svgPainter(w, h, family) {
    const out = [];
    const f = (v) => String(Math.round(v * 100) / 100);
    const esc = (s) =>
      String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    return {
      rect(x, y, wd, ht, fill, alpha = 1, rx = 0, stroke = null) {
        out.push(
          `<rect x="${f(x)}" y="${f(y)}" width="${f(wd)}" height="${f(ht)}" rx="${rx}" fill="${esc(fill)}" fill-opacity="${alpha}"${stroke ? ` stroke="${esc(stroke)}"` : ""}/>`,
        );
      },
      line(xs, ys, colour, width, dash, alpha = 1) {
        let d = "";
        let open = false;
        for (let i = 0; i < xs.length; i++) {
          if (xs[i] !== xs[i] || ys[i] !== ys[i]) {
            open = false;
            continue;
          }
          d += `${open ? "L" : "M"}${f(xs[i])} ${f(ys[i])}`;
          open = true;
        }
        out.push(
          `<path d="${d}" fill="none" stroke="${esc(colour)}" stroke-width="${width}" stroke-opacity="${alpha}" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash.join(" ")}"` : ""}/>`,
        );
      },
      area(xs, ys, bases, colour, alpha) {
        let d = "";
        for (const [a, b] of runsOf(xs, ys)) {
          d += `M${f(xs[a])} ${f(ys[a])}`;
          for (let i = a + 1; i <= b; i++) d += `L${f(xs[i])} ${f(ys[i])}`;
          for (let i = b; i >= a; i--) d += `L${f(xs[i])} ${f(bases[i])}`;
          d += "Z";
        }
        out.push(`<path d="${d}" fill="${esc(colour)}" fill-opacity="${alpha}" stroke="none"/>`);
      },
      dots(xs, ys, colour, r, alpha) {
        let d = "";
        for (let i = 0; i < xs.length; i++)
          if (xs[i] === xs[i] && ys[i] === ys[i]) d += `M${f(xs[i])} ${f(ys[i])}h0`;
        if (d)
          out.push(
            `<path d="${d}" fill="none" stroke="${esc(colour)}" stroke-width="${f(2 * r)}" stroke-linecap="round" stroke-opacity="${alpha}"/>`,
          );
      },
      text(x, y, s, size, colour, align, baseline, weight = 400, rotate = false) {
        const anchor = align === "right" ? "end" : align === "center" ? "middle" : "start";
        const dominant =
          baseline === "middle" ? "central" : baseline === "top" ? "hanging" : "alphabetic";
        const rot = rotate ? ` transform="rotate(-90 ${f(x)} ${f(y)})"` : "";
        out.push(
          `<text x="${f(x)}" y="${f(y)}" font-family="${esc(family)}" font-size="${size}" font-weight="${weight}" fill="${esc(colour)}" text-anchor="${anchor}" dominant-baseline="${dominant}"${rot}>${esc(s)}</text>`,
        );
      },
      toString() {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${out.join("")}</svg>`;
      },
    };
  }

  // ---------- Base layer: axes and marks ----------
  // Which bins and x values sit inside the brush; null when nothing is brushed.
  function brushTest(model, brush) {
    if (!brush) return null;
    if (brush.values) {
      const set = new Set(brush.values);
      return { bin: (k) => set.has(model.labels[k]), x: () => true };
    }
    const inside = (v) => v >= brush.min && v <= brush.max;
    return { bin: (k) => inside(model.bins.pos[k]), x: inside };
  }

  function paintBase(p, f, model, th, brush) {
    const muted = th["--muted-foreground"];
    if (f.axes) {
      f.yTicks.forEach((v, k) => {
        const y = Math.round(f.Y(v)) + 0.5;
        p.line([f.plotL, f.plotR], [y, y], th["--border"], 1, null);
        p.text(f.plotL - 8, y, f.yLabels[k], FONT, muted, "right", "middle");
      });
      for (const t of f.xTicks)
        p.text(f.X(t.pos), f.plotB + 7, t.label, FONT, muted, "center", "top");
      p.text(12, (f.plotT + f.plotB) / 2, model.yTitle, FONT, muted, "center", "middle", 500, true);
      p.text((f.plotL + f.plotR) / 2, f.h - 12, model.xTitle, FONT, muted, "center", "middle", 500);
    }
    const test = brushTest(model, brush);
    f.visible.forEach((s, slot) =>
      drawSeries(p, f, model, s, th[CHART_VARS[s.colour]], slot, f.visible.length, test),
    );
    if (f.axes)
      p.line(
        [f.plotL, f.plotR],
        [Math.round(f.plotB) + 0.5, Math.round(f.plotB) + 0.5],
        muted,
        1,
        null,
        0.5,
      );
  }

  function drawSeries(p, f, model, s, colour, slot, slots, test) {
    if (model.scatter) {
      const n = s.xs.length;
      const xs = new Float32Array(n);
      const ys = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        xs[i] = f.X(s.xs[i]);
        ys[i] = f.Y(s.ys[i]);
      }
      f.screen.set(s, { xs, ys });
      const r = n > 4000 ? 1.6 : 2.5;
      if (!test) {
        p.dots(xs, ys, colour, r, 0.7);
        return;
      }
      const inX = [];
      const inY = [];
      const outX = [];
      const outY = [];
      for (let i = 0; i < n; i++) {
        if (test.x(s.xs[i])) {
          inX.push(xs[i]);
          inY.push(ys[i]);
        } else {
          outX.push(xs[i]);
          outY.push(ys[i]);
        }
      }
      p.dots(outX, outY, colour, r, 0.12);
      p.dots(inX, inY, colour, r, 0.8);
      return;
    }
    const b = model.bins;
    const st = f.stack ? f.stack.get(s) : null;
    if (model.bars) {
      const overlay = model.type === "histogram" && !st && slots > 1;
      for (let k = 0; k < b.count; k++) {
        const v = s.vals[k];
        if (v !== v || v === 0) continue;
        const x1 = f.X(b.lo[k]);
        const x2 = f.X(b.hi[k]);
        const inset = model.type === "bar" ? (x2 - x1) * 0.12 : Math.min(0.5, (x2 - x1) / 4);
        let left = x1 + inset;
        let width = x2 - x1 - 2 * inset;
        if (model.type === "bar" && !st && slots > 1) {
          width /= slots;
          left += slot * width;
          width = Math.max(1, width - 1);
        }
        const y0 = f.Y(st ? st.base[k] : 0);
        const y1 = f.Y(st ? st.top[k] : v);
        const alpha = (overlay ? 0.45 : 0.9) * (test && !test.bin(k) ? 0.25 : 1);
        p.rect(
          left,
          Math.min(y0, y1),
          Math.max(1, width),
          Math.max(1, Math.abs(y1 - y0)),
          colour,
          alpha,
        );
      }
      return;
    }
    let pts;
    let bases;
    if (model.raw) {
      pts = envelope(s.xs, s.ys, f);
      bases = new Array(pts.xs.length).fill(clamp(f.Y(0), f.plotT, f.plotB));
    } else {
      const n = b.count;
      pts = { xs: new Array(n), ys: new Array(n) };
      bases = new Array(n);
      for (let k = 0; k < n; k++) {
        pts.xs[k] = f.X(b.pos[k]);
        pts.ys[k] = f.Y(st ? st.top[k] : s.vals[k]);
        bases[k] = f.Y(st ? st.base[k] : 0);
      }
    }
    if (model.type === "area") p.area(pts.xs, pts.ys, bases, colour, st ? 0.32 : 0.14);
    p.line(pts.xs, pts.ys, colour, model.raw ? 1.25 : 2, s.dash);
    if (!model.raw && pts.xs.length <= DOT_LIMIT) p.dots(pts.xs, pts.ys, colour, 2.5, 1);
  }

  // Raw lines: keep the first, lowest, highest and last point of each pixel column.
  function envelope(xs, ys, f) {
    const outX = [];
    const outY = [];
    const width = Math.max(1, Math.floor(f.plotW));
    let bucket = -1;
    let first = -1;
    let last = -1;
    let minI = -1;
    let maxI = -1;
    const flush = () => {
      if (first < 0) return;
      const picks = [first, minI, maxI, last].sort((a, b) => a - b);
      let prev = -1;
      for (const i of picks) {
        if (i === prev) continue;
        outX.push(f.X(xs[i]));
        outY.push(f.Y(ys[i]));
        prev = i;
      }
    };
    for (let i = 0; i < xs.length; i++) {
      const px = clamp(Math.floor(f.X(xs[i]) - f.plotL), 0, width - 1);
      if (px !== bucket) {
        flush();
        bucket = px;
        first = i;
        minI = i;
        maxI = i;
      }
      last = i;
      if (ys[i] < ys[minI]) minI = i;
      if (ys[i] > ys[maxI]) maxI = i;
    }
    flush();
    return { xs: outX, ys: outY };
  }

  function paintMessage(p, w, h, text, th) {
    p.text(w / 2, h / 2, text, 12, th["--muted-foreground"], "center", "middle");
  }

  function paintLegend(p, rows, th, hidden) {
    rows.forEach((row, ri) => {
      const y = ri * LEGEND_ROW + LEGEND_ROW / 2;
      for (const item of row) {
        const off = hidden.has(item.s.label);
        p.rect(item.x, y - 5, 10, 10, th[CHART_VARS[item.s.colour]], off ? 0.35 : 1, 2);
        p.text(
          item.x + 16,
          y,
          item.s.label,
          FONT,
          off ? th["--muted-foreground"] : th["--foreground"],
          "left",
          "middle",
        );
      }
    });
  }

  // ---------- Overlay: hover, brush and tooltip ----------
  function binAt(model, v) {
    const b = model.bins;
    if (b.count === 0) return -1;
    const k = lowerBound(b.hi, v);
    return clamp(k, 0, b.count - 1);
  }

  function probe(model, f, px, py) {
    const visible = f.visible;
    if (visible.length === 0) return null;
    if (model.scatter) {
      let best = null;
      let bestD = 144;
      for (const s of visible) {
        const scr = f.screen.get(s);
        if (!scr) continue;
        for (let i = 0; i < scr.xs.length; i++) {
          const dx = scr.xs[i] - px;
          const dy = scr.ys[i] - py;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = { s, i, x: scr.xs[i], y: scr.ys[i] };
          }
        }
      }
      if (!best) return null;
      const { s, i } = best;
      return {
        band: null,
        guideX: null,
        anchor: { x: best.x, y: best.y },
        header: s.label,
        rows: [
          { colour: s.colour, label: model.xName, value: fmtX(model, s.xs[i]) },
          { colour: s.colour, label: model.yNames[s.m], value: fmtValue(s.ys[i]) },
        ],
        marks: [{ x: best.x, y: best.y, colour: s.colour }],
      };
    }
    const pos = f.inv(px);
    const rows = [];
    const marks = [];
    if (model.raw) {
      let header = null;
      let guideX = null;
      for (const s of visible) {
        const j = nearestIndex(s.xs, pos);
        if (j < 0) continue;
        if (header === null) {
          header = fmtX(model, s.xs[j]);
          guideX = f.X(s.xs[j]);
        }
        marks.push({ x: f.X(s.xs[j]), y: f.Y(s.ys[j]), colour: s.colour });
        rows.push({ colour: s.colour, label: s.label, value: fmtValue(s.ys[j]) });
      }
      return rows.length
        ? { band: null, guideX, anchor: { x: guideX, y: py }, header, rows, marks }
        : null;
    }
    const b = model.bins;
    const k = model.bars ? binAt(model, pos) : nearestIndex(b.pos, pos);
    if (k < 0) return null;
    let total = 0;
    for (const s of visible) {
      const v = s.vals[k];
      if (v !== v) continue;
      total += v;
      const st = f.stack ? f.stack.get(s) : null;
      if (!model.bars)
        marks.push({ x: f.X(b.pos[k]), y: f.Y(st ? st.top[k] : v), colour: s.colour });
      rows.push({ colour: s.colour, label: s.label, value: fmtValue(v) });
    }
    if (rows.length === 0) return null;
    if (f.stacked && rows.length > 1)
      rows.push({ colour: null, label: "Total", value: fmtValue(total) });
    const band = model.bars ? [f.X(b.lo[k]), f.X(b.hi[k])] : null;
    const guideX = model.bars ? null : f.X(b.pos[k]);
    const anchorX = band ? (band[0] + band[1]) / 2 : guideX;
    return { band, guideX, anchor: { x: anchorX, y: py }, header: binLabel(model, k), rows, marks };
  }

  function paintTooltip(p, f, th, hit) {
    const family = th["--font-sans"];
    const pad = 8;
    const lineH = 17;
    let labelW = 0;
    let valueW = 0;
    for (const row of hit.rows) {
      labelW = Math.max(labelW, measureText(row.label, FONT, 400, family));
      valueW = Math.max(valueW, measureText(row.value, FONT, 600, family));
    }
    const headW = measureText(hit.header, FONT, 600, family);
    const boxW = Math.ceil(Math.max(headW, 14 + labelW + 16 + valueW)) + pad * 2;
    const boxH = (hit.rows.length + 1) * lineH + pad * 2 - 2;
    let x = hit.anchor.x + 14;
    if (x + boxW > f.plotR) x = hit.anchor.x - 14 - boxW;
    x = clamp(x, f.plotL, Math.max(f.plotL, f.plotR - boxW));
    const y = clamp(hit.anchor.y - boxH / 2, f.plotT, Math.max(f.plotT, f.plotB - boxH));
    p.rect(x, y, boxW, boxH, th["--card"], 0.97, 6, th["--border"]);
    let cy = y + pad + lineH / 2 - 1;
    p.text(x + pad, cy, hit.header, FONT, th["--card-foreground"], "left", "middle", 600);
    for (const row of hit.rows) {
      cy += lineH;
      if (row.colour !== null) p.rect(x + pad, cy - 4, 8, 8, th[CHART_VARS[row.colour]], 1, 2);
      p.text(x + pad + 14, cy, row.label, FONT, th["--muted-foreground"], "left", "middle");
      p.text(x + boxW - pad, cy, row.value, FONT, th["--card-foreground"], "right", "middle", 600);
    }
  }

  // Pixel spans the brush covers: whole bins for bars, histograms and category x, otherwise one range.
  function brushSpans(model, f, brush) {
    if (!brush) return [];
    if (model.bins && (model.bars || brush.values)) {
      const test = brushTest(model, brush);
      const spans = [];
      for (let k = 0; k < model.bins.count; k++) {
        if (!test.bin(k)) continue;
        const a = f.X(model.bins.lo[k]);
        const b = f.X(model.bins.hi[k]);
        const last = spans[spans.length - 1];
        if (last && Math.abs(last[1] - a) < 0.5) last[1] = b;
        else spans.push([a, b]);
      }
      return spans;
    }
    return [[f.X(brush.min), f.X(brush.max)]];
  }

  function paintOverlay(p, f, model, th, st) {
    const ring = th["--ring"];
    const spans = st.drag ? [[st.drag.x0, st.drag.x1]] : brushSpans(model, f, st.brush);
    for (const span of spans) {
      const a = clamp(Math.min(span[0], span[1]), f.plotL, f.plotR);
      const b = clamp(Math.max(span[0], span[1]), f.plotL, f.plotR);
      p.rect(a, f.plotT, b - a, f.plotH, ring, 0.12);
      p.line([a, a], [f.plotT, f.plotB], ring, 1, null);
      p.line([b, b], [f.plotT, f.plotB], ring, 1, null);
    }
    if (
      !st.cursor ||
      st.cursor.x < f.plotL ||
      st.cursor.x > f.plotR ||
      st.cursor.y < f.plotT ||
      st.cursor.y > f.plotB
    )
      return;
    const hit = probe(model, f, st.cursor.x, st.cursor.y);
    if (!hit) return;
    if (hit.band)
      p.rect(hit.band[0], f.plotT, hit.band[1] - hit.band[0], f.plotH, th["--foreground"], 0.06);
    if (hit.guideX !== null)
      p.line(
        [hit.guideX, hit.guideX],
        [f.plotT, f.plotB],
        th["--muted-foreground"],
        1,
        [3, 3],
        0.7,
      );
    for (const m of hit.marks) p.dots([m.x], [m.y], th[CHART_VARS[m.colour]], 4, 1, th["--card"]);
    if (st.tooltips) paintTooltip(p, f, th, hit);
  }

  // ---------- Instance ----------
  function create(container, options = {}) {
    if (!(container instanceof HTMLElement))
      fail("create(container, options) needs an HTMLElement container");
    if (!options || typeof options !== "object")
      fail("create(container, options) needs an options object with x");
    injectStyle();
    if (instances.size === 0) startHub();

    const root = el("div", "t3k-chart-root");
    const legend = el("div", "t3k-chart-legend");
    const plot = el("div", "t3k-chart-plot");
    const base = el("canvas", "t3k-chart-base");
    base.setAttribute("aria-hidden", "true");
    const over = el("canvas", "t3k-chart-over");
    over.tabIndex = 0;
    over.setAttribute("role", "img");
    plot.append(base, over);
    root.append(legend, plot);
    container.append(root);

    let cfg = { ...DEFAULTS };
    let table = null;
    let parsed = null; // the source table, kept to rebuild category order
    let model = null;
    let frame = null;
    let brush = null;
    let hidden = new Set();
    let rows = null; // { bits, count } while a rows view is set
    let cursor = null;
    let drag = null;
    let anchor = null;
    let size = { w: 0, h: 0, dpr: 1 };
    let baseFrame = 0;
    let overFrame = 0;
    let token = 0;
    let destroyed = false;
    const listeners = { change: new Set(), filter: new Set() };

    function scheduleBase() {
      if (destroyed || baseFrame) return;
      baseFrame = requestAnimationFrame(() => {
        baseFrame = 0;
        paintAll();
      });
    }

    function scheduleOverlay() {
      if (destroyed || overFrame) return;
      overFrame = requestAnimationFrame(() => {
        overFrame = 0;
        paintOver();
      });
    }

    function resize() {
      const rect = plot.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      for (const c of [base, over]) {
        c.width = Math.max(1, Math.round(w * dpr));
        c.height = Math.max(1, Math.round(h * dpr));
      }
      size = { w, h, dpr };
    }

    function paintAll() {
      if (destroyed || !theme) return;
      if (Math.min(window.devicePixelRatio || 1, MAX_DPR) !== size.dpr) resize();
      const { w, h, dpr } = size;
      const ctx = base.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      frame = null;
      if (w > 0 && h > 0) {
        const p = canvasPainter(ctx, theme["--font-sans"]);
        if (!model) paintMessage(p, w, h, table ? "No rows" : "No data", theme);
        else {
          frame = frameFor(w, h, model, cfg, theme, 0, hidden);
          if (frame) paintBase(p, frame, model, theme, brush);
          if (frame && model.rowCount === 0)
            paintMessage(
              p,
              frame.plotL * 2 + frame.plotW,
              frame.plotT * 2 + frame.plotH,
              "No rows match",
              theme,
            );
        }
      }
      paintOver();
    }

    function paintOver() {
      if (destroyed || !theme) return;
      const { w, h, dpr } = size;
      const ctx = over.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (frame && model)
        paintOverlay(canvasPainter(ctx, theme["--font-sans"]), frame, model, theme, {
          cursor,
          drag,
          brush,
          tooltips: cfg.tooltips,
        });
    }

    function describe() {
      const label = model
        ? `${cfg.type} chart of ${model.yTitle} by ${cfg.x}, ${model.rowCount} rows`
        : "Chart without data";
      over.setAttribute(
        "aria-label",
        `${label}. Arrow keys move the cursor, Shift+arrows brush, Escape clears.`,
      );
    }

    function syncLegend() {
      for (const btn of legend.children)
        btn.setAttribute("aria-pressed", String(!hidden.has(btn.dataset.label)));
    }

    function toggleSeries(label) {
      if (hidden.has(label)) hidden.delete(label);
      else hidden.add(label);
      syncLegend();
      scheduleBase();
      emitChange();
    }

    function renderLegend() {
      legend.replaceChildren();
      legend.hidden = !cfg.legend || !model || model.series.length === 0;
      if (legend.hidden) return;
      for (const s of model.series) {
        const btn = el("button", "t3k-chart-item");
        btn.type = "button";
        btn.dataset.label = s.label;
        const sw = el("span", "t3k-chart-sw");
        sw.style.background = `var(${CHART_VARS[s.colour]})`;
        btn.append(sw, document.createTextNode(s.label));
        btn.addEventListener("click", () => toggleSeries(s.label));
        legend.append(btn);
      }
      syncLegend();
    }

    function validBrush(b, m) {
      if (b === null) return null;
      if (!b || typeof b !== "object")
        fail("brush must be { min, max }, { values: [...] } or null");
      const category = m ? m.xKind === "category" : Array.isArray(b.values);
      if (category) {
        if (!Array.isArray(b.values)) fail("a brush on a category x needs { values: [...] }");
        const values = b.values.map(String);
        if (m) {
          const unknown = values.filter((v) => !m.labels.includes(v));
          if (unknown.length) fail(`brush values ${quoteList(unknown)} are not in "${m.xName}"`);
        }
        return values.length ? { values } : null;
      }
      if (!Number.isFinite(b.min) || !Number.isFinite(b.max))
        fail("a brush on a number or time x needs finite { min, max } (epoch ms for time)");
      return { min: Math.min(b.min, b.max), max: Math.max(b.min, b.max) };
    }

    function validRows(list) {
      if (list === null) return null;
      if (!table) fail("rows needs data: call setData first");
      if (!Array.isArray(list) && !ArrayBuffer.isView(list))
        fail("rows must be an array of row indices or null");
      const bits = new Uint8Array(table.n);
      let count = 0;
      for (const r of list) {
        if (!Number.isInteger(r) || r < 0 || r >= table.n)
          fail(`rows: ${r} is not a row index 0..${table.n - 1}`);
        if (!bits[r]) count++;
        bits[r] = 1;
      }
      return { bits, count };
    }

    function validHidden(list) {
      if (!Array.isArray(list)) fail("hidden must be an array of legend labels");
      return new Set(list.map(String));
    }

    function applySettings(partial) {
      for (const key of Object.keys(partial)) {
        if (!SETTINGS.includes(key))
          fail(`unknown option "${key}"; options are ${SETTINGS.join(", ")}`);
      }
      const subset = Object.fromEntries(
        Object.entries(partial).filter(([key]) => CONFIG_KEYS.includes(key)),
      );
      const next = normaliseConfig({ ...cfg, ...subset });
      const structural = STRUCTURAL.some((key) => key in partial);
      const nextTable =
        table && next.categories !== cfg.categories
          ? tableFrom(parsed.names, parsed.rows, next.categories)
          : table;
      const nextRows = "rows" in partial ? validRows(partial.rows) : rows;
      const nextModel =
        structural || "rows" in partial
          ? nextTable
            ? buildModel(nextTable, next, nextRows)
            : null
          : model;
      const nextBrush =
        "brush" in partial ? validBrush(partial.brush, nextModel) : structural ? null : brush;
      const nextHidden = "hidden" in partial ? validHidden(partial.hidden) : hidden;
      cfg = next;
      table = nextTable;
      model = nextModel;
      rows = nextRows;
      brush = nextBrush;
      hidden = nextHidden;
      anchor = null;
      renderLegend();
      describe();
      scheduleBase();
    }

    function emit(event, payload) {
      for (const cb of [...listeners[event]]) cb(payload);
    }

    function emitChange() {
      if (listeners.change.size) emit("change", get());
    }

    function filterPayload(b) {
      const col = table.byName.get(model.xName);
      let count = 0;
      if (b.values) {
        const wanted = new Set(b.values.map((v) => col.labels.indexOf(v)));
        for (let r = 0; r < table.n; r++)
          if (wanted.has(col.codes[r]) && (!rows || rows.bits[r])) count++;
        return { column: col.name, kind: "category", values: [...b.values], count };
      }
      for (let r = 0; r < table.n; r++) {
        const v = col.num[r];
        if (v >= b.min && v <= b.max && (!rows || rows.bits[r])) count++;
      }
      return { column: col.name, kind: col.kind, min: b.min, max: b.max, count };
    }

    function setBrush(next) {
      const same = JSON.stringify(next) === JSON.stringify(brush);
      if (same) return;
      brush = next;
      emit("filter", brush ? filterPayload(brush) : null);
      emitChange();
      scheduleBase();
    }

    // Converts a pixel range into a brush in data units; bars and histograms snap to whole bins.
    function brushFromPixels(x0, x1) {
      const f = frame;
      const A = f.inv(clamp(Math.min(x0, x1), f.plotL, f.plotR));
      const B = f.inv(clamp(Math.max(x0, x1), f.plotL, f.plotR));
      const bins = model.bins;
      if (model.labels) {
        const last = model.labels.length - 1;
        const a = clamp(Math.round(A), 0, last);
        const b = clamp(Math.round(B), 0, last);
        return { values: model.labels.slice(a, b + 1) };
      }
      if (model.bars) {
        let first = -1;
        let last = -1;
        for (let k = 0; k < bins.count; k++) {
          if (bins.hi[k] > A && bins.lo[k] < B) {
            if (first < 0) first = k;
            last = k;
          }
        }
        if (first < 0) return null;
        return bins.mode === "distinct"
          ? { min: bins.pos[first], max: bins.pos[last] }
          : { min: bins.lo[first], max: bins.hi[last] };
      }
      return { min: A, max: B };
    }

    function pointerAt(e) {
      const r = over.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function onPointerMove(e) {
      cursor = pointerAt(e);
      if (drag) drag.x1 = cursor.x;
      scheduleOverlay();
    }

    function onPointerLeave() {
      if (drag) return;
      cursor = null;
      scheduleOverlay();
    }

    function onPointerDown(e) {
      if (e.button !== 0 || !frame) return;
      const at = pointerAt(e);
      over.setPointerCapture(e.pointerId);
      drag = { x0: at.x, x1: at.x };
      cursor = at;
      anchor = null;
      over.focus({ preventScroll: true });
      scheduleOverlay();
    }

    function onPointerUp(e) {
      if (!drag) return;
      const { x0, x1 } = drag;
      drag = null;
      if (over.hasPointerCapture(e.pointerId)) over.releasePointerCapture(e.pointerId);
      setBrush(Math.abs(x1 - x0) < 4 ? null : brushFromPixels(x0, x1));
      scheduleOverlay();
    }

    function onPointerCancel() {
      drag = null;
      scheduleOverlay();
    }

    function stepPx() {
      if (model.bins && model.bins.count > 0) return frame.plotW / model.bins.count;
      return frame.plotW / 50;
    }

    function onKeyDown(e) {
      if (!frame || !model) return;
      const step = stepPx();
      const midY = frame.plotT + frame.plotH / 2;
      const x = cursor ? cursor.x : null;
      let nextX = null;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown")
        nextX = (x ?? frame.plotR + step / 2) - step;
      else if (e.key === "ArrowRight" || e.key === "ArrowUp")
        nextX = (x ?? frame.plotL - step / 2) + step;
      else if (e.key === "PageUp") nextX = (x ?? frame.plotR) - 10 * step;
      else if (e.key === "PageDown") nextX = (x ?? frame.plotL) + 10 * step;
      else if (e.key === "Home") nextX = frame.plotL + Math.min(step / 2, 1);
      else if (e.key === "End") nextX = frame.plotR - Math.min(step / 2, 1);
      else if (e.key === "Escape") {
        anchor = null;
        if (brush) setBrush(null);
        else cursor = null;
        e.preventDefault();
        scheduleOverlay();
        return;
      } else return;
      e.preventDefault();
      nextX = clamp(nextX, frame.plotL, frame.plotR);
      if (e.shiftKey) {
        if (anchor === null) anchor = x ?? nextX;
        cursor = { x: nextX, y: cursor ? cursor.y : midY };
        setBrush(Math.abs(nextX - anchor) < 1 ? null : brushFromPixels(anchor, nextX));
      } else {
        anchor = null;
        cursor = { x: nextX, y: cursor ? cursor.y : midY };
      }
      scheduleOverlay();
    }

    function onBlur() {
      cursor = null;
      anchor = null;
      scheduleOverlay();
    }

    async function setData(source) {
      const mine = ++token;
      if (source === null) {
        const hadBrush = brush !== null;
        table = null;
        parsed = null;
        model = null;
        rows = null;
        brush = null;
        cursor = null;
        if (hadBrush) emit("filter", null);
        renderLegend();
        describe();
        scheduleBase();
        return null;
      }
      const nextParsed = await readSource(source);
      if (destroyed || mine !== token) return null;
      const nextTable = tableFrom(nextParsed.names, nextParsed.rows, cfg.categories);
      parsed = nextParsed;
      const nextModel = buildModel(nextTable, cfg);
      rows = null;
      const hadBrush = brush !== null;
      table = nextTable;
      model = nextModel;
      brush = null;
      cursor = null;
      anchor = null;
      if (hadBrush) emit("filter", null);
      renderLegend();
      describe();
      scheduleBase();
      return { columns: table.columns.map(describeColumn), rowCount: table.n };
    }

    function get() {
      return {
        type: cfg.type,
        x: cfg.x,
        y: Array.isArray(cfg.y) ? [...cfg.y] : cfg.y,
        series: cfg.series,
        color: cfg.color,
        aggregate: effAggregate(cfg),
        bins: cfg.bins,
        stacked: effStacked(cfg),
        categories: cfg.categories,
        legend: cfg.legend,
        axes: cfg.axes,
        tooltips: cfg.tooltips,
        brush: brush ? (brush.values ? { values: [...brush.values] } : { ...brush }) : null,
        hidden: [...hidden],
        groups: model ? model.series.map((s) => s.label) : [],
        hasData: table !== null,
        rowCount: table ? table.n : 0,
        shownRows: table ? (rows ? rows.count : table.n) : 0,
        columns: table ? table.columns.map(describeColumn) : [],
      };
    }

    function set(partial) {
      if (destroyed) fail("this chart was destroyed");
      if (!partial || typeof partial !== "object") fail("set(partial) needs an object of options");
      applySettings(partial);
    }

    function on(event, cb) {
      if (!EVENTS.includes(event))
        fail(`unknown event "${event}"; events are ${EVENTS.join(", ")}`);
      if (typeof cb !== "function") fail("on(event, cb) needs a function");
      listeners[event].add(cb);
      return () => listeners[event].delete(cb);
    }

    async function exportBlob(opts = {}) {
      const type = opts.type ?? "image/png";
      const scale = opts.scale ?? 2;
      if (!EXPORT_TYPES.includes(type))
        fail(`exportBlob type must be one of ${EXPORT_TYPES.join(", ")}`);
      if (!(scale > 0 && scale <= 4)) fail("exportBlob scale must be above 0 and at most 4");
      if (!model) fail("nothing to export; call setData first");
      if (!theme) refreshTheme();
      const box = root.getBoundingClientRect();
      const w = Math.floor(box.width);
      const h = Math.floor(box.height);
      const family = theme["--font-sans"];
      const rows = cfg.legend ? legendRowsFor(model, w, family) : [];
      const f = frameFor(w, h, model, cfg, theme, rows.length * LEGEND_ROW, hidden);
      if (!f) fail("the chart is too small to export");
      const draw = (p) => {
        p.rect(0, 0, w, h, theme["--background"]);
        paintLegend(p, rows, theme, hidden);
        paintBase(p, f, model, theme, brush);
      };
      if (type === "image/svg+xml") {
        const p = svgPainter(w, h, family);
        draw(p);
        return new Blob([p.toString()], { type });
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d");
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      draw(canvasPainter(ctx, family));
      return new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("t3kit.chart: PNG export failed"))),
          "image/png",
        );
      });
    }

    const handlers = [
      ["pointermove", onPointerMove],
      ["pointerleave", onPointerLeave],
      ["pointerdown", onPointerDown],
      ["pointerup", onPointerUp],
      ["pointercancel", onPointerCancel],
      ["keydown", onKeyDown],
      ["blur", onBlur],
    ];
    for (const [type, fn] of handlers) over.addEventListener(type, fn);
    const ro = new ResizeObserver(() => {
      resize();
      scheduleBase();
    });
    ro.observe(plot);

    const inst = { repaint: scheduleBase };
    instances.add(inst);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(baseFrame);
      cancelAnimationFrame(overFrame);
      ro.disconnect();
      for (const [type, fn] of handlers) over.removeEventListener(type, fn);
      listeners.change.clear();
      listeners.filter.clear();
      root.remove();
      instances.delete(inst);
      if (instances.size === 0) {
        stopHub();
        document.querySelector('style[data-t3kit="chart"]')?.remove();
      }
    }

    try {
      applySettings(options);
    } catch (error) {
      destroy();
      throw error;
    }
    return { setData, get, set, on, exportBlob, destroy };
  }

  t3kit.chart = { create };
})();
