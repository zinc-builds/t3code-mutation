/**
 * t3kit.datagrid: virtualized grid for CSV or JSON (100k+ rows). Infers column types (number, date, string);
 * sort, per-column filters, resize, reorder, hide, summary stats, row selection and computed columns.
 * create(container, options?) -> instance
 *   options.rowHeight  integer 20..48, default 28        options.selection  'multi' | 'single' | 'none' (default multi)
 *   options.toolbar    status, add-column field, Columns menu (default true)    options.stats  stats footer (default true)
 * instance.load(source, { format = 'auto', mergeOn = null }?) -> Promise<{ rows, columns, dropped } | null>
 *   null when superseded. source: Blob | File | blob:/data: URL | CSV, JSON or log text | object[] | list (merged, sorted by mergeOn).
 *   format: auto | csv | json | jsonl | logfmt | lines. Log lines: jsonl object per line; logfmt key=value; lines = [ts] [LEVEL] msg.
 *   Log text parses in 20k-line chunks. Clears selection and restriction; keeps layout, sort, filters.
 * instance.raw(index) -> string | null (log rows; null for CSV/JSON)   instance.column(id) -> string[] source cell text
 * instance.restrict(rows | null)   limit the view to these source rows (ascending); null lifts it. No event.
 * instance.get() -> { sort, filters, columns }
 *   sort:    { id, dir: 'asc' | 'desc' } | null   strings sort locale- and digit-aware; blanks always last
 *   filters: { [id]: text }  number/date: '5', '>5', '<=5', '!=0', '2..9', '..9'; dates take ISO year, month or day
 *            ('2026-05', '2026-01..2026-06-15'). string: 'ber' (contains, any case), '=Berlin' exact, '!=Berlin'.
 *   columns: [{ id, type, width, hidden, expr? }] in display order. type is read-only; expr marks a computed column.
 * instance.set(partial)  keys sort, filters, columns; each replaces. No events. Bad input throws. Omitted columns append.
 * instance.addColumn({ id, expr, width?, after? }) -> type    computed column, inserted after column `after` or last
 * instance.removeColumn(id)                                    computed columns only. Neither emits events.
 *   expr: column ids (bare when word-like, else [any name]), numbers, 'text', true/false, + - * / % < <= > >= == !=
 *   && || ! ( ), abs floor ceil round(x, digits?) sqrt pow log min max len lower upper year month day hour.
 *   Dates are epoch ms; blank cells are null and make the result blank. Parsed, never eval'd.
 * instance.selection() -> number[] source rows, ascending.  select(indices) no event.  row(index) -> { [id]: value }
 * instance.view() -> number[] source rows filtered and sorted, in display order.   match({ [id]: text }) -> number[]
 *   source rows (ascending) that filter object keeps, the grid unchanged (e.g. every filter but one, for linked charts)
 * instance.stats() -> { rows, total, columns: { [id]: stats } }   over filtered rows. number {count, empty, min, max,
 *   sum, mean}; date {count, empty, min, max} (ms); string {count, empty, distinct, top}
 * instance.on(event, cb) -> unsubscribe   instance.destroy()
 *   'change'  user changed sort, filters or columns; payload get()
 *   'filter'  user changed filters; payload { filters, rows } (rows = matching count)
 *   'select'  user changed the selection; payload number[] (source row indices)
 * Keys: arrows, PageUp/Down, Home/End move; Space toggles; Shift extends; Ctrl/Cmd+A selects all; Esc clears.
 *   Header: Enter sorts, Alt+Left/Right moves the column. Drag a header to reorder, its right edge to resize.
 * Example:
 *   const g = t3kit.datagrid.create(el);
 *   await g.load(csvBlob);                                     // Blob from t3.workspace.assets()
 *   g.addColumn({ id: 'kmh', expr: 'distance_km / duration_min * 60' });
 *   g.set({ sort: { id: 'kmh', dir: 'desc' }, filters: { city: 'ber', started_at: '2026-06..2026-08' } });
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});

  const ROW_MIN = 20;
  const ROW_MAX = 48;
  const OVERSCAN = 6;
  const COL_OVERSCAN = 1;
  const MIN_W = 48;
  const MAX_W = 1200;
  const DRAG_START = 5;
  const WIDTH = { number: 110, date: 160, string: 170 };
  const COMPUTED_WIDTH = 120;
  const TYPE_LABEL = { number: "num", date: "date", string: "text" };
  const PLACEHOLDER = {
    number: ">5, 2..9, !=0",
    date: "2026-05, a..b",
    string: "contains, =exact",
  };
  const EVENTS = ["change", "filter", "select"];
  const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const PART_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
  const WORD_RE = /^[A-Za-z_$][\w$]*$/;
  const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const NF = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const CELL_NF = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4, useGrouping: false });
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad = (v) => String(v).padStart(2, "0");
  const dayText = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const defaultWidth = (id, type) => Math.max(WIDTH[type], Math.min(260, id.length * 7 + 64));
  const widthOf = (w, dflt) => {
    if (w === undefined) return dflt;
    if (!Number.isFinite(w)) throw new TypeError("datagrid: width must be a number");
    return clamp(Math.round(w), MIN_W, MAX_W);
  };

  const STYLE_TEXT = `
.t3k-datagrid-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;border:1px solid var(--border);border-radius:var(--radius);background:var(--background);color:var(--foreground);font:12px/1.4 var(--font-sans);overflow:hidden}
.t3k-datagrid-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;background:var(--card);border-bottom:1px solid var(--border)}
.t3k-datagrid-bar[hidden],.t3k-datagrid-foot[hidden],.t3k-datagrid-err[hidden],.t3k-datagrid-empty[hidden],.t3k-datagrid-drop[hidden]{display:none}
.t3k-datagrid-status{flex:1 1 160px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted-foreground);font-variant-numeric:tabular-nums}
.t3k-datagrid-addform{display:flex;gap:6px;flex:1 1 280px;max-width:480px;min-width:0}
.t3k-datagrid-btn{flex:none;height:24px;font:inherit;color:inherit;background:var(--background);border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);padding:0 8px;cursor:pointer;list-style:none;display:inline-flex;align-items:center}
.t3k-datagrid-btn:hover{background:var(--muted)}
.t3k-datagrid-btn:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.t3k-datagrid-btn:disabled{opacity:.5;cursor:default}
.t3k-datagrid-menu{position:relative}
.t3k-datagrid-menu>summary::-webkit-details-marker{display:none}
.t3k-datagrid-pop{position:absolute;right:0;top:calc(100% + 4px);z-index:10;display:flex;flex-direction:column;gap:2px;min-width:220px;max-height:50vh;overflow:auto;padding:6px;background:var(--popover);color:var(--foreground);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 8px 24px color-mix(in srgb,var(--foreground) 14%,transparent)}
.t3k-datagrid-opt{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:26px}
.t3k-datagrid-opt label{display:flex;align-items:center;gap:6px;min-width:0;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.t3k-datagrid-opt small{color:var(--muted-foreground)}
.t3k-datagrid-input{box-sizing:border-box;min-width:0;width:100%;height:24px;padding:0 6px;font:inherit;font-size:11px;color:var(--foreground);background:var(--background);border:1px solid var(--input);border-radius:calc(var(--radius) - 3px)}
.t3k-datagrid-input:focus-visible{outline:2px solid var(--ring);outline-offset:-1px}
.t3k-datagrid-input[aria-invalid="true"]{border-color:var(--destructive)}
.t3k-datagrid-addform .t3k-datagrid-input{font-family:var(--font-mono)}
.t3k-datagrid-err{flex:1 0 100%;color:var(--destructive);font-size:11px}
.t3k-datagrid-scroll{position:relative;flex:1 1 auto;min-height:0;overflow:auto;outline:none}
.t3k-datagrid-scroll:focus-visible{box-shadow:inset 0 0 0 2px var(--ring)}
.t3k-datagrid-head,.t3k-datagrid-filters,.t3k-datagrid-foot{position:sticky;display:flex;background:var(--card);z-index:2}
.t3k-datagrid-head{top:0;height:30px;border-bottom:1px solid var(--border)}
.t3k-datagrid-filters{top:30px;height:30px;border-bottom:1px solid var(--border)}
.t3k-datagrid-foot{bottom:0;border-top:1px solid var(--border)}
.t3k-datagrid-body{position:relative;user-select:none}
.t3k-datagrid-win{position:absolute;top:0;left:0;right:0}
.t3k-datagrid-th,.t3k-datagrid-fcell,.t3k-datagrid-stat,.t3k-datagrid-cell{position:relative;flex:none;box-sizing:border-box;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.t3k-datagrid-th{display:flex;align-items:center;gap:4px;padding:0 10px 0 8px;border-right:1px solid var(--border);color:var(--muted-foreground);font-weight:600;user-select:none}
.t3k-datagrid-th.is-dragging{background:var(--muted);cursor:grabbing}
.t3k-datagrid-sort{display:flex;align-items:center;gap:3px;flex:1 1 auto;min-width:0;height:22px;padding:0 2px;border:0;border-radius:calc(var(--radius) - 3px);background:none;font:inherit;color:var(--foreground);text-align:left;cursor:pointer}
.t3k-datagrid-sort:focus-visible{outline:2px solid var(--ring)}
.t3k-datagrid-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t3k-datagrid-arrow{flex:none;color:var(--primary)}
.t3k-datagrid-type{flex:none;font-size:10px;font-weight:400;color:var(--muted-foreground);border:1px solid var(--border);border-radius:4px;padding:0 3px}
.t3k-datagrid-type.is-fx{color:var(--primary);border-color:color-mix(in srgb,var(--primary) 45%,transparent)}
.t3k-datagrid-grip{position:absolute;top:0;right:0;bottom:0;width:7px;cursor:col-resize;z-index:1;touch-action:none}
.t3k-datagrid-grip:hover{background:var(--ring)}
.t3k-datagrid-drop{position:absolute;width:2px;background:var(--primary);z-index:4;pointer-events:none}
.t3k-datagrid-fcell{display:flex;align-items:center;padding:0 6px;border-right:1px solid var(--border)}
.t3k-datagrid-stat{display:flex;flex-direction:column;justify-content:center;padding:4px 8px;font-size:11px;line-height:1.35;color:var(--muted-foreground);border-right:1px solid var(--border);font-variant-numeric:tabular-nums}
.t3k-datagrid-stat span{overflow:hidden;text-overflow:ellipsis}
.t3k-datagrid-stat b{font-weight:500;color:var(--foreground)}
.t3k-datagrid-row{display:flex;align-items:center;box-sizing:border-box;width:100%;border-bottom:1px solid var(--border)}
.t3k-datagrid-row:hover{background:var(--muted)}
.t3k-datagrid-row.is-selected{background:color-mix(in srgb,var(--primary) 18%,transparent)}
.t3k-datagrid-row.is-active{box-shadow:inset 2px 0 0 var(--ring)}
.t3k-datagrid-pad{flex:none}
.t3k-datagrid-cell{display:block;padding:0 8px}
.t3k-datagrid-cell.is-num{text-align:right;font-variant-numeric:tabular-nums}
.t3k-datagrid-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted-foreground);pointer-events:none;z-index:3}`;

  function injectStyle() {
    if (document.querySelector('style[data-t3kit="datagrid"]')) return;
    const style = document.createElement("style");
    style.setAttribute("data-t3kit", "datagrid");
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
  }

  // ---- CSV and JSON parsing ---------------------------------------------------------------------------------

  function fieldEnd(text, from, n) {
    let i = from;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44 || c === 10 || c === 13) break;
      i++;
    }
    return i;
  }

  // RFC 4180: quoted fields with "" escapes, CRLF or LF or CR line ends. Returns string[][].
  function parseCSV(text) {
    const n = text.length;
    const rows = [];
    let pos = 0;
    if (pos >= n) return rows;
    let row = [];
    for (;;) {
      let value;
      if (text.charCodeAt(pos) === 34) {
        let out = "";
        let p = pos + 1;
        for (;;) {
          const q = text.indexOf('"', p);
          if (q < 0) {
            out += text.slice(p);
            p = n;
            break;
          }
          out += text.slice(p, q);
          if (text.charCodeAt(q + 1) === 34) {
            out += '"';
            p = q + 2;
          } else {
            p = q + 1;
            break;
          }
        }
        const end = fieldEnd(text, p, n);
        value = out + text.slice(p, end);
        pos = end;
      } else {
        const end = fieldEnd(text, pos, n);
        value = text.slice(pos, end);
        pos = end;
      }
      row.push(value);
      if (pos >= n) {
        rows.push(row);
        return rows;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos++;
        continue;
      }
      pos += c === 13 && text.charCodeAt(pos + 1) === 10 ? 2 : 1;
      rows.push(row);
      row = [];
      if (pos >= n) return rows;
    }
  }

  function tableFromCSV(text) {
    const rows = parseCSV(text).filter((r) => r.length > 1 || r[0] !== "");
    if (rows.length === 0) throw new Error("datagrid: CSV has no header row");
    const names = rows[0];
    const body = rows.slice(1);
    for (let r = 0; r < body.length; r++) {
      const row = body[r];
      if (row.length > names.length) {
        throw new Error(
          `datagrid: CSV line ${r + 2} has ${row.length} fields, the header has ${names.length}`,
        );
      }
      while (row.length < names.length) row.push("");
    }
    return { names, rows: body };
  }

  function tableFromJSON(data) {
    if (!Array.isArray(data)) throw new TypeError("datagrid: JSON must be an array of objects");
    const names = [];
    const seen = new Set();
    for (const obj of data) {
      if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        throw new TypeError("datagrid: every JSON row must be an object");
      }
      for (const key of Object.keys(obj)) {
        if (!seen.has(key)) {
          seen.add(key);
          names.push(key);
        }
      }
    }
    const rows = data.map((obj) =>
      names.map((key) => {
        const v = obj[key];
        if (v === undefined || v === null) return "";
        return typeof v === "object" ? JSON.stringify(v) : String(v);
      }),
    );
    return { names, rows };
  }

  // ---- Log formats: JSON lines, logfmt and timestamp-prefixed lines, parsed in chunks ------------------------
  const LOG_CHUNK = 20000;
  const SNIFF_BYTES = 65536;
  const FORMATS = ["auto", "csv", "json", "jsonl", "logfmt", "lines"];
  const LOG_TS_RE =
    /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\s+/;
  const LOG_LEVEL_RE =
    /^[[(]?(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|ERR|FATAL|CRITICAL|CRIT)[\])]?(?=[\s:|]|$)/i;
  const LEVEL_ALIAS = { WARNING: "WARN", ERR: "ERROR", CRITICAL: "FATAL", CRIT: "FATAL" };
  const PAIR_SRC = '([A-Za-z_][\\w.@-]*)=("(?:[^"\\\\]|\\\\.)*"|[^\\s"]*)';
  const yieldNow = () => new Promise((resolve) => setTimeout(resolve, 0));

  function flatRecord(obj) {
    const out = {};
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      out[key] =
        v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    return out;
  }

  function parseJsonlLine(line, lineNo) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new SyntaxError(`datagrid: jsonl line ${lineNo} is not valid JSON (${err.message})`);
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj))
      throw new TypeError(`datagrid: jsonl line ${lineNo} is not a JSON object`);
    return flatRecord(obj);
  }

  function parseLogfmtLine(line) {
    const rec = {};
    for (const m of line.matchAll(new RegExp(PAIR_SRC, "g"))) {
      const v = m[2];
      rec[m[1]] = v.length >= 2 && v[0] === '"' ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v;
    }
    return rec;
  }

  // ts, level, msg first, then key=value pairs found in the message (they never overwrite those three).
  function parseLineRecord(line) {
    let rest = line;
    let ts = "";
    const tm = LOG_TS_RE.exec(line);
    if (tm) {
      ts = tm[1];
      rest = line.slice(tm[0].length);
    }
    let level = "";
    const lm = LOG_LEVEL_RE.exec(rest);
    if (lm) {
      const word = lm[1].toUpperCase();
      level = LEVEL_ALIAS[word] ?? word;
      rest = rest.slice(lm[0].length);
    }
    const msg = rest.replace(/^[\s:|-]+/, "").trim();
    const rec = { ts, level, msg };
    for (const m of msg.matchAll(new RegExp(PAIR_SRC, "g"))) {
      if (!(m[1] in rec))
        rec[m[1]] = m[2].length >= 2 && m[2][0] === '"' ? m[2].slice(1, -1) : m[2];
    }
    return rec;
  }

  function countPairs(line) {
    let n = 0;
    for (const _ of line.matchAll(new RegExp(PAIR_SRC, "g"))) n++;
    return n;
  }

  // Decides the format from the first lines of a source. Plain text only; CSV is the fallback.
  function sniffFormat(head) {
    const lines = head
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 50);
    if (lines.length === 0) return "csv";
    const first = lines[0];
    if (first.startsWith("[")) return "json";
    if (first.startsWith("{")) {
      try {
        JSON.parse(first);
        return "jsonl";
      } catch (err) {
        return "json";
      }
    }
    const pairs = lines.filter((l) => countPairs(l) >= 2).length;
    if (pairs >= lines.length * 0.8) return "logfmt";
    const stamped = lines.filter((l) => LOG_TS_RE.test(l)).length;
    const bare = lines.filter((l) => !l.includes(",")).length;
    if (stamped >= lines.length * 0.8 || bare >= lines.length * 0.8) return "lines";
    return "csv";
  }

  // Blob text in complete-line blocks, read as a stream so a large log never exists whole as one string.
  async function* lineBlocks(blob) {
    const reader = blob.stream().getReader();
    const decoder = new TextDecoder();
    let carry = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      const cut = carry.lastIndexOf("\n");
      if (cut >= 0) {
        yield carry.slice(0, cut);
        carry = carry.slice(cut + 1);
      }
    }
    carry += decoder.decode();
    if (carry) yield carry;
  }

  async function parseLogBlocks(blocks, kind) {
    const records = [];
    const raw = [];
    let lineNo = 0;
    for await (const block of blocks) {
      for (const piece of block.split("\n")) {
        lineNo++;
        const line = piece.replace(/\r$/, "").trim();
        if (line === "") continue;
        raw.push(line);
        records.push(
          kind === "jsonl"
            ? parseJsonlLine(line, lineNo)
            : kind === "logfmt"
              ? parseLogfmtLine(line)
              : parseLineRecord(line),
        );
        if (records.length % LOG_CHUNK === 0) await yieldNow();
      }
    }
    const names = [];
    const seen = new Set();
    for (const rec of records) {
      for (const key of Object.keys(rec)) {
        if (!seen.has(key)) {
          seen.add(key);
          names.push(key);
        }
      }
    }
    const rows = records.map((rec) => names.map((key) => rec[key] ?? ""));
    return { names, rows, raw };
  }

  async function blobOf(source) {
    if (source instanceof Blob) return source;
    if (typeof source === "string" && /^(blob|data):/.test(source))
      return (await fetch(source)).blob();
    return null;
  }

  // One source to a table: { names, rows, raw }. raw is the array of exact lines for log formats, else null.
  async function parseSource(source, format) {
    if (Array.isArray(source)) return { ...tableFromJSON(source), raw: null };
    const blob = await blobOf(source);
    if (blob === null && typeof source !== "string")
      throw new TypeError(
        "datagrid: load() takes a Blob, a blob:/data: URL, CSV, JSON or log text, an array of objects, or a list of those",
      );
    let text = blob === null ? source : null;
    if (text !== null && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let kind = format;
    if (kind === "auto") {
      const headText =
        blob === null ? source.slice(0, SNIFF_BYTES) : await blob.slice(0, SNIFF_BYTES).text();
      kind = sniffFormat(headText.charCodeAt(0) === 0xfeff ? headText.slice(1) : headText);
    }
    if (kind === "csv") {
      const body = blob === null ? text : await blob.text();
      return { ...tableFromCSV(body.replace(/^\uFEFF/, "")), raw: null };
    }
    if (kind === "json") {
      const body = blob === null ? text : await blob.text();
      return { ...tableFromJSON(JSON.parse(body.replace(/^﻿/, ""))), raw: null };
    }
    const blocks =
      blob === null
        ? (async function* () {
            yield text;
          })()
        : lineBlocks(blob);
    return parseLogBlocks(blocks, kind);
  }

  // Several sources become one table: the union of their columns, rows in source order, or sorted by mergeOn.
  async function mergeTables(tables, mergeOn) {
    const names = [];
    const seen = new Set();
    for (const t of tables)
      for (const name of t.names)
        if (!seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
    if (mergeOn !== null && !names.includes(mergeOn))
      throw new Error(`datagrid: merge column "${mergeOn}" is in none of the sources`);
    const rows = [];
    const raw = tables.every((t) => t.raw) ? [] : null;
    const key = [];
    const mergeAt = mergeOn === null ? -1 : names.indexOf(mergeOn);
    for (const t of tables) {
      const at = t.names.map((name) => names.indexOf(name));
      // A row with no merge key (a stack-trace continuation line) keeps the key of the row before it in its source.
      let carry = Infinity;
      for (let r = 0; r < t.rows.length; r++) {
        const row = new Array(names.length).fill("");
        for (let c = 0; c < at.length; c++) row[at[c]] = t.rows[r][c];
        rows.push(row);
        if (raw) raw.push(t.raw[r]);
        if (mergeAt >= 0) {
          const v = row[mergeAt];
          const k = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : parseDate(v);
          if (k === k && v !== "") carry = k;
          key.push(carry);
        }
      }
    }
    if (mergeOn === null) return { names, rows, raw };
    const order = rows.map((_, i) => i).sort((a, b) => key[a] - key[b] || a - b);
    return {
      names,
      rows: order.map((i) => rows[i]),
      raw: raw ? order.map((i) => raw[i]) : null,
    };
  }

  async function readTable(source, { format, mergeOn }) {
    if (
      Array.isArray(source) &&
      source.length > 0 &&
      source.every((s) => s instanceof Blob || typeof s === "string")
    ) {
      const tables = [];
      for (const item of source) tables.push(await parseSource(item, format));
      return mergeTables(tables, mergeOn);
    }
    const table = await parseSource(source, format);
    if (mergeOn === null) return table;
    return mergeTables([table], mergeOn);
  }

  // ---- Typed source -----------------------------------------------------------------------------------------

  function uniqueNames(list) {
    const seen = new Map();
    return list.map((raw, i) => {
      const base = String(raw).trim() || `column ${i + 1}`;
      const k = seen.get(base) || 0;
      seen.set(base, k + 1);
      return k ? `${base} (${k + 1})` : base;
    });
  }

  // ISO day (local midnight) or date-time (local unless it carries a zone). Epoch ms, NaN when not a date.
  function parseDate(s) {
    const m = DAY_RE.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    return Date.parse(s.replace(" ", "T"));
  }

  function inferType(raw) {
    let num = true;
    let date = true;
    let any = false;
    for (const s of raw) {
      if (s === "") continue;
      any = true;
      if (num && !NUM_RE.test(s)) num = false;
      if (date && (!DATE_RE.test(s) || Number.isNaN(parseDate(s)))) date = false;
      if (!num && !date) break;
    }
    if (!any) return "string";
    return num ? "number" : date ? "date" : "string";
  }

  // Columnar store. Every source column keeps its text (str); number and date columns also keep a
  // Float64Array (num, NaN = blank) that sort, filters, stats and expressions read.
  function buildSource({ names: rawNames, rows }) {
    const names = uniqueNames(rawNames);
    const n = rows.length;
    const byId = new Map();
    const cols = names.map((id, c) => {
      const str = new Array(n);
      for (let r = 0; r < n; r++) str[r] = rows[r][c];
      const type = inferType(str);
      let num = null;
      if (type === "number") {
        num = new Float64Array(n);
        for (let r = 0; r < n; r++) num[r] = str[r] === "" ? NaN : Number(str[r]);
      } else if (type === "date") {
        num = new Float64Array(n);
        for (let r = 0; r < n; r++) num[r] = str[r] === "" ? NaN : parseDate(str[r]);
      }
      const col = { id, type, num, str, rank: null };
      byId.set(id, col);
      return col;
    });
    return { rows: n, cols, byId, raw: null };
  }

  // ---- Expression language (computed columns) --------------------------------------------------------------
  // Parsed into an AST, then compiled into closures that read the column arrays directly. No eval.

  const FUNCS = {
    abs: [1, 1, Math.abs],
    floor: [1, 1, Math.floor],
    ceil: [1, 1, Math.ceil],
    round: [1, 2, (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d],
    sqrt: [1, 1, Math.sqrt],
    pow: [2, 2, Math.pow],
    log: [1, 1, Math.log],
    min: [1, 99, Math.min],
    max: [1, 99, Math.max],
    len: [1, 1, (s) => String(s).length],
    lower: [1, 1, (s) => String(s).toLowerCase()],
    upper: [1, 1, (s) => String(s).toUpperCase()],
    year: [1, 1, (ms) => new Date(ms).getFullYear()],
    month: [1, 1, (ms) => new Date(ms).getMonth() + 1],
    day: [1, 1, (ms) => new Date(ms).getDate()],
    hour: [1, 1, (ms) => new Date(ms).getHours()],
  };
  const PREC = {
    "||": 1,
    "&&": 2,
    "==": 3,
    "!=": 3,
    "<": 4,
    "<=": 4,
    ">": 4,
    ">=": 4,
    "+": 5,
    "-": 5,
    "*": 6,
    "/": 6,
    "%": 6,
  };
  const TOKEN_RE =
    /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|'([^']*)'|\[([^\]]+)\]|(&&|\|\||<=|>=|==|!=|[-+*/%<>!(),])|([A-Za-z_$][\w$]*))/y;

  function tokenize(src) {
    const out = [];
    let pos = 0;
    while (pos < src.length) {
      if (/^\s*$/.test(src.slice(pos))) break;
      TOKEN_RE.lastIndex = pos;
      const m = TOKEN_RE.exec(src);
      if (!m) throw new SyntaxError(`unexpected "${src.slice(pos).trim()[0]}" at ${pos + 1}`);
      pos = TOKEN_RE.lastIndex;
      if (m[1] !== undefined) out.push({ t: "num", v: Number(m[1]) });
      else if (m[2] !== undefined) out.push({ t: "str", v: m[2] });
      else if (m[3] !== undefined) out.push({ t: "ref", v: m[3].trim() });
      else if (m[4] !== undefined) out.push({ t: "op", v: m[4] });
      else out.push({ t: "word", v: m[5] });
    }
    return out;
  }

  function parseExpr(src) {
    const toks = tokenize(src);
    if (toks.length === 0) throw new SyntaxError("empty expression");
    let p = 0;
    const isOp = (v) => toks[p] && toks[p].t === "op" && toks[p].v === v;
    const eat = (v) => (isOp(v) ? (p++, true) : false);
    const primary = () => {
      const k = toks[p++];
      if (!k) throw new SyntaxError("expression ends too early");
      if (k.t === "num" || k.t === "str") return { k: "lit", v: k.v };
      if (k.t === "ref") return { k: "ref", v: k.v };
      if (k.t === "word") {
        if (isOp("(")) {
          const f = FUNCS[k.v];
          if (!f) throw new SyntaxError(`unknown function "${k.v}"`);
          p++;
          const args = [];
          if (!eat(")")) {
            do args.push(binary(0));
            while (eat(","));
            if (!eat(")")) throw new SyntaxError(`missing ")" after ${k.v}(`);
          }
          if (args.length < f[0] || args.length > f[1])
            throw new SyntaxError(
              `${k.v}() takes ${f[0] === f[1] ? f[0] : `${f[0]} to ${f[1]}`} argument(s)`,
            );
          return { k: "call", fn: k.v, args };
        }
        if (k.v === "true" || k.v === "false") return { k: "lit", v: k.v === "true" };
        if (k.v === "null") return { k: "lit", v: null };
        return { k: "ref", v: k.v };
      }
      if (k.v === "(") {
        const inner = binary(0);
        if (!eat(")")) throw new SyntaxError('missing ")"');
        return inner;
      }
      if (k.v === "-" || k.v === "!" || k.v === "+") return { k: "un", op: k.v, a: primary() };
      throw new SyntaxError(`unexpected "${k.v}"`);
    };
    const binary = (min) => {
      let left = primary();
      for (;;) {
        const k = toks[p];
        if (!k || k.t !== "op" || PREC[k.v] === undefined || PREC[k.v] < min) return left;
        p++;
        left = { k: "bin", op: k.v, a: left, b: binary(PREC[k.v] + 1) };
      }
    };
    const ast = binary(0);
    if (p < toks.length) throw new SyntaxError(`unexpected "${toks[p].v}"`);
    return ast;
  }

  function refsOf(ast, out = new Set()) {
    if (ast.k === "ref") out.add(ast.v);
    else if (ast.k === "un") refsOf(ast.a, out);
    else if (ast.k === "bin") refsOf(ast.b, refsOf(ast.a, out));
    else if (ast.k === "call") for (const a of ast.args) refsOf(a, out);
    return out;
  }

  const BIN = {
    "+": (x, y) => (typeof x === "string" || typeof y === "string" ? `${x}${y}` : x + y),
    "-": (x, y) => x - y,
    "*": (x, y) => x * y,
    "/": (x, y) => (y === 0 ? null : x / y),
    "%": (x, y) => (y === 0 ? null : x % y),
    "<": (x, y) => x < y,
    "<=": (x, y) => x <= y,
    ">": (x, y) => x > y,
    ">=": (x, y) => x >= y,
  };

  // Compiles an AST into (row) => value. Blank (null) operands make the result null, except == != && ||.
  function compile(ast, lookup) {
    switch (ast.k) {
      case "lit": {
        const v = ast.v;
        return () => v;
      }
      case "ref": {
        const col = lookup(ast.v);
        if (col.num) {
          const num = col.num;
          return (r) => (num[r] !== num[r] ? null : num[r]);
        }
        const str = col.str;
        return (r) => (str[r] === "" ? null : str[r]);
      }
      case "un": {
        const a = compile(ast.a, lookup);
        if (ast.op === "!")
          return (r) => {
            const x = a(r);
            return x === null ? null : !x;
          };
        const sign = ast.op === "-" ? -1 : 1;
        return (r) => {
          const x = a(r);
          return x === null ? null : sign * x;
        };
      }
      case "call": {
        const fn = FUNCS[ast.fn][2];
        const args = ast.args.map((a) => compile(a, lookup));
        return (r) => {
          const vals = new Array(args.length);
          for (let i = 0; i < args.length; i++) {
            const v = args[i](r);
            if (v === null) return null;
            vals[i] = v;
          }
          return fn(...vals);
        };
      }
      default: {
        const a = compile(ast.a, lookup);
        const b = compile(ast.b, lookup);
        if (ast.op === "&&") return (r) => a(r) && b(r);
        if (ast.op === "||") return (r) => a(r) || b(r);
        if (ast.op === "==") return (r) => a(r) === b(r);
        if (ast.op === "!=") return (r) => a(r) !== b(r);
        const op = BIN[ast.op];
        return (r) => {
          const x = a(r);
          if (x === null) return null;
          const y = b(r);
          return y === null ? null : op(x, y);
        };
      }
    }
  }

  // Evaluates once per row. Booleans store as 1/0; non-finite numbers are blank. Any text result makes a text column.
  function computeColumn(id, expr, ast, src, lookup) {
    const fn = compile(ast, lookup);
    const n = src.rows;
    const out = new Array(n);
    let text = false;
    for (let r = 0; r < n; r++) {
      let v = fn(r);
      if (typeof v === "boolean") v = v ? 1 : 0;
      else if (typeof v === "number" && !Number.isFinite(v)) v = null;
      else if (typeof v === "string") text = true;
      out[r] = v;
    }
    if (text) {
      for (let r = 0; r < n; r++) out[r] = out[r] === null ? "" : String(out[r]);
      return { id, type: "string", num: null, str: out, rank: null, expr, src };
    }
    const num = new Float64Array(n);
    for (let r = 0; r < n; r++) num[r] = out[r] === null ? NaN : out[r];
    return { id, type: "number", num, str: null, rank: null, expr, src };
  }

  function exprError(id, err) {
    return new Error(`datagrid: column "${id}": ${err.message}`);
  }

  // Resolves a columns list against a source. Pure: returns { columns, computed } or throws.
  // Computed columns may reference source columns and other computed columns (no cycles).
  function resolveColumns(list, src, prev) {
    if (!Array.isArray(list)) throw new TypeError("datagrid: columns must be an array");
    const seen = new Set();
    const defs = new Map();
    const columns = [];
    for (const c of list) {
      if (!c || typeof c.id !== "string" || c.id.trim() === "")
        throw new TypeError("datagrid: every column needs an id");
      if (seen.has(c.id)) throw new Error(`datagrid: duplicate column "${c.id}"`);
      seen.add(c.id);
      const hidden = Boolean(c.hidden);
      if (c.expr === undefined) {
        const known = src.byId.get(c.id);
        if (!known) throw new Error(`datagrid: unknown column "${c.id}"`);
        columns.push({ id: c.id, width: widthOf(c.width, defaultWidth(c.id, known.type)), hidden });
      } else {
        if (typeof c.expr !== "string")
          throw new TypeError(`datagrid: expr of "${c.id}" must be a string`);
        if (src.byId.has(c.id))
          throw new Error(`datagrid: computed column "${c.id}" has the name of a data column`);
        defs.set(c.id, c.expr);
        columns.push({
          id: c.id,
          width: widthOf(c.width, Math.max(COMPUTED_WIDTH, Math.min(260, c.id.length * 7 + 76))),
          hidden,
          expr: c.expr,
        });
      }
    }
    const computed = new Map();
    const building = new Set();
    const build = (id) => {
      if (computed.has(id)) return computed.get(id);
      const expr = defs.get(id);
      if (building.has(id)) throw new Error(`datagrid: computed column "${id}" depends on itself`);
      building.add(id);
      let ast;
      try {
        ast = parseExpr(expr);
      } catch (err) {
        throw exprError(id, err);
      }
      const deps = [...refsOf(ast)];
      for (const d of deps) {
        if (!src.byId.has(d) && !defs.has(d)) {
          const hint = WORD_RE.test(d) ? "" : " (write names with spaces or symbols as [name])";
          throw new Error(`datagrid: column "${id}": unknown column "${d}"${hint}`);
        }
      }
      const lookup = (d) => src.byId.get(d) ?? build(d);
      for (const d of deps) lookup(d);
      const old = prev.get(id);
      const reuse =
        old &&
        old.src === src &&
        old.expr === expr &&
        deps.every((d) => src.byId.has(d) || computed.get(d) === prev.get(d));
      const col = reuse ? old : computeColumn(id, expr, ast, src, lookup);
      building.delete(id);
      computed.set(id, col);
      return col;
    };
    for (const id of defs.keys()) build(id);
    for (const col of src.cols) {
      if (!seen.has(col.id))
        columns.push({ id: col.id, width: defaultWidth(col.id, col.type), hidden: false });
    }
    return { columns, computed };
  }

  // Drops computed columns whose references do not exist in src (repeats, since computed can chain).
  function keepResolvable(list, src) {
    let kept = list.filter((c) => c.expr !== undefined || src.byId.has(c.id));
    const dropped = [];
    for (;;) {
      const ids = new Set(kept.map((c) => c.id));
      const bad = kept.filter(
        (c) =>
          c.expr !== undefined &&
          (src.byId.has(c.id) ||
            [...refsOf(parseExpr(c.expr))].some((d) => !ids.has(d) && !src.byId.has(d))),
      );
      if (bad.length === 0) return { kept, dropped };
      for (const c of bad) dropped.push(c.id);
      kept = kept.filter((c) => !bad.includes(c));
    }
  }

  function checkValue(v) {
    const ids = new Set(v.columns.map((c) => c.id));
    if (
      v.sort !== null &&
      (!v.sort || !ids.has(v.sort.id) || !["asc", "desc"].includes(v.sort.dir))
    ) {
      throw new Error('datagrid: sort needs a known column id and dir "asc" or "desc"');
    }
    if (!v.filters || typeof v.filters !== "object")
      throw new TypeError("datagrid: filters must be an object");
    for (const [id, text] of Object.entries(v.filters)) {
      if (!ids.has(id)) throw new Error(`datagrid: filter on unknown column "${id}"`);
      if (typeof text !== "string") throw new TypeError(`datagrid: filter "${id}" must be text`);
    }
  }

  // ---- Filtering, sorting, stats ----------------------------------------------------------------------------

  // A token is an interval [a, b). pt marks a point (a === b, inclusive). ISO years, months and days are intervals.
  function token(s, type) {
    if (s === "") return null;
    if (type === "number") {
      const v = Number(s);
      return Number.isNaN(v) ? null : { a: v, b: v, pt: true };
    }
    const m = PART_RE.exec(s);
    if (m) {
      const y = +m[1];
      if (m[2] === undefined)
        return { a: new Date(y, 0, 1).getTime(), b: new Date(y + 1, 0, 1).getTime(), pt: false };
      const mo = +m[2] - 1;
      if (m[3] === undefined)
        return { a: new Date(y, mo, 1).getTime(), b: new Date(y, mo + 1, 1).getTime(), pt: false };
      const d = +m[3];
      return { a: new Date(y, mo, d).getTime(), b: new Date(y, mo, d + 1).getTime(), pt: false };
    }
    const v = parseDate(s);
    return Number.isNaN(v) ? null : { a: v, b: v, pt: true };
  }

  // Returns null (no filter), 'invalid', or { lo, hi, not } with { v, ex } bounds (ex = exclusive).
  function parseRange(text, type) {
    let t = text.trim();
    if (t === "") return null;
    let not = false;
    if (t.startsWith("!=")) {
      not = true;
      t = t.slice(2).trim();
    }
    const dots = t.indexOf("..");
    if (dots >= 0) {
      const left = t.slice(0, dots).trim();
      const right = t.slice(dots + 2).trim();
      const lo = token(left, type);
      const hi = token(right, type);
      if ((left !== "" && lo === null) || (right !== "" && hi === null) || (!lo && !hi))
        return "invalid";
      return { lo: lo && { v: lo.a, ex: false }, hi: hi && { v: hi.b, ex: !hi.pt }, not };
    }
    const m = /^(>=|<=|>|<|=)?(.*)$/.exec(t);
    if (not && m[1]) return "invalid";
    const x = token(m[2].trim(), type);
    if (x === null) return "invalid";
    switch (m[1] ?? "=") {
      case ">=":
        return { lo: { v: x.a, ex: false }, hi: null, not };
      case ">":
        return { lo: x.pt ? { v: x.a, ex: true } : { v: x.b, ex: false }, hi: null, not };
      case "<=":
        return { lo: null, hi: { v: x.b, ex: !x.pt }, not };
      case "<":
        return { lo: null, hi: { v: x.a, ex: true }, not };
      default:
        return { lo: { v: x.a, ex: false }, hi: { v: x.b, ex: !x.pt }, not };
    }
  }

  // Returns null (no filter), 'invalid', or (row) => boolean. Blank cells never match a number or date filter.
  function predicate(col, text) {
    if (col.num) {
      const range = parseRange(text, col.type);
      if (range === null || range === "invalid") return range;
      const { lo, hi, not } = range;
      const num = col.num;
      return (r) => {
        const x = num[r];
        if (x !== x) return false;
        const inside =
          !(lo && (lo.ex ? x <= lo.v : x < lo.v)) && !(hi && (hi.ex ? x >= hi.v : x > hi.v));
        return inside !== not;
      };
    }
    const t = text.trim();
    if (t === "") return null;
    const str = col.str;
    if (t.startsWith("!=")) {
      const q = t.slice(2).trim().toLowerCase();
      return (r) => str[r].toLowerCase() !== q;
    }
    if (t[0] === "=") {
      const q = t.slice(1).trim().toLowerCase();
      return (r) => str[r].toLowerCase() === q;
    }
    const q = t.toLowerCase();
    return (r) => str[r].toLowerCase().includes(q);
  }

  // Collation ranks for a text column, built once per column on first sort.
  function ranksOf(col) {
    if (col.rank) return col.rank;
    const uniq = [...new Set(col.str)].sort(COLLATOR.compare);
    const at = new Map();
    for (let i = 0; i < uniq.length; i++) at.set(uniq[i], i);
    const rank = new Int32Array(col.str.length);
    for (let r = 0; r < rank.length; r++) rank[r] = at.get(col.str[r]);
    col.rank = rank;
    return rank;
  }

  // Blank values sort last in both directions; ties keep source order.
  function comparator(col, dir) {
    if (col.num) {
      const num = col.num;
      return (a, b) => {
        const x = num[a];
        const y = num[b];
        if (x !== x || y !== y) return x !== x && y !== y ? a - b : x !== x ? 1 : -1;
        return (x < y ? -dir : x > y ? dir : 0) || a - b;
      };
    }
    const str = col.str;
    const rank = ranksOf(col);
    return (a, b) => {
      const ma = str[a] === "";
      const mb = str[b] === "";
      if (ma || mb) return ma && mb ? a - b : ma ? 1 : -1;
      return (rank[a] - rank[b]) * dir || a - b;
    };
  }

  function statsOf(col, order) {
    if (col.num) {
      let count = 0;
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      for (const r of order) {
        const x = col.num[r];
        if (x !== x) continue;
        count++;
        sum += x;
        if (x < min) min = x;
        if (x > max) max = x;
      }
      const empty = order.length - count;
      if (count === 0)
        return col.type === "number"
          ? { count, empty, min: null, max: null, sum: 0, mean: null }
          : { count, empty, min: null, max: null };
      return col.type === "number"
        ? { count, empty, min, max, sum, mean: sum / count }
        : { count, empty, min, max };
    }
    const freq = new Map();
    let count = 0;
    for (const r of order) {
      const s = col.str[r];
      if (s === "") continue;
      count++;
      freq.set(s, (freq.get(s) || 0) + 1);
    }
    let top = null;
    let best = 0;
    for (const [s, k] of freq) {
      if (k > best) {
        best = k;
        top = s;
      }
    }
    return { count, empty: order.length - count, distinct: freq.size, top };
  }

  function statHTML(s, type) {
    if (s.count === 0) return "<span>no values</span>";
    if (type === "number")
      return `<span>avg <b>${NF.format(s.mean)}</b></span><span>${NF.format(s.min)} to ${NF.format(s.max)}</span>`;
    if (type === "date")
      return `<span><b>${dayText(s.min)}</b></span><span>to ${dayText(s.max)}</span>`;
    const top = s.distinct === s.count ? "all unique" : `top ${esc(s.top)}`;
    return `<span><b>${NF.format(s.distinct)}</b> distinct</span><span>${top}</span>`;
  }

  function statTitle(s, type) {
    const blank = `${NF.format(s.empty)} blank`;
    if (s.count === 0) return blank;
    if (type === "number") {
      return `${NF.format(s.count)} values, ${blank}\nmin ${s.min}\nmax ${s.max}\nsum ${NF.format(s.sum)}\nmean ${s.mean}`;
    }
    if (type === "date")
      return `${NF.format(s.count)} values, ${blank}\n${new Date(s.min).toString()}\n${new Date(s.max).toString()}`;
    return `${NF.format(s.count)} values, ${blank}\n${NF.format(s.distinct)} distinct\nmost common: ${s.top}`;
  }

  function sameSet(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }

  // "name = expression" from the toolbar field. The first lone '=' splits; == != <= >= stay in the expression.
  function splitDefinition(text) {
    const m = /^\s*([^=<>!]+?)\s*=(?!=)\s*([\s\S]*)$/.exec(text);
    if (!m) throw new Error("Write the column as  name = expression");
    const id = m[1].replace(/^\[(.*)\]$/, "$1").trim();
    const expr = m[2].trim();
    if (id === "") throw new Error("Name the column before the =");
    if (expr === "") throw new Error("Write an expression after the =");
    return { id, expr };
  }

  t3kit.datagrid = {
    create(container, options = {}) {
      const rh = options.rowHeight ?? 28;
      if (!Number.isInteger(rh) || rh < ROW_MIN || rh > ROW_MAX) {
        throw new RangeError("datagrid: rowHeight must be an integer 20..48");
      }
      const mode = options.selection ?? "multi";
      if (!["multi", "single", "none"].includes(mode)) {
        throw new RangeError("datagrid: selection must be multi, single or none");
      }
      injectStyle();

      const root = document.createElement("div");
      root.className = "t3k-datagrid-root";
      root.innerHTML = `
<div class="t3k-datagrid-bar"${options.toolbar === false ? " hidden" : ""}>
  <span class="t3k-datagrid-status" aria-live="polite">No data</span>
  <form class="t3k-datagrid-addform">
    <input class="t3k-datagrid-input" name="def" placeholder="kmh = distance_km / duration_min * 60" aria-label="New computed column, name = expression" autocomplete="off" spellcheck="false" disabled>
    <button type="submit" class="t3k-datagrid-btn" disabled>Add column</button>
  </form>
  <details class="t3k-datagrid-menu"><summary class="t3k-datagrid-btn" aria-haspopup="true">Columns</summary><div class="t3k-datagrid-pop" role="group" aria-label="Columns"></div></details>
  <div class="t3k-datagrid-err" role="alert" hidden></div>
</div>
<div class="t3k-datagrid-scroll" role="grid" tabindex="0" aria-label="Data grid" aria-multiselectable="${mode === "multi"}">
  <div class="t3k-datagrid-head" role="row"></div>
  <div class="t3k-datagrid-filters" role="row"></div>
  <div class="t3k-datagrid-body" role="rowgroup"><div class="t3k-datagrid-win"></div></div>
  <div class="t3k-datagrid-foot" role="row"${options.stats === false ? " hidden" : ""}></div>
</div>
<div class="t3k-datagrid-drop" hidden></div>
<div class="t3k-datagrid-empty">Load a CSV or JSON file to see rows</div>`;
      container.appendChild(root);

      const q = (sel) => root.querySelector(sel);
      const scroll = q(".t3k-datagrid-scroll");
      const head = q(".t3k-datagrid-head");
      const filters = q(".t3k-datagrid-filters");
      const body = q(".t3k-datagrid-body");
      const win = q(".t3k-datagrid-win");
      const foot = q(".t3k-datagrid-foot");
      const status = q(".t3k-datagrid-status");
      const menu = q(".t3k-datagrid-menu");
      const pop = q(".t3k-datagrid-pop");
      const form = q(".t3k-datagrid-addform");
      const defIn = form.querySelector("input");
      const addBtn = form.querySelector("button");
      const errBox = q(".t3k-datagrid-err");
      const drop = q(".t3k-datagrid-drop");
      const empty = q(".t3k-datagrid-empty");
      const showStats = options.stats !== false;

      const S = {
        src: null,
        spec: { sort: null, filters: {}, columns: [] },
        computed: new Map(),
        layout: [],
        view: [],
        invalid: new Set(),
        statsCache: new Map(),
        sel: new Set(),
        active: -1,
        anchor: -1,
        rowKey: "",
        rowRaf: 0,
        filterTimer: 0,
        loadToken: 0,
        restrict: null,
        resize: null,
        reorder: null,
        skipClick: false,
        subs: { change: new Set(), filter: new Set(), select: new Set() },
        destroyed: false,
      };

      const specOf = (id) => S.spec.columns.find((c) => c.id === id);
      const colOf = (id) => S.src.byId.get(id) ?? S.computed.get(id);
      const selection = () => [...S.sel].sort((a, b) => a - b);
      const snapshot = () => ({
        sort: S.spec.sort ? { ...S.spec.sort } : null,
        filters: { ...S.spec.filters },
        columns: S.spec.columns.map((c) => {
          const out = {
            id: c.id,
            type: S.src ? colOf(c.id).type : null,
            width: c.width,
            hidden: c.hidden,
          };
          if (c.expr !== undefined) out.expr = c.expr;
          return out;
        }),
      });
      const emit = (name, payload) => {
        for (const cb of S.subs[name]) cb(payload);
      };
      const emitChange = (filterChanged) => {
        emit("change", snapshot());
        if (filterChanged) emit("filter", { filters: { ...S.spec.filters }, rows: S.view.length });
      };
      const emitSelect = () => emit("select", selection());
      const requireData = () => {
        if (!S.src) throw new Error("datagrid: no data loaded");
      };

      // ---- View pipeline -----------------------------------------------------------------------------------

      // Source rows that pass every filter, ascending; ids whose text does not parse go into `invalid` (then none pass).
      function matchRows(filters, invalid, restricted = true) {
        const tests = [];
        for (const [id, text] of Object.entries(filters)) {
          const test = predicate(colOf(id), text);
          if (test === "invalid") invalid.add(id);
          else if (test) tests.push(test);
        }
        const order = [];
        if (invalid.size === 0) {
          for (let r = 0; r < S.src.rows; r++) {
            if (restricted && S.restrict !== null && S.restrict[r] === 0) continue;
            let ok = true;
            for (let t = 0; t < tests.length; t++) {
              if (!tests[t](r)) {
                ok = false;
                break;
              }
            }
            if (ok) order.push(r);
          }
        }
        return order;
      }

      function rebuildView() {
        S.invalid = new Set();
        S.statsCache = new Map();
        const order = matchRows(S.spec.filters, S.invalid);
        if (S.spec.sort)
          order.sort(comparator(colOf(S.spec.sort.id), S.spec.sort.dir === "desc" ? -1 : 1));
        S.view = order;
        if (S.active >= order.length) S.active = order.length - 1;
      }

      function statsFor(id) {
        if (!S.statsCache.has(id)) S.statsCache.set(id, statsOf(colOf(id), S.view));
        return S.statsCache.get(id);
      }

      function refresh({ view = false, layout = false } = {}) {
        if (!S.src) return;
        if (view) rebuildView();
        if (layout) {
          renderHead();
          renderMenu();
        }
        renderFoot();
        sizeLayout();
        syncHead();
        syncFilters();
        renderRows(true);
        renderStatus();
      }

      // Replaces the layout (validated first, so a bad list leaves the grid unchanged) and repaints.
      function applyColumns(columns, extra = {}) {
        const r = resolveColumns(columns, S.src, S.computed);
        const next = { ...S.spec, ...extra, columns: r.columns };
        checkValue(next);
        S.spec = next;
        S.computed = r.computed;
        refresh({ view: true, layout: true });
      }

      // ---- Rendering ---------------------------------------------------------------------------------------

      function renderHead() {
        const vis = S.spec.columns.filter((c) => !c.hidden);
        head.innerHTML = vis
          .map((spec) => {
            const col = colOf(spec.id);
            const id = esc(spec.id);
            const fx = spec.expr !== undefined;
            const title = fx ? `${spec.id} = ${spec.expr}` : `${spec.id} (${col.type})`;
            return (
              `<div class="t3k-datagrid-th" role="columnheader" data-col="${id}" title="${esc(title)}">` +
              `<button type="button" class="t3k-datagrid-sort" data-sort="${id}"><span class="t3k-datagrid-name">${id}</span><span class="t3k-datagrid-arrow" aria-hidden="true"></span></button>` +
              `<span class="t3k-datagrid-type${fx ? " is-fx" : ""}">${fx ? "ƒ " : ""}${TYPE_LABEL[col.type]}</span>` +
              `<span class="t3k-datagrid-grip" data-grip="${id}" aria-hidden="true"></span></div>`
            );
          })
          .join("");
        filters.innerHTML = vis
          .map((spec) => {
            const id = esc(spec.id);
            const text = S.spec.filters[spec.id] ?? "";
            return (
              `<div class="t3k-datagrid-fcell" data-col="${id}"><input class="t3k-datagrid-input" data-filter="${id}" ` +
              `aria-label="Filter ${id}" placeholder="${PLACEHOLDER[colOf(spec.id).type]}" value="${esc(text)}" autocomplete="off" spellcheck="false"></div>`
            );
          })
          .join("");
      }

      function renderMenu() {
        pop.innerHTML = S.spec.columns
          .map((spec) => {
            const id = esc(spec.id);
            const rm =
              spec.expr !== undefined
                ? `<button type="button" class="t3k-datagrid-btn" data-rm="${id}" aria-label="Remove ${id}">Remove</button>`
                : "";
            return (
              `<div class="t3k-datagrid-opt"><label><input type="checkbox" data-vis="${id}" ${spec.hidden ? "" : "checked"}>` +
              `<span>${id}</span> <small>${TYPE_LABEL[colOf(spec.id).type]}</small></label>${rm}</div>`
            );
          })
          .join("");
      }

      function sizeLayout() {
        let x = 0;
        S.layout = [];
        for (const spec of S.spec.columns) {
          if (spec.hidden) continue;
          S.layout.push({ spec, col: colOf(spec.id), x, w: spec.width });
          x += spec.width;
        }
        const w = `max(100%, ${x}px)`;
        head.style.width = w;
        filters.style.width = w;
        foot.style.width = w;
        body.style.width = w;
        for (const el of root.querySelectorAll("[data-col]"))
          el.style.width = `${specOf(el.dataset.col).width}px`;
      }

      function syncHead() {
        const s = S.spec.sort;
        for (const btn of head.querySelectorAll("[data-sort]")) {
          const on = s !== null && s.id === btn.dataset.sort;
          btn.querySelector(".t3k-datagrid-arrow").textContent = on
            ? s.dir === "asc"
              ? "↑"
              : "↓"
            : "";
          btn.parentElement.setAttribute(
            "aria-sort",
            on ? (s.dir === "asc" ? "ascending" : "descending") : "none",
          );
        }
      }

      function syncFilters() {
        for (const input of filters.querySelectorAll("[data-filter]")) {
          const bad = S.invalid.has(input.dataset.filter);
          input.setAttribute("aria-invalid", String(bad));
          input.title = bad ? "Filter not understood; no rows match" : "";
        }
      }

      // Renders only the rows and columns in the viewport (plus overscan).
      function renderRows(force) {
        const n = S.view.length;
        body.style.height = `${n * rh}px`;
        scroll.setAttribute("aria-rowcount", String(n + 1));
        if (n === 0 || S.layout.length === 0) {
          win.innerHTML = "";
          S.rowKey = "";
          return;
        }
        const top = scroll.scrollTop - body.offsetTop;
        const first = Math.max(0, Math.floor(top / rh) - OVERSCAN);
        const last = Math.min(n, Math.ceil((top + scroll.clientHeight) / rh) + OVERSCAN);
        const left = scroll.scrollLeft;
        const right = left + scroll.clientWidth;
        const L = S.layout;
        let c0 = 0;
        while (c0 < L.length - 1 && L[c0].x + L[c0].w <= left) c0++;
        let c1 = c0;
        while (c1 < L.length && L[c1].x < right) c1++;
        c0 = Math.max(0, c0 - COL_OVERSCAN);
        c1 = Math.min(L.length, c1 + COL_OVERSCAN);
        const key = `${first}:${last}:${c0}:${c1}`;
        if (!force && key === S.rowKey) return;
        S.rowKey = key;
        const cols = L.slice(c0, c1);
        const padX = L[c0].x;
        let html = "";
        for (let i = first; i < last; i++) html += rowHTML(i, cols, padX);
        win.innerHTML = html;
        win.style.transform = `translateY(${first * rh}px)`;
      }

      function rowHTML(i, cols, padX) {
        const r = S.view[i];
        const picked = S.sel.has(r);
        const cls = `t3k-datagrid-row${picked ? " is-selected" : ""}${i === S.active ? " is-active" : ""}`;
        let h = `<div class="${cls}" role="row" data-i="${i}" aria-rowindex="${i + 2}" aria-selected="${picked}" style="height:${rh}px">`;
        if (padX) h += `<div class="t3k-datagrid-pad" style="width:${padX}px"></div>`;
        for (const { col, w } of cols) {
          let text;
          if (col.str) text = col.str[r];
          else text = col.num[r] !== col.num[r] ? "" : CELL_NF.format(col.num[r]);
          const num = col.type === "number" ? " is-num" : "";
          h += `<div class="t3k-datagrid-cell${num}" role="gridcell" style="width:${w}px">${esc(text)}</div>`;
        }
        return `${h}</div>`;
      }

      function renderFoot() {
        if (!showStats) return;
        foot.innerHTML = S.spec.columns
          .filter((c) => !c.hidden)
          .map((spec) => {
            const col = colOf(spec.id);
            const s = statsFor(spec.id);
            return `<div class="t3k-datagrid-stat" data-col="${esc(spec.id)}" title="${esc(statTitle(s, col.type))}">${statHTML(s, col.type)}</div>`;
          })
          .join("");
      }

      function renderStatus() {
        if (!S.src) {
          status.textContent = "No data";
          return;
        }
        const parts = [`${NF.format(S.view.length)} of ${NF.format(S.src.rows)} rows`];
        if (S.sel.size) parts.push(`${NF.format(S.sel.size)} selected`);
        const nf = Object.keys(S.spec.filters).length;
        if (nf) parts.push(`${nf} filter${nf > 1 ? "s" : ""}`);
        if (S.invalid.size) parts.push("filter not understood");
        status.textContent = parts.join(" · ");
      }

      function queueRows() {
        if (S.rowRaf) return;
        S.rowRaf = requestAnimationFrame(() => {
          S.rowRaf = 0;
          renderRows(false);
        });
      }

      function ensureVisible(i) {
        const top = body.offsetTop + i * rh;
        const bottom = top + rh;
        const stickyTop = head.offsetHeight + filters.offsetHeight;
        const stickyBottom = foot.offsetHeight;
        if (top < scroll.scrollTop + stickyTop) scroll.scrollTop = top - stickyTop;
        else if (bottom > scroll.scrollTop + scroll.clientHeight - stickyBottom) {
          scroll.scrollTop = bottom - scroll.clientHeight + stickyBottom;
        }
      }

      function showError(msg) {
        errBox.textContent = msg;
        errBox.hidden = msg === "";
        defIn.setAttribute("aria-invalid", String(msg !== ""));
      }

      // ---- Interaction: selection --------------------------------------------------------------------------

      function choose(i, e) {
        const r = S.view[i];
        const prev = S.sel;
        let next;
        if (mode === "none") next = prev;
        else if (mode === "single") next = e.toggle && prev.has(r) ? new Set() : new Set([r]);
        else if (e.shift && S.anchor >= 0) {
          next = new Set(S.view.slice(Math.min(S.anchor, i), Math.max(S.anchor, i) + 1));
        } else if (e.toggle) {
          next = new Set(prev);
          if (next.has(r)) next.delete(r);
          else next.add(r);
        } else next = new Set([r]);
        if (!e.shift || S.anchor < 0) S.anchor = i;
        S.active = i;
        const changed = !sameSet(prev, next);
        S.sel = next;
        renderRows(true);
        renderStatus();
        if (changed) emitSelect();
      }

      function selectAll() {
        if (mode !== "multi" || S.view.length === 0) return;
        const prev = S.sel;
        S.sel = new Set(S.view);
        renderRows(true);
        renderStatus();
        if (!sameSet(prev, S.sel)) emitSelect();
      }

      function clearSelection() {
        if (S.sel.size === 0) return;
        S.sel = new Set();
        renderRows(true);
        renderStatus();
        emitSelect();
      }

      // ---- Interaction: columns ----------------------------------------------------------------------------

      function cycleSort(id) {
        const s = S.spec.sort;
        const sort =
          !s || s.id !== id ? { id, dir: "asc" } : s.dir === "asc" ? { id, dir: "desc" } : null;
        applyColumns(S.spec.columns, { sort });
        emitChange(false);
        head.querySelector(`[data-sort="${CSS.escape(id)}"]`)?.focus();
      }

      function moveColumn(id, delta) {
        const vis = S.spec.columns.filter((c) => !c.hidden);
        const at = vis.findIndex((c) => c.id === id);
        const to = at + delta;
        if (to < 0 || to >= vis.length) return;
        moveBefore(id, delta < 0 ? vis[to].id : (vis[to + 1]?.id ?? null));
        head.querySelector(`[data-sort="${CSS.escape(id)}"]`)?.focus();
      }

      // Moves column `from` before column `to` (null = last). Emits change when the order changed.
      function moveBefore(from, to) {
        const before = S.spec.columns.map((c) => c.id).join("\n");
        const moved = specOf(from);
        const cols = S.spec.columns.filter((c) => c.id !== from);
        const at = to === null ? cols.length : cols.findIndex((c) => c.id === to);
        cols.splice(at, 0, moved);
        if (cols.map((c) => c.id).join("\n") === before) return;
        applyColumns(cols);
        emitChange(false);
      }

      function removeComputed(id) {
        const spec = specOf(id);
        if (!spec || spec.expr === undefined)
          throw new Error(`datagrid: "${id}" is not a computed column`);
        const users = S.spec.columns.filter(
          (c) => c.expr !== undefined && c.id !== id && refsOf(parseExpr(c.expr)).has(id),
        );
        if (users.length)
          throw new Error(`datagrid: "${users[0].id}" uses "${id}"; remove it first`);
        const nextFilters = { ...S.spec.filters };
        delete nextFilters[id];
        const sort = S.spec.sort && S.spec.sort.id === id ? null : S.spec.sort;
        const filtered = id in S.spec.filters;
        applyColumns(
          S.spec.columns.filter((c) => c.id !== id),
          { filters: nextFilters, sort },
        );
        return filtered;
      }

      function addComputed({ id, expr, width, after }) {
        requireData();
        if (typeof id !== "string" || id.trim() === "")
          throw new TypeError("datagrid: addColumn needs an id");
        if (typeof expr !== "string")
          throw new TypeError("datagrid: addColumn needs an expr string");
        if (specOf(id)) throw new Error(`datagrid: column "${id}" already exists`);
        const cols = [...S.spec.columns];
        let at = cols.length;
        if (after !== undefined) {
          at = cols.findIndex((c) => c.id === after) + 1;
          if (at === 0) throw new Error(`datagrid: unknown column "${after}"`);
        }
        const def = { id, expr, hidden: false };
        if (width !== undefined) def.width = width;
        cols.splice(at, 0, def);
        applyColumns(cols);
        return colOf(id).type;
      }

      // Header gestures: the right-edge grip resizes, the rest of the header drags to reorder.
      // Both update at most once per animation frame and commit on release.
      function flushResize() {
        const d = S.resize;
        if (!d) return;
        d.raf = 0;
        specOf(d.id).width = clamp(Math.round(d.w0 + d.x - d.x0), MIN_W, MAX_W);
        sizeLayout();
        renderRows(true);
      }

      function endResize() {
        const d = S.resize;
        cancelAnimationFrame(d.raf);
        flushResize();
        S.resize = null;
        if (specOf(d.id).width !== d.w0) {
          renderFoot();
          sizeLayout();
          emitChange(false);
        }
      }

      // Insertion point for a header drag: before the first header whose midpoint is right of x (null = last).
      function reorderTarget(x) {
        for (const th of head.children) {
          const r = th.getBoundingClientRect();
          if (x < r.left + r.width / 2) return { id: th.dataset.col, edge: r.left };
        }
        const lastTh = head.lastElementChild;
        return { id: null, edge: lastTh.getBoundingClientRect().right };
      }

      function flushReorder() {
        const d = S.reorder;
        if (!d) return;
        d.raf = 0;
        const t = reorderTarget(d.x);
        const box = root.getBoundingClientRect();
        const hb = head.getBoundingClientRect();
        drop.style.left = `${t.edge - box.left - 1}px`;
        drop.style.top = `${hb.top - box.top}px`;
        drop.style.height = `${hb.height}px`;
        drop.hidden = false;
      }

      function endReorder(commit) {
        const d = S.reorder;
        S.reorder = null;
        cancelAnimationFrame(d.raf);
        drop.hidden = true;
        if (!d.active) return;
        d.th.classList.remove("is-dragging");
        S.skipClick = true;
        if (commit) {
          const t = reorderTarget(d.x);
          if (t.id !== d.id) moveBefore(d.id, t.id);
        }
      }

      // ---- Events ------------------------------------------------------------------------------------------

      scroll.addEventListener("scroll", queueRows, { passive: true });
      const ro = new ResizeObserver(() => renderRows(true));
      ro.observe(scroll);

      head.addEventListener("click", (e) => {
        if (S.skipClick) {
          S.skipClick = false;
          return;
        }
        const btn = e.target.closest("[data-sort]");
        if (btn) cycleSort(btn.dataset.sort);
      });

      head.addEventListener("keydown", (e) => {
        if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        const btn = e.target.closest("[data-sort]");
        if (!btn) return;
        e.preventDefault();
        moveColumn(btn.dataset.sort, e.key === "ArrowLeft" ? -1 : 1);
      });

      head.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        S.skipClick = false;
        const grip = e.target.closest(".t3k-datagrid-grip");
        if (grip) {
          e.preventDefault();
          const spec = specOf(grip.dataset.grip);
          S.resize = { id: spec.id, x0: e.clientX, x: e.clientX, w0: spec.width, raf: 0 };
          grip.setPointerCapture(e.pointerId);
          return;
        }
        const th = e.target.closest(".t3k-datagrid-th");
        if (th)
          S.reorder = {
            id: th.dataset.col,
            th,
            pointerId: e.pointerId,
            x0: e.clientX,
            x: e.clientX,
            active: false,
            raf: 0,
          };
      });
      head.addEventListener("pointermove", (e) => {
        if (S.resize) {
          S.resize.x = e.clientX;
          if (!S.resize.raf) S.resize.raf = requestAnimationFrame(flushResize);
          return;
        }
        const d = S.reorder;
        if (!d || e.pointerId !== d.pointerId) return;
        d.x = e.clientX;
        if (!d.active) {
          if (Math.abs(d.x - d.x0) < DRAG_START) return;
          d.active = true;
          d.th.setPointerCapture(d.pointerId);
          d.th.classList.add("is-dragging");
        }
        if (!d.raf) d.raf = requestAnimationFrame(flushReorder);
      });
      head.addEventListener("pointerup", () => {
        if (S.resize) endResize();
        else if (S.reorder) endReorder(true);
      });
      head.addEventListener("pointercancel", () => {
        if (S.resize) endResize();
        else if (S.reorder) endReorder(false);
      });

      filters.addEventListener("input", (e) => {
        const id = e.target.dataset.filter;
        if (id === undefined) return;
        const f = { ...S.spec.filters };
        if (e.target.value.trim() === "") delete f[id];
        else f[id] = e.target.value;
        S.spec = { ...S.spec, filters: f };
        clearTimeout(S.filterTimer);
        S.filterTimer = setTimeout(() => {
          S.filterTimer = 0;
          refresh({ view: true });
          emitChange(true);
        }, 120);
      });

      body.addEventListener("click", (e) => {
        const row = e.target.closest(".t3k-datagrid-row");
        if (!row) return;
        choose(Number(row.dataset.i), { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
        scroll.focus({ preventScroll: true });
      });

      scroll.addEventListener("keydown", (e) => {
        if (e.target !== scroll || S.view.length === 0) return;
        const n = S.view.length;
        const page = Math.max(1, Math.floor(scroll.clientHeight / rh) - 3);
        const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
        if (e.key in moves || e.key === "Home" || e.key === "End") {
          e.preventDefault();
          const i = clamp(
            e.key === "Home" ? 0 : e.key === "End" ? n - 1 : S.active + moves[e.key],
            0,
            n - 1,
          );
          if (e.shiftKey && mode === "multi") {
            choose(i, { shift: true });
          } else {
            S.active = i;
            renderRows(true);
          }
          ensureVisible(i);
        } else if (e.key === " " && S.active >= 0) {
          e.preventDefault();
          choose(S.active, { toggle: true });
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
          e.preventDefault();
          selectAll();
        } else if (e.key === "Escape") {
          clearSelection();
        }
      });

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        let def;
        try {
          def = splitDefinition(defIn.value);
          addComputed(def);
        } catch (err) {
          showError(err.message.replace(/^datagrid: /, ""));
          return;
        }
        defIn.value = "";
        showError("");
        emitChange(false);
      });
      defIn.addEventListener("input", () => {
        if (!errBox.hidden) showError("");
      });

      const closeMenuOutside = (e) => {
        if (!menu.contains(e.target)) menu.open = false;
      };
      menu.addEventListener("toggle", () => {
        if (menu.open) document.addEventListener("pointerdown", closeMenuOutside);
        else document.removeEventListener("pointerdown", closeMenuOutside);
      });

      pop.addEventListener("change", (e) => {
        const id = e.target.dataset.vis;
        if (id === undefined) return;
        const shown = S.spec.columns.filter((c) => !c.hidden).length;
        if (!e.target.checked && shown === 1) {
          e.target.checked = true;
          return;
        }
        const hidden = !e.target.checked;
        applyColumns(S.spec.columns.map((c) => (c.id === id ? { ...c, hidden } : c)));
        emitChange(false);
      });

      pop.addEventListener("click", (e) => {
        const id = e.target.dataset.rm;
        if (id === undefined) return;
        let filtered;
        try {
          filtered = removeComputed(id);
        } catch (err) {
          showError(err.message.replace(/^datagrid: /, ""));
          return;
        }
        showError("");
        emitChange(filtered);
      });

      // ---- Instance ----------------------------------------------------------------------------------------

      const instance = {
        async load(source, options = {}) {
          const format = options.format ?? "auto";
          const mergeOn = options.mergeOn ?? null;
          if (!FORMATS.includes(format))
            throw new RangeError(`datagrid: format must be one of ${FORMATS.join(", ")}`);
          if (mergeOn !== null && typeof mergeOn !== "string")
            throw new TypeError("datagrid: mergeOn must be a column id or null");
          const token = ++S.loadToken;
          status.textContent = "Loading…";
          let table;
          try {
            table = await readTable(source, { format, mergeOn });
          } catch (err) {
            if (token === S.loadToken) renderStatus();
            throw err;
          }
          if (token !== S.loadToken || S.destroyed) return null;
          const src = buildSource(table);
          src.raw = table.raw ?? null;
          const prev = S.spec;
          const { kept, dropped } = keepResolvable(prev.columns, src);
          const ids = new Set(kept.map((c) => c.id));
          const r = resolveColumns(kept, src, new Map());
          const next = {
            sort: prev.sort && ids.has(prev.sort.id) ? prev.sort : null,
            filters: Object.fromEntries(Object.entries(prev.filters).filter(([id]) => ids.has(id))),
            columns: r.columns,
          };
          checkValue(next);
          S.src = src;
          S.restrict = null;
          S.computed = r.computed;
          S.spec = next;
          S.sel = new Set();
          S.active = -1;
          S.anchor = -1;
          empty.hidden = true;
          defIn.disabled = false;
          addBtn.disabled = false;
          scroll.scrollTop = 0;
          refresh({ view: true, layout: true });
          return { rows: src.rows, columns: src.cols.map((c) => c.id), dropped };
        },

        get: snapshot,

        set(partial) {
          if (!partial || typeof partial !== "object")
            throw new TypeError("datagrid: set() takes an object");
          for (const key of Object.keys(partial)) {
            if (!["sort", "filters", "columns"].includes(key))
              throw new Error(`datagrid: unknown value key "${key}"`);
          }
          const next = { sort: S.spec.sort, filters: S.spec.filters, columns: S.spec.columns };
          let computed = S.computed;
          if ("sort" in partial) {
            const s = partial.sort;
            if (s !== null && (typeof s !== "object" || typeof s.id !== "string"))
              throw new TypeError("datagrid: sort must be { id, dir } or null");
            next.sort = s === null ? null : { id: s.id, dir: s.dir };
          }
          if ("filters" in partial) {
            if (!partial.filters || typeof partial.filters !== "object")
              throw new TypeError("datagrid: filters must be an object");
            next.filters = Object.fromEntries(
              Object.entries(partial.filters).filter(
                ([, t]) => typeof t !== "string" || t.trim() !== "",
              ),
            );
          }
          if ("columns" in partial) {
            if (S.src) {
              const r = resolveColumns(partial.columns, S.src, S.computed);
              next.columns = r.columns;
              computed = r.computed;
            } else {
              if (!Array.isArray(partial.columns))
                throw new TypeError("datagrid: columns must be an array");
              next.columns = partial.columns.map((c) => {
                const out = { id: c.id, width: c.width, hidden: Boolean(c.hidden) };
                if (c.expr !== undefined) out.expr = c.expr;
                return out;
              });
            }
          }
          if (S.src) checkValue(next);
          S.spec = next;
          S.computed = computed;
          refresh({ view: true, layout: true });
        },

        addColumn(def) {
          if (!def || typeof def !== "object")
            throw new TypeError("datagrid: addColumn takes { id, expr }");
          return addComputed(def);
        },

        removeColumn(id) {
          requireData();
          removeComputed(id);
        },

        selection() {
          return selection();
        },

        select(indices) {
          if (!Array.isArray(indices))
            throw new TypeError("datagrid: select() takes an array of row indices");
          const n = S.src ? S.src.rows : 0;
          for (const r of indices) {
            if (!Number.isInteger(r) || r < 0 || r >= n)
              throw new RangeError(`datagrid: row ${r} is out of range`);
          }
          if (mode === "none" && indices.length) throw new Error("datagrid: selection is off");
          if (mode === "single" && indices.length > 1)
            throw new Error("datagrid: single selection takes one row");
          S.sel = new Set(indices);
          renderRows(true);
          renderStatus();
        },

        row(index) {
          requireData();
          if (!Number.isInteger(index) || index < 0 || index >= S.src.rows)
            throw new RangeError(`datagrid: row ${index} is out of range`);
          const out = {};
          for (const spec of S.spec.columns) {
            const col = colOf(spec.id);
            if (col.type === "number")
              out[spec.id] = col.num[index] !== col.num[index] ? null : col.num[index];
            else out[spec.id] = col.str[index] === "" ? null : col.str[index];
          }
          return out;
        },

        view() {
          requireData();
          return S.view.slice();
        },

        column(id) {
          requireData();
          const col = S.src.byId.get(id);
          if (!col) throw new Error(`datagrid: no source column "${id}"`);
          return col.str.slice();
        },

        raw(index) {
          requireData();
          if (!Number.isInteger(index) || index < 0 || index >= S.src.rows)
            throw new RangeError(`datagrid: raw() row ${index} is out of range`);
          return S.src.raw ? S.src.raw[index] : null;
        },

        restrict(rows) {
          requireData();
          if (rows === null) S.restrict = null;
          else {
            if (!Array.isArray(rows) && !(rows instanceof Uint32Array))
              throw new TypeError("datagrid: restrict() takes row indices or null");
            const mask = new Uint8Array(S.src.rows);
            for (const r of rows) {
              if (!Number.isInteger(r) || r < 0 || r >= S.src.rows)
                throw new RangeError(`datagrid: restrict() row ${r} is out of range`);
              mask[r] = 1;
            }
            S.restrict = mask;
          }
          refresh({ view: true });
        },

        match(filters) {
          requireData();
          if (!filters || typeof filters !== "object" || Array.isArray(filters))
            throw new TypeError("datagrid: match() takes a { [id]: text } object");
          for (const [id, text] of Object.entries(filters)) {
            if (!S.spec.columns.some((c) => c.id === id))
              throw new Error(`datagrid: match() has no column "${id}"`);
            if (typeof text !== "string")
              throw new TypeError(`datagrid: match() filter "${id}" must be text`);
          }
          return matchRows(filters, new Set(), false);
        },

        stats() {
          requireData();
          const columns = {};
          for (const spec of S.spec.columns) columns[spec.id] = statsFor(spec.id);
          return { rows: S.view.length, total: S.src.rows, columns };
        },

        on(name, cb) {
          if (!EVENTS.includes(name)) throw new Error(`datagrid: unknown event "${name}"`);
          if (typeof cb !== "function") throw new TypeError("datagrid: on() needs a callback");
          S.subs[name].add(cb);
          return () => S.subs[name].delete(cb);
        },

        destroy() {
          if (S.destroyed) return;
          S.destroyed = true;
          cancelAnimationFrame(S.rowRaf);
          if (S.resize) cancelAnimationFrame(S.resize.raf);
          if (S.reorder) cancelAnimationFrame(S.reorder.raf);
          clearTimeout(S.filterTimer);
          document.removeEventListener("pointerdown", closeMenuOutside);
          ro.disconnect();
          for (const set of Object.values(S.subs)) set.clear();
          root.remove();
        },
      };
      return instance;
    },
  };
})();
