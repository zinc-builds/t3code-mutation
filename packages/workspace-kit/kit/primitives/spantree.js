/**
 * t3kit.spantree: zoomable canvas of nested timed spans. One model, five views: trace waterfall,
 * flame chart (by time), flame graph (merged stacks), icicle, inverted. Parsing yields in chunks.
 * create(container, options?) -> instance
 *   view 'waterfall'|'flamechart'|'flamegraph'|'icicle'|'inverted' (default: waterfall for spans,
 *   flamechart for profiles) · metric 'total'|'self' (merged views shade self) · minPx 0.5 (cull
 *   narrower frames) · rowHeight 16..28 (18) · colorBy 'name'|'service'|'module'|'delta'
 * load(source, {format:'auto'|'chrome'|'cpuprofile'|'speedscope'|'otlp'|'spans'|'jsonl'})
 *   -> Promise<{format, spans:count, roots:[id], start, end, unit:'ms'}>. source: Blob|File|text|object.
 *   Times are rebased so the first span starts at 0 ms. Generic spans: [{id, parentId|null, name,
 *   start, dur, service?, file?, attrs?, trace?, error?}] in ms. jsonl lines: span_id, parent_span_id,
 *   trace_id, ts, duration_ms, name, service?. Chrome X and B/E events nest per pid/tid.
 * compare(sourceB) -> Promise<{matched, aOnly, bOnly}>  aligns by frame path, colours by delta B - A.
 * get() -> {view, metric, zoom:{id|null, from, to}, zoomPath:[{id, name}], selected, search, matches, trace, range}
 * set(partial) silent: view, metric, colorBy, search, selected, trace, minPx, rowHeight.
 * range(from, to) restricts to a window in ms; range(null) clears.
 * zoomTo(id|null) -> bool  zoom to a frame (null fits); an id already on zoomPath pops back to it. Unknown id: false.
 * locate(name) -> id|null  the widest frame of that function in the current view (for linking a table row).
 * density(bins=200, {exclude:[names]}?) -> [{from, to, ms}]  self time per bin, whole profile; exclude e.g. '(idle)'.
 * selection() -> {id, name, path:[names], selfMs, totalMs, count, service?, file?, line?, attrs?} | null
 * criticalPath(rootId?) -> [{id, name, service, start, dur}]  (child that ends last, per level)
 * top({by:'self'|'total', limit=50}) -> [{name, file?, line?, selfMs, totalMs, count, samples?, deltaMs?}]
 *   line is 1-based (cpuprofile, speedscope); samples = self samples (sampled profiles only).
 * collapsed(id?) -> Brendan Gregg collapsed stacks, weight = self time in whole microseconds
 * traces() -> [{traceId, start, dur, spans, error}] · exportPng({scale=2}) -> Promise<Blob>
 * on(event, cb) -> unsubscribe · destroy()
 * Events: 'change' get() on user zoom/pan, view, metric, colour, search · 'select' selection() ·
 *   'zoom' {id, from, to}. Ids in merged views are name paths, so selection differs per view kind.
 * Keys (canvas focused): arrows parent/child/sibling (visual direction), Enter zoom, Backspace/Esc
 *   zoom out, / search, f fit, v cycle views. Mouse: click select, dblclick zoom, drag pan,
 *   wheel scroll rows, Ctrl/Cmd/Shift+wheel zoom time at pointer. Error spans get a red edge.
 * Example:
 *   const st = t3kit.spantree.create(el);
 *   const info = await st.load(file);                // .json trace, .cpuprofile, speedscope, .jsonl
 *   st.on('select', (s) => panel.textContent = s ? `${s.name} ${s.totalMs} ms` : '');
 *   const png = await st.exportPng(); const folded = st.collapsed();
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});
  const SEP = "\u0001";
  const VIEWS = ["waterfall", "flamechart", "flamegraph", "icicle", "inverted"];
  const PROFILE_FORMATS = ["cpuprofile", "speedscope"];
  const UNIT_MS = { milliseconds: 1, microseconds: 1e-3, nanoseconds: 1e-6, seconds: 1e3, none: 1 };
  const CHUNK = 5000;
  const RULER = 22;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // Runs fn(i) for i in 0..n-1, yielding to the event loop every CHUNK items.
  async function eachChunk(n, fn) {
    for (let i = 0; i < n; i++) {
      fn(i);
      if (i % CHUNK === CHUNK - 1) await tick();
    }
  }

  async function mapChunked(list, fn) {
    const out = new Array(list.length);
    await eachChunk(list.length, (i) => {
      out[i] = fn(list[i], i);
    });
    return out;
  }

  // Frame-sample -> span conversion. samples: [{t (ms), frames: [{key, name, file}]}] root first.
  function spansFromSamples(samples, endT, prefix) {
    const out = [];
    const open = [];
    let n = 0;
    const closeTo = (k, t) => {
      while (open.length > k) {
        const s = open.pop();
        s.dur = t - s.start;
      }
    };
    for (const smp of samples) {
      const f = smp.frames;
      let k = 0;
      while (k < open.length && k < f.length && open[k].key === f[k].key) k++;
      closeTo(k, smp.t);
      for (let j = k; j < f.length; j++) {
        const span = {
          id: `${prefix}:${n++}`,
          parentId: open.length ? open[open.length - 1].id : null,
          name: f[j].name,
          start: smp.t,
          dur: 0,
          file: f[j].file,
          line: f[j].line,
          key: f[j].key,
          samples: 0,
        };
        open.push(span);
        out.push(span);
      }
      if (f.length) open[f.length - 1].samples++;
    }
    const last = samples.length ? samples[samples.length - 1].t : endT;
    closeTo(0, Math.max(endT, last));
    return out;
  }

  // Parsers return raw spans: {id, parentId, name, start (ms), dur (ms), service?, file?, attrs?, trace?, error?}.
  async function parseChrome(obj) {
    const events = Array.isArray(obj) ? obj : obj.traceEvents;
    if (!Array.isArray(events)) throw new Error("spantree: chrome trace has no traceEvents array");
    const threads = [];
    const open = new Map();
    const procNames = new Map();
    await eachChunk(events.length, (i) => {
      const e = events[i];
      if (e.ph === "X")
        threads.push({
          name: e.name,
          ts: e.ts,
          dur: e.dur ?? 0,
          pid: e.pid,
          tid: e.tid,
          args: e.args,
        });
      else if (e.ph === "B") {
        const k = `${e.pid}:${e.tid}`;
        if (!open.has(k)) open.set(k, []);
        open.get(k).push(e);
      } else if (e.ph === "E") {
        const b = open.get(`${e.pid}:${e.tid}`)?.pop();
        if (!b) throw new Error("spantree: chrome E event without a matching B");
        threads.push({
          name: b.name,
          ts: b.ts,
          dur: e.ts - b.ts,
          pid: b.pid,
          tid: b.tid,
          args: { ...b.args, ...e.args },
        });
      } else if (e.ph === "M" && e.name === "process_name" && e.args?.name)
        procNames.set(e.pid, e.args.name);
    });
    threads.sort((a, b) => a.pid - b.pid || a.tid - b.tid || a.ts - b.ts || b.dur - a.dur);
    const out = [];
    let stack = [];
    let thread = null;
    await eachChunk(threads.length, (i) => {
      const e = threads[i];
      const key = `${e.pid}:${e.tid}`;
      if (key !== thread) {
        stack = [];
        thread = key;
      }
      while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
      const id = `${key}:${i}`;
      out.push({
        id,
        parentId: stack.length ? stack[stack.length - 1].id : null,
        name: String(e.name),
        start: e.ts / 1000,
        dur: e.dur / 1000,
        service: procNames.get(e.pid) ?? (e.pid === undefined ? undefined : String(e.pid)),
        file: e.args?.url ?? e.args?.file,
        attrs: e.args,
        error: Boolean(e.args?.error),
      });
      stack.push({ id, end: e.ts + e.dur });
    });
    return out;
  }

  // cpuprofile: nodes with callFrame + children, samples of node ids, timeDeltas in microseconds.
  async function parseCpuprofile(p) {
    const nodes = new Map(p.nodes.map((n) => [n.id, n]));
    const parentOf = new Map();
    for (const n of p.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
    const cache = new Map();
    const stackOf = (id) => {
      if (cache.has(id)) return cache.get(id);
      const pid = parentOf.get(id);
      const parentStack = pid === undefined ? [] : stackOf(pid);
      const cf = nodes.get(id).callFrame;
      const st =
        cf.functionName === "(root)"
          ? parentStack
          : [
              ...parentStack,
              {
                key: id,
                name: cf.functionName || "(anonymous)",
                file: cf.url || undefined,
                line: cf.lineNumber >= 0 ? cf.lineNumber + 1 : undefined,
              },
            ];
      cache.set(id, st);
      return st;
    };
    const samples = new Array(p.samples.length);
    let t = (p.startTime ?? 0) / 1000;
    await eachChunk(p.samples.length, (i) => {
      t += (p.timeDeltas?.[i] ?? 0) / 1000;
      samples[i] = { t, frames: stackOf(p.samples[i]) };
    });
    return spansFromSamples(samples, (p.endTime ?? t * 1000) / 1000, "c");
  }

  // speedscope: evented (O/C events) or sampled (stacks of frame indices with weights).
  async function parseSpeedscope(p) {
    const fo = p.shared.frames.map((fr, idx) => ({
      key: idx,
      name: fr.name,
      file: fr.file,
      line: fr.line,
    }));
    const out = [];
    p.profiles.forEach((prof, pi) => {
      const f = UNIT_MS[prof.unit];
      if (f === undefined) throw new Error(`spantree: unknown speedscope unit ${prof.unit}`);
      if (prof.type === "evented") {
        const st = [];
        let n = 0;
        for (const ev of prof.events) {
          const at = ev.at * f;
          if (ev.type === "O") {
            const s = {
              id: `p${pi}:${n++}`,
              parentId: st.length ? st[st.length - 1].id : null,
              name: fo[ev.frame].name,
              start: at,
              dur: 0,
              file: fo[ev.frame].file,
              line: fo[ev.frame].line,
            };
            st.push(s);
            out.push(s);
          } else {
            const s = st.pop();
            if (!s) throw new Error("spantree: speedscope close event without an open frame");
            s.dur = at - s.start;
          }
        }
      } else if (prof.type === "sampled") {
        let t = 0;
        const samples = prof.samples.map((stack, i) => {
          const smp = { t, frames: stack.map((idx) => fo[idx]) };
          t += (prof.weights?.[i] ?? 1) * f;
          return smp;
        });
        for (const s of spansFromSamples(samples, t, `p${pi}s`)) out.push(s);
      } else throw new Error(`spantree: unsupported speedscope profile type ${prof.type}`);
    });
    await tick();
    return out;
  }

  const attrMap = (list) =>
    Object.fromEntries((list ?? []).map((a) => [a.key, Object.values(a.value)[0]]));

  // OTLP JSON: resourceSpans -> scopeSpans -> spans, times as nanosecond strings.
  async function parseOtlp(o) {
    const out = [];
    for (const rs of o.resourceSpans) {
      const service = attrMap(rs.resource?.attributes)["service.name"];
      for (const ss of rs.scopeSpans ?? []) {
        const list = ss.spans ?? [];
        await eachChunk(list.length, (i) => {
          const s = list[i];
          const start = Number(BigInt(s.startTimeUnixNano)) / 1e6;
          const end = Number(BigInt(s.endTimeUnixNano)) / 1e6;
          out.push({
            id: `${s.traceId}:${s.spanId}`,
            parentId: s.parentSpanId ? `${s.traceId}:${s.parentSpanId}` : null,
            name: s.name,
            start,
            dur: end - start,
            service,
            attrs: { ...attrMap(s.attributes), statusCode: s.status?.code },
            trace: s.traceId,
            error: s.status?.code === 2 || s.status?.code === "STATUS_CODE_ERROR",
          });
        });
      }
    }
    return out;
  }

  // JSONL: one record per line with span_id, parent_span_id, trace_id, ts and duration_ms.
  function normalizeJsonl(r) {
    const start = typeof r.ts === "number" ? r.ts : Date.parse(r.ts);
    if (!Number.isFinite(start))
      throw new Error(`spantree: jsonl record ${r.span_id} has no usable ts`);
    return {
      id: `${r.trace_id}:${r.span_id}`,
      parentId: r.parent_span_id ? `${r.trace_id}:${r.parent_span_id}` : null,
      name: r.name,
      start,
      dur: r.duration_ms,
      service: r.service,
      file: r.file,
      attrs: r.attributes ?? r.attrs,
      trace: r.trace_id,
      error: Boolean(r.error) || r.status === "error" || r.status === "ERROR",
    };
  }

  // Generic spans: [{id, parentId|null, name, start, dur, service?, file?, attrs?, trace?}].
  function normalizeGeneric(s) {
    return {
      ...s,
      id: String(s.id),
      parentId: s.parentId == null ? null : String(s.parentId),
      error: Boolean(s.error),
    };
  }

  async function parseJsonlText(text) {
    const lines = text.split("\n");
    const recs = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line) recs.push(JSON.parse(line));
      if (i % CHUNK === CHUNK - 1) await tick();
    }
    return mapChunked(recs, normalizeJsonl);
  }

  function textOrJsonl(text) {
    try {
      return JSON.parse(text);
    } catch (err) {
      return { jsonlText: text };
    }
  }

  async function readSource(src) {
    if (typeof src === "string") return textOrJsonl(src);
    if (src instanceof Blob) return textOrJsonl(await src.text());
    return src;
  }

  function detect(raw) {
    if (raw.jsonlText !== undefined) return "jsonl";
    if (Array.isArray(raw)) return raw.length && "span_id" in raw[0] ? "jsonl" : "spans";
    if (raw.traceEvents) return "chrome";
    if (raw.resourceSpans) return "otlp";
    if (raw.profiles && raw.shared) return "speedscope";
    if (raw.nodes && raw.samples) return "cpuprofile";
    if ("span_id" in raw) return "jsonl";
    throw new Error("spantree: cannot detect the format; pass options.format");
  }

  async function toSpans(format, raw) {
    switch (format) {
      case "chrome":
        return parseChrome(raw);
      case "cpuprofile":
        return parseCpuprofile(raw);
      case "speedscope":
        return parseSpeedscope(raw);
      case "otlp":
        return parseOtlp(raw);
      case "spans":
        return mapChunked(raw, normalizeGeneric);
      case "jsonl":
        if (raw.jsonlText !== undefined) return parseJsonlText(raw.jsonlText);
        return mapChunked(Array.isArray(raw) ? raw : [raw], normalizeJsonl);
      default:
        throw new Error(`spantree: unknown format ${format}`);
    }
  }

  // Builds the model: links parents (missing parents become roots), derives self time, the
  // name-path key of every span (pk) and per-path info for merged views. Rebases times to 0.
  function buildModel(format, spans) {
    const byId = new Map();
    for (const s of spans) {
      if (byId.has(s.id)) throw new Error(`spantree: duplicate span id ${s.id}`);
      if (
        typeof s.name !== "string" ||
        !Number.isFinite(s.start) ||
        !Number.isFinite(s.dur) ||
        s.dur < 0
      ) {
        throw new Error(`spantree: span ${s.id} needs a name, numeric start and dur >= 0`);
      }
      byId.set(s.id, s);
      s.kids = [];
    }
    const roots = [];
    for (const s of spans) {
      s.parent = s.parentId == null ? null : (byId.get(s.parentId) ?? null);
      if (s.parent) s.parent.kids.push(s);
      else roots.push(s);
    }
    const byStart = (a, b) => a.start - b.start || b.dur - a.dur;
    let origin = Infinity;
    for (const s of spans) origin = Math.min(origin, s.start);
    if (!spans.length) return { format, spans, byId, roots, pkInfo: new Map(), start: 0, end: 0 };
    for (const s of spans) s.start -= origin;
    roots.sort(byStart);
    const pkInfo = new Map();
    const work = [];
    for (const r of roots) {
      r.depth = 0;
      r.pk = r.name;
      pkInfo.set(r.pk, { name: r.name, parentPk: null, depth: 0 });
      work.push(r);
    }
    let visited = 0;
    let end = 0;
    while (work.length) {
      const s = work.pop();
      visited++;
      s.kids.sort(byStart);
      let childSum = 0;
      for (const c of s.kids) {
        childSum += c.dur;
        c.depth = s.depth + 1;
        if (c.trace === undefined && s.trace !== undefined) c.trace = s.trace;
        c.pk = s.pk + SEP + c.name;
        if (!pkInfo.has(c.pk)) pkInfo.set(c.pk, { name: c.name, parentPk: s.pk, depth: c.depth });
        work.push(c);
      }
      s.self = Math.max(0, s.dur - childSum);
      s.end = s.start + s.dur;
      end = Math.max(end, s.end);
    }
    if (visited !== spans.length) throw new Error("spantree: parent cycle in input");
    return { format, spans, byId, roots, pkInfo, start: 0, end };
  }

  // Spans inside the current trace and range, in start order.
  function filterSpans(model, trace, range) {
    const out = [];
    for (const s of model.spans) {
      if (trace !== null && s.trace !== trace) continue;
      if (range && (s.end < range.from || s.start > range.to)) continue;
      out.push(s);
    }
    return out.sort((a, b) => a.start - b.start || b.dur - a.dur);
  }

  // Time views: children restricted to the filtered set, and pre-order rows with depth.
  function timeStructure(list) {
    const inSet = new Set(list);
    const kids = new Map();
    const roots = [];
    for (const s of list) {
      const p = s.parent && inSet.has(s.parent) ? s.parent : null;
      if (p) {
        if (!kids.has(p)) kids.set(p, []);
        kids.get(p).push(s);
      } else roots.push(s);
    }
    const rows = [];
    const stack = [];
    for (let i = roots.length - 1; i >= 0; i--) stack.push({ s: roots[i], d: 0 });
    let depth = 0;
    while (stack.length) {
      const { s, d } = stack.pop();
      rows.push({ s, d });
      if (d + 1 > depth) depth = d + 1;
      const k = kids.get(s);
      if (k) for (let i = k.length - 1; i >= 0; i--) stack.push({ s: k[i], d: d + 1 });
    }
    return { kids, roots, rows, depth };
  }

  // Merged tree keyed by name path (pk). Node total = max(own spans, sum of child totals).
  function buildMerged(model, list) {
    const nodes = new Map();
    const roots = [];
    const ensure = (pk) => {
      let n = nodes.get(pk);
      if (n) return n;
      const info = model.pkInfo.get(pk);
      n = {
        key: pk,
        name: info.name,
        parent: info.parentPk,
        depth: info.depth,
        kids: [],
        own: 0,
        total: 0,
        self: 0,
        count: 0,
        file: undefined,
        line: undefined,
        service: undefined,
      };
      nodes.set(pk, n);
      if (info.parentPk === null) roots.push(pk);
      else ensure(info.parentPk).kids.push(pk);
      return n;
    };
    for (const s of list) {
      const n = ensure(s.pk);
      n.own += s.dur;
      n.count++;
      n.file ??= s.file;
      n.line ??= s.line;
      n.service ??= s.service;
      if (s.error) n.error = true;
    }
    return finishTree(nodes, roots);
  }

  // Inverted tree: each span's self time is credited to its leaf-to-root name chain.
  function buildInverted(list) {
    const nodes = new Map();
    const roots = [];
    for (const s of list) {
      if (s.self <= 0) continue;
      let parentKey = null;
      let key = "";
      let depth = 0;
      for (let cur = s; cur; cur = cur.parent) {
        key = key === "" ? cur.name : key + SEP + cur.name;
        let n = nodes.get(key);
        if (!n) {
          n = {
            key,
            name: cur.name,
            parent: parentKey,
            depth,
            kids: [],
            own: 0,
            total: 0,
            self: 0,
            count: 0,
            file: cur.file,
            line: cur.line,
            service: cur.service,
          };
          nodes.set(key, n);
          if (parentKey === null) roots.push(key);
          else nodes.get(parentKey).kids.push(key);
        }
        n.own += s.self;
        n.count++;
        parentKey = key;
        depth++;
      }
    }
    return finishTree(nodes, roots);
  }

  // Bottom-up totals and self, children sorted by name for stable merged layouts.
  function finishTree(nodes, roots) {
    const all = [...nodes.values()].sort((a, b) => b.depth - a.depth);
    for (const n of all) {
      let sum = 0;
      n.kids.sort((a, b) => (nodes.get(a).name < nodes.get(b).name ? -1 : 1));
      for (const k of n.kids) sum += nodes.get(k).total;
      n.total = Math.max(n.own, sum);
      n.self = Math.max(0, n.total - sum);
    }
    roots.sort((a, b) => (nodes.get(a).name < nodes.get(b).name ? -1 : 1));
    return { nodes, roots };
  }

  // Merged layout: widths are totals, children packed left to right by name. Rows beyond the
  // viewport are skipped but their children are still visited, so scrolled views stay complete.
  // flame: rows grow upward from the bottom; scrollY moves content toward the deeper rows.
  function layoutMerged(tree, focusKey, flame, W, H, rowH, scrollY, minPx) {
    const roots = focusKey !== null && tree.nodes.has(focusKey) ? [focusKey] : tree.roots;
    let total = 0;
    for (const k of roots) total += tree.nodes.get(k).total;
    const items = [];
    let rows = 0;
    if (total <= 0) return { items, rows };
    const scale = W / total;
    const stack = [];
    let acc = 0;
    for (const k of roots) {
      stack.push({ k, d: 0, x0: acc });
      acc += tree.nodes.get(k).total;
    }
    while (stack.length) {
      const { k, d, x0 } = stack.pop();
      const n = tree.nodes.get(k);
      const w = n.total * scale;
      if (w < minPx) continue;
      rows = Math.max(rows, d + 1);
      const y = flame ? H - (d + 1) * rowH + scrollY : d * rowH - scrollY;
      if (y + rowH >= 0 && y <= H) {
        items.push({
          key: k,
          name: n.name,
          x: x0 * scale,
          y,
          w,
          h: rowH - 1,
          selfShare: n.total > 0 ? n.self / n.total : 0,
          node: n,
          d,
          error: n.error,
        });
      }
      let c = x0;
      for (const ck of n.kids) {
        stack.push({ k: ck, d: d + 1, x0: c });
        c += tree.nodes.get(ck).total;
      }
    }
    return { items, rows };
  }

  // Time layout: x from the zoom window. Waterfall rows by index, flame chart rows by depth.
  function layoutTime(rows, waterfall, vp, W, H, rowH, scrollY, minPx) {
    const k = W / (vp.to - vp.from);
    const items = [];
    // Waterfall rows are one per span, so only the visible slice is visited.
    const i0 = waterfall ? Math.max(0, Math.floor(scrollY / rowH) - 1) : 0;
    const i1 = waterfall ? Math.min(rows.length, Math.ceil((scrollY + H) / rowH) + 1) : rows.length;
    for (let i = i0; i < i1; i++) {
      const { s, d } = rows[i];
      const x = (s.start - vp.from) * k;
      const w = s.dur * k;
      if (x > W || x + w < 0 || w < minPx) continue;
      const y = RULER + (waterfall ? i : d) * rowH - scrollY;
      if (y + rowH < RULER || y > H) continue;
      items.push({
        key: s.id,
        name: s.name,
        x,
        y,
        w,
        h: rowH - 1,
        span: s,
        selfShare: s.dur > 0 ? s.self / s.dur : 1,
        error: s.error,
      });
    }
    return items;
  }

  const STYLE = `
.t3k-spantree-root{display:flex;flex-direction:column;gap:6px;height:100%;min-height:0;min-width:0;color:var(--foreground);font-family:var(--font-sans);font-size:12px}
.t3k-spantree-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.t3k-spantree-btn{appearance:none;height:26px;padding:0 9px;border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);background:var(--muted);color:var(--foreground);font:inherit;cursor:pointer}
.t3k-spantree-btn[aria-pressed="true"]{border-color:var(--primary);color:var(--primary)}
.t3k-spantree-input,.t3k-spantree-select{height:26px;min-width:0;padding:0 8px;border:1px solid var(--input);border-radius:calc(var(--radius) - 2px);background:var(--background);color:var(--foreground);font:inherit}
.t3k-spantree-input{flex:1 1 140px}
.t3k-spantree-status{color:var(--muted-foreground);font-variant-numeric:tabular-nums;white-space:nowrap}
.t3k-spantree-btn:focus-visible,.t3k-spantree-input:focus-visible,.t3k-spantree-select:focus-visible,.t3k-spantree-canvas:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.t3k-spantree-stage{position:relative;flex:1 1 auto;min-height:160px;border:1px solid var(--border);border-radius:var(--radius);background:var(--background);overflow:hidden}
.t3k-spantree-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}
.t3k-spantree-tip{position:absolute;z-index:1;max-width:320px;padding:6px 8px;border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);background:var(--card);color:var(--card-foreground);font-size:11px;line-height:1.4;pointer-events:none;display:none}
`;

  const VIEW_LABELS = {
    waterfall: "Waterfall",
    flamechart: "Flame Chart",
    flamegraph: "Flame Graph",
    icicle: "Icicle",
    inverted: "Inverted",
  };
  const COLOR_BY = ["name", "service", "module", "delta"];

  // Short duration label: 3 significant decimals at most, trailing zeros dropped.
  function fmtMs(v) {
    const a = Math.abs(v);
    if (a < 1e-9) return "0 ms";
    if (a >= 1000) return `${Number((v / 1000).toFixed(2))} s`;
    if (a >= 1) return `${Number(v.toFixed(2))} ms`;
    return `${Number((v * 1000).toFixed(1))} µs`;
  }

  // Stable palette index for a label (FNV-1a over the chart tokens).
  function paletteIndex(label) {
    let h = 2166136261;
    for (let i = 0; i < label.length; i++) {
      h ^= label.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 6;
  }

  function fitText(ctx, text, avail) {
    if (ctx.measureText(text).width <= avail) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > avail) t = t.slice(0, -1);
    return t.length > 1 ? `${t}…` : "";
  }

  // Theme tokens read at paint time, so live theme switches are picked up on the next frame.
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      bg: v("--background"),
      fg: v("--foreground"),
      muted: v("--muted-foreground"),
      border: v("--border"),
      ring: v("--ring"),
      warn: v("--warning"),
      ok: v("--success"),
      bad: v("--destructive"),
      font: v("--font-sans"),
      chart: [1, 2, 3, 4, 5, 6].map((i) => v(`--chart-${i}`)),
    };
  }

  function create(container, options = {}) {
    const style =
      document.head.querySelector('style[data-t3kit="spantree"]') ??
      document.head.appendChild(
        Object.assign(document.createElement("style"), { textContent: STYLE }),
      );
    style.setAttribute("data-t3kit", "spantree");

    const root = document.createElement("div");
    root.className = "t3k-spantree-root";
    const bar = document.createElement("div");
    bar.className = "t3k-spantree-bar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Span view controls");
    const viewBtns = new Map();
    for (const v of VIEWS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "t3k-spantree-btn";
      b.textContent = VIEW_LABELS[v];
      b.dataset.view = v;
      b.addEventListener("click", () => userSetView(v));
      viewBtns.set(v, b);
      bar.appendChild(b);
    }
    const metricBtn = document.createElement("button");
    metricBtn.type = "button";
    metricBtn.className = "t3k-spantree-btn";
    metricBtn.addEventListener("click", () =>
      userSet({ metric: st.metric === "total" ? "self" : "total" }),
    );
    const fitBtn = document.createElement("button");
    fitBtn.type = "button";
    fitBtn.className = "t3k-spantree-btn";
    fitBtn.textContent = "Fit";
    fitBtn.addEventListener("click", () => userFit());
    const colorSel = document.createElement("select");
    colorSel.className = "t3k-spantree-select";
    colorSel.setAttribute("aria-label", "Color by");
    for (const c of COLOR_BY) colorSel.append(new Option(`Color: ${c}`, c));
    colorSel.addEventListener("change", () => userSet({ colorBy: colorSel.value }));
    const search = document.createElement("input");
    search.type = "search";
    search.className = "t3k-spantree-input";
    search.placeholder = "Search spans (/)";
    search.setAttribute("aria-label", "Search spans");
    search.addEventListener("input", () => {
      st.search = search.value;
      invalidate();
      emit("change", get());
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        search.value = "";
        st.search = "";
        invalidate();
        canvas.focus();
      }
    });
    const status = document.createElement("span");
    status.className = "t3k-spantree-status";
    status.setAttribute("aria-live", "polite");
    bar.append(fitBtn, metricBtn, colorSel, search, status);

    const stage = document.createElement("div");
    stage.className = "t3k-spantree-stage";
    const canvas = document.createElement("canvas");
    canvas.className = "t3k-spantree-canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      "Span canvas. Arrow keys move, Enter zooms, Backspace zooms out, slash searches.",
    );
    const tip = document.createElement("div");
    tip.className = "t3k-spantree-tip";
    stage.append(canvas, tip);
    root.append(bar, stage);
    container.appendChild(root);
    const ctx = canvas.getContext("2d");

    // State. Everything the view needs lives here; the model is replaced only by load() or compare().
    const st = {
      view: VIEWS.includes(options.view) ? options.view : "waterfall",
      metric: options.metric === "self" ? "self" : "total",
      minPx: options.minPx ?? 0.5,
      rowHeight: Math.min(28, Math.max(16, options.rowHeight ?? 18)),
      colorBy: COLOR_BY.includes(options.colorBy) ? options.colorBy : "name",
      search: "",
      trace: null,
      range: null,
      vp: { id: null, from: 0, to: 1 },
      zooms: [],
      sel: null,
      scrollY: 0,
    };
    let explicitView = Boolean(options.view);
    let model = null;
    let fc = null;
    let items = [];
    let matches = 0;
    let curTree = null;
    let layoutDirty = true;
    let scheduled = false;
    let destroyed = false;
    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    let panX = 0;
    let panY = 0;
    let drag = null;
    let delta = null;
    let deltaMax = 0;
    let deltaByName = null;
    const listeners = new Map();
    const observers = [];

    const isTime = () => st.view === "waterfall" || st.view === "flamechart";
    const keyKind = (v) =>
      v === "waterfall" || v === "flamechart" ? "span" : v === "inverted" ? "inv" : "path";
    // Fit = the range when set, else the extent of the spans in the current trace filter.
    const fitWindow = () => {
      let lo = 0;
      let hi = 1;
      if (st.range) {
        lo = st.range.from;
        hi = st.range.to;
      } else if (model && st.trace !== null) {
        lo = Infinity;
        hi = -Infinity;
        for (const s of filtered().list) {
          lo = Math.min(lo, s.start);
          hi = Math.max(hi, s.end);
        }
        if (lo === Infinity) lo = hi = 0;
      } else if (model) {
        lo = model.start;
        hi = model.end;
      }
      return { id: null, from: lo, to: hi > lo ? hi : lo + 1 };
    };
    const fitView = () => {
      st.vp = fitWindow();
      st.zooms = [];
      st.scrollY = 0;
    };

    function emit(name, payload) {
      for (const cb of listeners.get(name) ?? []) cb(payload);
    }

    function schedule() {
      if (scheduled || destroyed) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        flush();
      });
    }

    // Filtered list plus lazily built structures. Dropped whenever trace or range change.
    function filtered() {
      if (!model) return null;
      if (!fc) {
        const list = filterSpans(model, st.trace, st.range);
        fc = { list, set: new Set(list), struct: null, merged: null, inv: null };
      }
      return fc;
    }

    function invalidate() {
      layoutDirty = true;
      schedule();
    }

    // Clamps scrollY to the content height for the current view.
    function clampScroll(lines, avail) {
      st.scrollY = Math.min(Math.max(0, st.scrollY), Math.max(0, lines * st.rowHeight - avail));
    }

    function layout() {
      layoutDirty = false;
      items = [];
      curTree = null;
      const f = filtered();
      if (!f) {
        matches = 0;
        return;
      }
      const q = st.search ? st.search.toLowerCase() : "";
      if (isTime()) {
        f.struct ??= timeStructure(f.list);
        const { rows, depth } = f.struct;
        clampScroll(st.view === "waterfall" ? rows.length : depth, cssH - RULER);
        items = layoutTime(
          rows,
          st.view === "waterfall",
          st.vp,
          cssW,
          cssH,
          st.rowHeight,
          st.scrollY,
          st.minPx,
        );
        matches = 0;
        if (q) for (const s of f.list) if (s.name.toLowerCase().includes(q)) matches++;
      } else {
        curTree = treeFor();
        const flame = st.view === "flamegraph";
        let out = layoutMerged(
          curTree,
          st.vp.id,
          flame,
          cssW,
          cssH,
          st.rowHeight,
          st.scrollY,
          st.minPx,
        );
        const before = st.scrollY;
        clampScroll(out.rows, cssH);
        if (st.scrollY !== before)
          out = layoutMerged(
            curTree,
            st.vp.id,
            flame,
            cssW,
            cssH,
            st.rowHeight,
            st.scrollY,
            st.minPx,
          );
        items = out.items;
        matches = 0;
        if (q)
          for (const n of curTree.nodes.values()) if (n.name.toLowerCase().includes(q)) matches++;
      }
      if (q) for (const it of items) it.match = it.name.toLowerCase().includes(q);
    }

    function colorFor(it, th) {
      if (st.colorBy === "delta") {
        const d = delta?.get(it.span ? it.span.pk : it.key);
        if (d === undefined || Math.abs(d) < 1e-9) return { color: th.muted, alpha: 0.45 };
        return {
          color: d > 0 ? th.bad : th.ok,
          alpha: 0.3 + 0.7 * Math.min(1, Math.abs(d) / deltaMax),
        };
      }
      const label =
        st.colorBy === "name"
          ? it.name
          : st.colorBy === "service"
            ? (it.span?.service ?? it.node?.service ?? "")
            : (it.span?.file ?? it.node?.file ?? it.span?.service ?? it.node?.service ?? "");
      return { color: th.chart[paletteIndex(label)], alpha: 0.85 };
    }

    function drawRuler(ctx, th) {
      const pxPerMs = cssW / (st.vp.to - st.vp.from);
      const cand = [];
      for (let p = 1e-3; p <= 1e7; p *= 10) for (const m of [1, 2, 5]) cand.push(p * m);
      const step = cand.find((c) => c * pxPerMs >= 80) ?? cand[cand.length - 1];
      ctx.fillStyle = th.bg;
      ctx.fillRect(0, 0, cssW, RULER);
      ctx.strokeStyle = th.border;
      ctx.fillStyle = th.muted;
      ctx.beginPath();
      ctx.moveTo(0, RULER - 0.5);
      ctx.lineTo(cssW, RULER - 0.5);
      // Integer tick indices avoid float drift in the labels.
      const first = Math.ceil(st.vp.from / step);
      const last = Math.floor(st.vp.to / step);
      for (let i = first; i <= last; i++) {
        const x = Math.round((i * step - st.vp.from) * pxPerMs) + 0.5;
        ctx.moveTo(x, RULER - 6);
        ctx.lineTo(x, RULER);
      }
      ctx.stroke();
      for (let i = first; i <= last; i++)
        ctx.fillText(fmtMs(i * step), (i * step - st.vp.from) * pxPerMs + 3, RULER / 2);
    }

    // Paints the current items. Pure with respect to state: export reuses it at another scale.
    function paint(c, W, H) {
      const th = readTheme();
      c.fillStyle = th.bg;
      c.fillRect(0, 0, W, H);
      c.font = `11px ${th.font}`;
      c.textBaseline = "middle";
      if (!model) {
        c.fillStyle = th.muted;
        c.fillText("Load a trace or profile to see spans", 12, 20);
        return;
      }
      const selfMode = st.metric === "self";
      for (const it of items) {
        const col = colorFor(it, th);
        const dim = st.search && !it.match;
        const full = dim ? 0.2 : col.alpha;
        // Self metric: the whole frame is faint and its self share is drawn at full strength.
        const base = selfMode && it.selfShare < 1 ? full * 0.4 : full;
        c.globalAlpha = base;
        c.fillStyle = col.color;
        c.fillRect(it.x, it.y, it.w, it.h);
        if (base !== full && it.selfShare > 0) {
          c.globalAlpha = full;
          c.fillRect(it.x, it.y, it.w * it.selfShare, it.h);
        }
        if (it.error) {
          c.globalAlpha = 1;
          c.fillStyle = th.bad;
          c.fillRect(it.x, it.y, Math.min(3, it.w), it.h);
        }
        c.globalAlpha = dim ? 0.35 : 1;
        if (it.w > 28) {
          c.fillStyle = base >= 0.6 ? th.bg : th.fg;
          c.fillText(
            fitText(c, it.name, Math.max(0, Math.min(it.w, cssW - Math.max(it.x, 0)) - 8)),
            Math.max(it.x, 0) + 4,
            it.y + it.h / 2,
          );
        }
        c.globalAlpha = 1;
        if (it.key === st.sel) {
          c.strokeStyle = th.ring;
          c.lineWidth = 2;
          c.strokeRect(it.x + 1, it.y + 1, it.w - 2, it.h - 2);
        } else if (it.match && st.search) {
          c.strokeStyle = th.warn;
          c.lineWidth = 1.5;
          c.strokeRect(it.x + 0.75, it.y + 0.75, it.w - 1.5, it.h - 1.5);
        }
      }
      c.globalAlpha = 1;
      if (isTime()) drawRuler(c, th);
      if (model && !items.length) {
        c.fillStyle = th.muted;
        c.fillText("No spans in this window", 12, RULER + 16);
      }
    }

    // Applies pending drag motion and repaints. Called once per animation frame at most.
    // Moves content down by dy px: flame graphs grow upward, every other view grows downward.
    function scrollContent(dy) {
      st.scrollY += st.view === "flamegraph" ? dy : -dy;
    }

    // Applies the newest drag delta. Runs once per frame while dragging and once on release.
    function applyPan() {
      if (!panX && !panY) return;
      if (isTime() && cssW > 0) {
        const dt = (-panX / cssW) * (st.vp.to - st.vp.from);
        st.vp = { ...st.vp, from: st.vp.from + dt, to: st.vp.to + dt };
      }
      scrollContent(panY);
      panX = 0;
      panY = 0;
      layoutDirty = true;
    }

    function flush() {
      if (destroyed) return;
      applyPan();
      if (layoutDirty) layout();
      syncControls();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(ctx, cssW, cssH);
    }

    const emitZoom = () => emit("zoom", { id: st.vp.id, from: st.vp.from, to: st.vp.to });

    const sizeCanvas = () => {
      dpr = window.devicePixelRatio || 1;
      cssW = stage.clientWidth;
      cssH = stage.clientHeight;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      invalidate();
    };
    observers.push(new ResizeObserver(sizeCanvas));
    observers[0].observe(stage);
    // Theme changes arrive as style/class changes on the root or a rewritten #t3-theme in head.
    const themeObs = new MutationObserver(() => invalidate());
    themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme"],
    });
    themeObs.observe(document.head, { childList: true, subtree: true, characterData: true });
    observers.push(themeObs);

    const local = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    function hitTest(x, y) {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it;
      }
      return null;
    }

    function treeFor() {
      const f = filtered();
      if (st.view === "inverted") return (f.inv ??= buildInverted(f.list));
      return (f.merged ??= buildMerged(model, f.list));
    }

    // Describes a span (waterfall, flame chart) or a merged node (flame graph, icicle, inverted).
    function describe(key) {
      if (!model || key === null) return null;
      if (isTime()) {
        const s = model.byId.get(key);
        if (!s) return null;
        const path = [];
        for (let p = s; p; p = p.parent) path.unshift(p.name);
        return {
          id: s.id,
          name: s.name,
          path,
          selfMs: s.self,
          totalMs: s.dur,
          count: 1,
          service: s.service,
          file: s.file,
          line: s.line,
          attrs: s.attrs,
        };
      }
      const n = treeFor().nodes.get(key);
      if (!n) return null;
      return {
        id: key,
        name: n.name,
        path: key.split(SEP),
        selfMs: n.self,
        totalMs: n.total,
        count: n.count,
        service: n.service,
        file: n.file,
        line: n.line,
      };
    }

    function neighbors(key) {
      if (key === null || !model) return null;
      const f = filtered();
      if (isTime()) {
        const s = model.byId.get(key);
        if (!s || !f.set.has(s)) return null;
        f.struct ??= timeStructure(f.list);
        const parent = s.parent && f.set.has(s.parent) ? s.parent : null;
        const sibs = parent ? (f.struct.kids.get(parent) ?? []) : f.struct.roots;
        return {
          parent: parent ? parent.id : null,
          kids: (f.struct.kids.get(s) ?? []).map((x) => x.id),
          siblings: sibs.map((x) => x.id),
          index: sibs.indexOf(s),
        };
      }
      const tree = treeFor();
      const n = tree.nodes.get(key);
      if (!n) return null;
      const focused = key === st.vp.id;
      const parent = focused ? null : n.parent;
      const sibs =
        parent !== null
          ? tree.nodes.get(parent).kids
          : focused || st.vp.id !== null
            ? [key]
            : tree.roots;
      return { parent, kids: n.kids, siblings: sibs, index: sibs.indexOf(key) };
    }

    // Brings a span into the zoom window and scrolls its row into view.
    function reveal(s) {
      const span = st.vp.to - st.vp.from;
      if (s.start < st.vp.from || s.end > st.vp.to) {
        const from = s.start - span * 0.1;
        st.vp = { ...st.vp, from, to: from + span };
      }
      const rows = filtered().struct.rows;
      const idx = rows.findIndex((r) => r.s === s);
      if (idx < 0) return;
      const line = st.view === "waterfall" ? idx : rows[idx].d;
      const y = line * st.rowHeight;
      const visible = cssH - RULER;
      if (y < st.scrollY) st.scrollY = y;
      else if (y + st.rowHeight > st.scrollY + visible) st.scrollY = y + st.rowHeight - visible;
    }

    // Scrolls a merged-view node's row into view.
    function revealNode(key) {
      const tree = treeFor();
      const n = tree.nodes.get(key);
      if (!n) return;
      const focus = st.vp.id !== null ? tree.nodes.get(st.vp.id) : null;
      const d = n.depth - (focus ? focus.depth : 0);
      if (d < 0) return;
      const lo =
        st.view === "flamegraph"
          ? (d + 1) * st.rowHeight - cssH
          : d * st.rowHeight + st.rowHeight - cssH;
      const hi = d * st.rowHeight;
      st.scrollY = Math.min(Math.max(st.scrollY, lo), hi);
    }

    function select(key, keyboard) {
      st.sel = key;
      if (keyboard && key !== null) {
        if (isTime()) reveal(model.byId.get(key));
        else revealNode(key);
      }
      emit("select", describe(key));
      invalidate();
    }

    function moveSel(k) {
      if (!model) return;
      const nb = neighbors(st.sel);
      if (!nb) {
        const f = filtered();
        const first = isTime()
          ? ((f.struct ??= timeStructure(f.list)).roots[0]?.id ?? null)
          : (treeFor().roots[0] ?? null);
        if (first !== null) select(first, true);
        return;
      }
      // Flame graphs grow upward, so the vertical arrows follow what the eye sees.
      const up = st.view === "flamegraph" ? "ArrowDown" : "ArrowUp";
      const down = st.view === "flamegraph" ? "ArrowUp" : "ArrowDown";
      const next =
        k === up
          ? nb.parent
          : k === down
            ? (nb.kids[0] ?? null)
            : k === "ArrowLeft"
              ? (nb.siblings[nb.index - 1] ?? null)
              : (nb.siblings[nb.index + 1] ?? null);
      if (next !== null) select(next, true);
    }

    function pushZoom(vp) {
      st.zooms.push(st.vp);
      st.vp = vp;
      if (!isTime()) st.scrollY = 0;
      emitZoom();
      emit("change", get());
      invalidate();
    }

    function userZoomIn(key) {
      if (key === null || !model) return;
      if (isTime()) {
        const s = model.byId.get(key);
        pushZoom({ id: key, from: s.start, to: s.start + Math.max(s.dur, 1e-6) });
      } else pushZoom({ id: key, from: st.vp.from, to: st.vp.to });
    }

    function userZoomOut() {
      if (!st.zooms.length) return userFit();
      st.vp = st.zooms.pop();
      emitZoom();
      emit("change", get());
      invalidate();
    }

    function userFit() {
      fitView();
      emitZoom();
      emit("change", get());
      invalidate();
    }

    // Changing between span, path and inverted keys clears the selection and zoom, since keys differ.
    function applyView(v) {
      if (!VIEWS.includes(v)) throw new Error(`spantree: unknown view ${v}`);
      explicitView = true;
      if (v === st.view) return false;
      if (keyKind(v) !== keyKind(st.view)) {
        st.sel = null;
        fitView();
      }
      st.view = v;
      return true;
    }

    function userSetView(v) {
      if (applyView(v)) {
        invalidate();
        emit("change", get());
      }
    }

    function userSet(p) {
      if (p.metric !== undefined) st.metric = p.metric;
      if (p.colorBy !== undefined) st.colorBy = p.colorBy;
      invalidate();
      emit("change", get());
    }

    function syncControls() {
      for (const [v, b] of viewBtns) b.setAttribute("aria-pressed", String(v === st.view));
      metricBtn.textContent = `Metric: ${st.metric === "self" ? "Self" : "Total"}`;
      metricBtn.setAttribute("aria-pressed", String(st.metric === "self"));
      metricBtn.title = "Self shades each frame by the time it spends outside its children";
      colorSel.value = st.colorBy;
      if (search.value !== st.search) search.value = st.search;
      const n = fc ? fc.list.length : 0;
      status.textContent = st.search
        ? `${matches} matching`
        : model
          ? `${n} span${n === 1 ? "" : "s"}`
          : "";
    }

    function onPointerDown(e) {
      const p = local(e);
      drag = { x: p.x, y: p.y, lx: p.x, ly: p.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
      canvas.focus({ preventScroll: true });
    }

    // Moves only record the pointer delta; the frame loop applies it once per frame.
    function onPointerMove(e) {
      const p = local(e);
      if (!drag) {
        hover(p);
        return;
      }
      if (Math.hypot(p.x - drag.x, p.y - drag.y) > 3) drag.moved = true;
      if (drag.moved) {
        panX += p.x - drag.lx;
        panY += p.y - drag.ly;
        schedule();
      }
      drag.lx = p.x;
      drag.ly = p.y;
    }

    function onPointerUp(e) {
      if (!drag) return;
      const { moved } = drag;
      drag = null;
      if (moved) {
        applyPan();
        if (isTime()) emitZoom();
        emit("change", get());
        schedule();
        return;
      }
      const p = local(e);
      const it = hitTest(p.x, p.y);
      select(it ? it.key : null, false);
    }

    function hover(p) {
      const it = hitTest(p.x, p.y);
      if (!it) {
        tip.style.display = "none";
        return;
      }
      const info = describe(it.key);
      const head = document.createElement("b");
      head.textContent = it.name;
      const line = document.createElement("div");
      line.textContent = `${fmtMs(info.totalMs)} total, ${fmtMs(info.selfMs)} self, ${info.count}×`;
      tip.replaceChildren(head, line);
      const where = info.file ?? info.service;
      if (where) {
        const w = document.createElement("div");
        w.textContent = where;
        tip.append(w);
      }
      tip.style.display = "block";
      tip.style.left = `${Math.min(p.x + 12, cssW - 220)}px`;
      tip.style.top = `${Math.min(p.y + 12, cssH - 70)}px`;
    }

    function onWheel(e) {
      e.preventDefault();
      if (!model) return;
      if (isTime() && (e.ctrlKey || e.metaKey || e.shiftKey)) {
        const p = local(e);
        const span = st.vp.to - st.vp.from;
        const d = e.deltaY || e.deltaX;
        const next = Math.min(
          Math.max(span * Math.exp(d * 0.0015), 1e-6),
          (model.end - model.start) * 8 || 1,
        );
        const anchor = st.vp.from + (p.x / cssW) * span;
        const from = anchor - (p.x / cssW) * next;
        st.vp = { id: st.vp.id, from, to: from + next };
        emitZoom();
        emit("change", get());
      } else if (!e.ctrlKey && !e.metaKey) scrollContent(-e.deltaY);
      invalidate();
    }

    function onKey(e) {
      const k = e.key;
      if (k === "/") search.focus();
      else if (k === "f") userFit();
      else if (k === "v") userSetView(VIEWS[(VIEWS.indexOf(st.view) + 1) % VIEWS.length]);
      else if (k === "Enter") userZoomIn(st.sel);
      else if (k === "Backspace" || k === "Escape") userZoomOut();
      else if (k === "ArrowUp" || k === "ArrowDown" || k === "ArrowLeft" || k === "ArrowRight")
        moveSel(k);
      else return;
      e.preventDefault();
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", () => {
      tip.style.display = "none";
    });
    canvas.addEventListener("dblclick", (e) => {
      const p = local(e);
      const it = hitTest(p.x, p.y);
      if (it) userZoomIn(it.key);
    });
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    for (const [v, b] of viewBtns) b.dataset.view = v;

    function setModel(m) {
      model = m;
      fc = null;
      delta = null;
      deltaByName = null;
      st.range = null;
      st.trace = null;
      st.sel = null;
      fitView();
      invalidate();
    }

    let loadToken = 0;
    async function load(source, opts = {}) {
      const token = ++loadToken;
      const raw = await readSource(source);
      const format = !opts.format || opts.format === "auto" ? detect(raw) : opts.format;
      const spans = await toSpans(format, raw);
      const next = buildModel(format, spans);
      if (token !== loadToken) throw new Error("spantree: load superseded by a newer load()");
      if (destroyed) throw new Error("spantree: destroyed during load()");
      setModel(next);
      if (!explicitView) st.view = PROFILE_FORMATS.includes(format) ? "flamechart" : "waterfall";
      syncControls();
      return {
        format,
        spans: model.spans.length,
        roots: model.roots.map((r) => r.id),
        start: model.start,
        end: model.end,
        unit: "ms",
      };
    }

    async function compare(source) {
      if (!model) throw new Error("spantree: load() a profile before compare()");
      const raw = await readSource(source);
      const fmt = detect(raw);
      const other = buildModel(fmt, await toSpans(fmt, raw));
      const totals = (m) => {
        const t = new Map();
        for (const s of m.spans) t.set(s.pk, (t.get(s.pk) ?? 0) + s.dur);
        return t;
      };
      const a = totals(model);
      const b = totals(other);
      delta = new Map();
      deltaByName = new Map();
      deltaMax = 0;
      let matched = 0;
      let aOnly = 0;
      let bOnly = 0;
      for (const k of new Set([...a.keys(), ...b.keys()])) {
        const d = (b.get(k) ?? 0) - (a.get(k) ?? 0);
        delta.set(k, d);
        deltaMax = Math.max(deltaMax, Math.abs(d));
        const name = (model.pkInfo.get(k) ?? other.pkInfo.get(k)).name;
        deltaByName.set(name, (deltaByName.get(name) ?? 0) + d);
        if (a.has(k) && b.has(k)) matched++;
        else if (a.has(k)) aOnly++;
        else bOnly++;
      }
      deltaMax = deltaMax || 1;
      st.colorBy = "delta";
      syncControls();
      invalidate();
      return { matched, aOnly, bOnly };
    }

    function get() {
      if (layoutDirty) layout();
      return {
        view: st.view,
        metric: st.metric,
        zoom: { id: st.vp.id, from: st.vp.from, to: st.vp.to },
        zoomPath: [...st.zooms, st.vp]
          .filter((v) => v.id !== null)
          .map((v) => ({ id: v.id, name: describe(v.id)?.name ?? "" })),
        selected: st.sel,
        search: st.search,
        matches,
        trace: st.trace,
        range: st.range ? { ...st.range } : null,
      };
    }

    // Zoom by frame id for callers (breadcrumbs, history). An id already on the zoom path pops back to it.
    function zoomTo(key) {
      if (!model) return false;
      if (key === null) {
        userFit();
        return true;
      }
      if (!(isTime() ? model.byId.has(key) : treeFor().nodes.has(key))) return false;
      const chain = [...st.zooms, st.vp];
      const i = chain.findIndex((v) => v.id === key);
      if (i < 0) {
        userZoomIn(key);
        return true;
      }
      st.vp = chain[i];
      st.zooms = chain.slice(0, i);
      emitZoom();
      emit("change", get());
      invalidate();
      return true;
    }

    // Widest frame of a function name in the current view (time views: span id; merged views: name path).
    function locate(name) {
      const f = filtered();
      if (!f) return null;
      if (isTime()) {
        let best = null;
        for (const s of f.list) if (s.name === name && (!best || s.dur > best.dur)) best = s;
        return best ? best.id : null;
      }
      let key = null;
      let total = -1;
      for (const [k, n] of treeFor().nodes) {
        if (n.name === name && n.total > total) {
          key = k;
          total = n.total;
        }
      }
      return key;
    }

    // Self time per bin across the whole profile: each span's time not covered by its children, binned.
    function density(bins = 200, { exclude = [] } = {}) {
      if (!model || !(bins >= 1)) return [];
      const skip = new Set(exclude);
      const from = model.start;
      const to = model.end > from ? model.end : from + 1;
      const w = (to - from) / bins;
      const out = new Float64Array(bins);
      const add = (a, b) => {
        for (let i = Math.max(0, Math.floor((a - from) / w)); i < bins; i++) {
          const lo = from + i * w;
          if (lo >= b) break;
          const o = Math.min(b, lo + w) - Math.max(a, lo);
          if (o > 0) out[i] += o;
        }
      };
      for (const s of model.spans) {
        if (skip.has(s.name)) continue;
        let cursor = s.start;
        for (const c of s.kids) {
          if (c.start > cursor) add(cursor, c.start);
          cursor = Math.max(cursor, c.end);
        }
        if (s.end > cursor) add(cursor, s.end);
      }
      return Array.from(out, (ms, i) => ({ from: from + i * w, to: from + (i + 1) * w, ms }));
    }

    function set(p = {}) {
      if (p.view !== undefined) applyView(p.view);
      if (p.metric !== undefined) {
        if (!["total", "self"].includes(p.metric))
          throw new Error(`spantree: unknown metric ${p.metric}`);
        st.metric = p.metric;
      }
      if (p.colorBy !== undefined) {
        if (!COLOR_BY.includes(p.colorBy))
          throw new Error(`spantree: unknown colorBy ${p.colorBy}`);
        st.colorBy = p.colorBy;
      }
      if (p.search !== undefined) st.search = String(p.search);
      if (p.selected !== undefined) st.sel = p.selected;
      if (p.minPx !== undefined) st.minPx = p.minPx;
      if (p.rowHeight !== undefined) st.rowHeight = Math.min(28, Math.max(16, p.rowHeight));
      if (p.trace !== undefined) {
        st.trace = p.trace;
        st.sel = null;
        fc = null;
        fitView();
      }
      syncControls();
      invalidate();
    }

    function range(from, to) {
      st.range = from == null || to == null ? null : { from, to };
      fc = null;
      st.sel = null;
      fitView();
      invalidate();
    }

    function criticalPath(rootId) {
      if (!model) return [];
      let cur = null;
      if (rootId !== undefined) {
        cur = model.byId.get(rootId);
        if (!cur) throw new Error(`spantree: no span ${rootId}`);
      } else {
        // Longest root inside the current trace and range filter.
        const f = filtered();
        f.struct ??= timeStructure(f.list);
        for (const r of f.struct.roots) if (!cur || r.dur > cur.dur) cur = r;
      }
      const path = [];
      while (cur) {
        path.push({
          id: cur.id,
          name: cur.name,
          service: cur.service,
          start: cur.start,
          dur: cur.dur,
        });
        let next = null;
        for (const c of cur.kids) if (!next || c.end > next.end) next = c;
        cur = next;
      }
      return path;
    }

    function top({ by = "self", limit = 50 } = {}) {
      if (by !== "self" && by !== "total") throw new Error(`spantree: unknown top key ${by}`);
      const f = filtered();
      if (!f) return [];
      const agg = new Map();
      for (const s of f.list) {
        let a = agg.get(s.name);
        if (!a) {
          a = { name: s.name, file: s.file, line: s.line, selfMs: 0, totalMs: 0, count: 0 };
          agg.set(s.name, a);
        }
        a.selfMs += s.self;
        a.count++;
        if (s.samples !== undefined) a.samples = (a.samples ?? 0) + s.samples;
        let nested = false;
        for (let p = s.parent; p; p = p.parent) {
          if (p.name === s.name) {
            nested = true;
            break;
          }
        }
        if (!nested) a.totalMs += s.dur;
      }
      const rows = [...agg.values()];
      if (deltaByName) for (const r of rows) r.deltaMs = deltaByName.get(r.name) ?? 0;
      rows.sort((x, y) => (by === "total" ? y.totalMs - x.totalMs : y.selfMs - x.selfMs));
      return rows.slice(0, limit);
    }

    function collapsed(id) {
      const f = filtered();
      if (!f) return "";
      // id may be a span id (time views) or a merged-view name path from selection().id.
      const root = id == null ? null : (model.byId.get(id) ?? null);
      const pathRoot = id != null && !root && model.pkInfo.has(id) ? id : null;
      if (id != null && !root && pathRoot === null)
        throw new Error(`spantree: no span or frame path ${id}`);
      // Identical stacks are merged, so sampled profiles fold the same way as flamegraph.pl input.
      const folded = new Map();
      for (const s of f.list) {
        if (s.self <= 0) continue;
        const names = [];
        let inside =
          root === null &&
          (pathRoot === null || s.pk === pathRoot || s.pk.startsWith(pathRoot + SEP));
        for (let p = s; p; p = p.parent) {
          names.unshift(p.name.replace(/[;\n]/g, ":"));
          if (p === root) inside = true;
        }
        if (!inside) continue;
        const stack = names.join(";");
        folded.set(stack, (folded.get(stack) ?? 0) + s.self);
      }
      const lines = [];
      for (const [stack, ms] of folded) {
        const weight = Math.round(ms * 1000);
        if (weight > 0) lines.push(`${stack} ${weight}`);
      }
      return lines.join("\n");
    }

    function traces() {
      if (!model) return [];
      const m = new Map();
      for (const s of model.spans) {
        const key = s.trace ?? "";
        let t = m.get(key);
        if (!t) {
          t = { traceId: s.trace ?? null, start: Infinity, end: -Infinity, spans: 0, error: false };
          m.set(key, t);
        }
        t.start = Math.min(t.start, s.start);
        t.end = Math.max(t.end, s.end);
        t.spans++;
        if (s.error) t.error = true;
      }
      return [...m.values()]
        .map(({ end, ...r }) => ({ ...r, dur: end - r.start }))
        .sort((a, b) => a.start - b.start);
    }

    async function exportPng({ scale = 2 } = {}) {
      const W = stage.clientWidth;
      const H = stage.clientHeight;
      if (W === 0 || H === 0) throw new Error("spantree: the container has no size to export");
      if (W !== cssW || H !== cssH || layoutDirty) {
        cssW = W;
        cssH = H;
        layout();
      }
      const c = document.createElement("canvas");
      c.width = Math.round(W * scale);
      c.height = Math.round(H * scale);
      const g = c.getContext("2d");
      g.setTransform(scale, 0, 0, scale, 0, 0);
      paint(g, W, H);
      return new Promise((resolve, reject) => {
        c.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("spantree: export failed"))),
          "image/png",
        );
      });
    }

    function on(event, cb) {
      if (!["change", "select", "zoom"].includes(event))
        throw new Error(`spantree: unknown event ${event}`);
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
      return () => listeners.get(event).delete(cb);
    }

    function destroy() {
      destroyed = true;
      for (const o of observers) o.disconnect();
      listeners.clear();
      root.remove();
    }

    fitView();
    syncControls();
    return {
      load,
      compare,
      get,
      set,
      range,
      selection: () => describe(st.sel),
      criticalPath,
      top,
      collapsed,
      traces,
      exportPng,
      zoomTo,
      locate,
      density,
      on,
      destroy,
    };
  }

  t3kit.spantree = { create };
})();
