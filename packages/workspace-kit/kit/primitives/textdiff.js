/**
 * t3kit.textdiff: line and word diffs. 2-way review (split or unified, word marks, folded context, per-hunk accept,
 * reject or comment) and 3-way merge (conflict chunks, per-chunk choice, editable result). Rows are virtualized.
 * create(container, options?) -> instance. Under 560 px wide, split renders as unified.
 *   options: mode 'split' | 'unified' | 'merge' (default 'split'), context 3, wrap false, ignoreWhitespace false,
 *            lineNumbers true, labels {a, b} | {ours, base, theirs} (column headers and conflict marker names),
 *            toolbar true (false hides the built-in bar), mergeLayout 'stacked' | 'columns' | 'columns-no-base':
 *            columns = ours | base | theirs aligned per conflict (lines wrap), auto chunks dimmed; stacked when narrow
 * load(input) -> Promise<{hunks} | {chunks, conflicts}>. input {a, b} | {patch} (one-file unified diff) |
 *   {base, ours, theirs} | {conflicted} (diff3 or merge markers); texts are strings, Blobs or Files.
 *   3-way input switches to 'merge'; 2-way input leaves merge for the last diff mode. conflicts: conflict ids.
 * get() 2-way -> {hunks: [{id: 'h1', aStart, aLines, bStart, bLines, status: 'open'|'accepted'|'rejected', comment?}]}
 *   starts are 1-based line numbers as in a unified diff header (an empty side gives the line before).
 * get() merge -> {chunks: [{id, kind: 'auto'|'conflict', choice, text}], unresolved}. ids: a1.. auto, c1.. conflicts.
 *   choice null | 'ours' | 'theirs' | 'both' | 'both-theirs' | 'base' | 'edited'; text is '' while unresolved.
 * set(partial) silent: {any option above?, hunks?: [{id, status?,
 *   comment?}], chunks?: [{id, choice?, text?}]}. Unknown ids throw. ignoreWhitespace re-diffs {a, b} at once and
 *   keeps decisions on hunks whose ranges are unchanged (ids renumber); a merge picks it up on the next load.
 * decide(hunkId, status, comment?) and choose(chunkId, choice, text?) emit 'change'. 'edited' needs text; auto chunks
 *   take only 'edited'; choice null reopens a conflict.
 * next() / prev() -> id | null: select and scroll to the next open hunk or unresolved conflict (no wrap-around).
 * focus(id) -> id: select and scroll to any chunk (merge; resolved ones too). Emits 'select', not 'change'.
 * result({allowMarkers}?) -> string. Merge: throws while conflicts are unresolved unless allowMarkers (then writes
 *   markers). 2-way: a with accepted hunks applied; open and rejected keep a. Throws for {patch} (no full text).
 * acceptedPatch() -> string: one-file unified diff of the accepted hunks only ('' when none). 2-way only.
 * on('change' (get()) | 'select' (id) | 'resolve' ({unresolved}, when the count of open hunks or conflicts changes),
 *   cb) -> unsubscribe. destroy().
 * Keys (click a change first): n / p next and prev; a accept, r reject (again reopens), c comment;
 *   1 ours, 2 theirs, 3 both, Shift+3 both theirs first, 4 base, e edit; Ctrl/Cmd+Enter saves, Escape cancels.
 * Statics: diffLines(a, b) -> [{aStart, aLines, bStart, bLines}] (Myers); diffWords(a, b) -> [{type: 'equal'|
 *   'delete'|'insert', text}]; diff3(base, ours, theirs, {ignoreWhitespace}?) -> [{kind: 'auto', lines} | {kind:
 *   'conflict', base, ours, theirs}] (line arrays); parseConflicts(text) -> {base|null, ours, theirs, hasBase} (whole texts);
 *   parsePatch(text) -> [{oldName, newName, hunks: [{aStart, aLines, bStart, bLines, lines: [{t, text}]}]}].
 * Example:
 *   const d = t3kit.textdiff.create(el);
 *   await d.load({ a: oldBlob, b: newBlob });
 *   d.on('change', (v) => saveReview(v.hunks));
 *   const patch = d.acceptedPatch();
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});

  const ROW_H = 20;
  const HUNK_H = 30;
  const CHEAD_H = 30;
  const EDIT_H = 110;
  const FOLD_H = 24;
  const OVERSCAN = 480;
  const NARROW_PX = 560;
  const LABEL_H = 20;
  const GUTTER_PX = 48;
  const SIGN_PX = 16;
  const CHAR_PX = 7.9;
  const MAX_EDIT_D = 2000;
  const WORD_LIMIT = 4000;
  const WORD_CACHE_MAX = 512;
  const WORD_RE = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;
  const MODES = ["split", "unified", "merge"];
  const CHOICES = ["ours", "theirs", "both", "both-theirs", "base", "edited"];
  const CHOICE_BUTTONS = [
    ["ours", "Ours", "1"],
    ["theirs", "Theirs", "2"],
    ["both", "Both", "3"],
    ["both-theirs", "Theirs First", "Shift+3"],
    ["base", "Base", "4"],
  ];
  const CHOICE_LABEL = {
    ours: "Ours",
    theirs: "Theirs",
    both: "Both",
    "both-theirs": "Theirs First",
    base: "Base",
    edited: "Edited",
  };
  const STATUSES = ["open", "accepted", "rejected"];
  const STATUS_LABEL = { open: "Open", accepted: "Accepted", rejected: "Rejected" };
  const OPTION_KEYS = [
    "mode",
    "context",
    "wrap",
    "ignoreWhitespace",
    "lineNumbers",
    "labels",
    "toolbar",
    "mergeLayout",
  ];
  const SET_KEYS = [
    "mode",
    "context",
    "wrap",
    "lineNumbers",
    "ignoreWhitespace",
    "labels",
    "toolbar",
    "mergeLayout",
    "hunks",
    "chunks",
  ];
  const MERGE_LAYOUTS = ["stacked", "columns", "columns-no-base"];
  // Columns a resolved conflict keeps lit in the column layout (the others dim).
  const PICKED = {
    ours: ["ours"],
    theirs: ["theirs"],
    both: ["ours", "theirs"],
    "both-theirs": ["ours", "theirs"],
    base: ["base"],
  };
  const LABEL_KEYS = ["a", "b", "ours", "base", "theirs"];
  const EVENTS = ["change", "select", "resolve"];
  const INPUT_KINDS = new Map([
    ["a,b", "ab"],
    ["patch", "patch"],
    ["base,ours,theirs", "3way"],
    ["conflicted", "conflicted"],
  ]);
  const wordCache = new Map();
  const CSS = `
.t3k-textdiff-root{box-sizing:border-box;display:flex;flex-direction:column;position:relative;width:100%;height:100%;min-width:0;min-height:160px;overflow:hidden;background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:var(--radius);font-family:var(--font-mono);font-size:12.5px;line-height:20px;--t3k-textdiff-gutter:48px}
.t3k-textdiff-root *{box-sizing:border-box}
.t3k-textdiff-root [hidden]{display:none!important}
.t3k-textdiff-root:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.t3k-textdiff-root button{font-family:var(--font-sans);font-size:12px;line-height:18px;padding:2px 8px;border:1px solid var(--border);border-radius:calc(var(--radius) - 2px);background:var(--card);color:var(--card-foreground);cursor:pointer;white-space:nowrap}
.t3k-textdiff-root button:hover{border-color:var(--ring)}
.t3k-textdiff-root button:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.t3k-textdiff-root button[aria-pressed="true"]{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}
.t3k-textdiff-root button:disabled{opacity:.5;cursor:default;border-color:var(--border)}
.t3k-textdiff-bar{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:6px 8px;border-bottom:1px solid var(--border);background:var(--card);color:var(--card-foreground);font-family:var(--font-sans);font-size:12px;line-height:18px}
.t3k-textdiff-status{flex:1 1 auto;min-width:0;color:var(--muted-foreground)}
.t3k-textdiff-cols{flex:none;overflow:hidden;border-bottom:1px solid var(--border);background:var(--muted);color:var(--muted-foreground);font-family:var(--font-sans);font-size:11px;line-height:18px}
.t3k-textdiff-scroll{position:relative;flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;background:var(--background)}
.t3k-textdiff-spacer{position:relative;min-width:100%}
.t3k-textdiff-item{position:absolute;left:0;right:0;overflow:hidden}
.t3k-textdiff-band{right:auto;width:var(--t3k-textdiff-vw,100%);transform:translateX(var(--t3k-textdiff-sx,0px))}
.t3k-textdiff-item.t3k-textdiff-sel::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--ring)}
.t3k-textdiff-item.t3k-textdiff-rej{opacity:.55}
.t3k-textdiff-srow{display:grid;grid-template-columns:var(--t3k-textdiff-gutter) minmax(0,1fr) var(--t3k-textdiff-gutter) minmax(0,1fr);min-height:20px}
.t3k-textdiff-urow{display:grid;grid-template-columns:var(--t3k-textdiff-gutter) var(--t3k-textdiff-gutter) 16px minmax(0,1fr);min-height:20px}
.t3k-textdiff-mline{display:grid;grid-template-columns:var(--t3k-textdiff-gutter) minmax(0,1fr);min-height:20px}
.t3k-textdiff-gutter{min-width:0;overflow:hidden;padding:0 6px 0 4px;text-align:right;white-space:nowrap;color:var(--muted-foreground);background:var(--muted);user-select:none}
.t3k-textdiff-sign{text-align:center;color:var(--muted-foreground);background:var(--background);user-select:none}
.t3k-textdiff-code{min-width:0;overflow:hidden;text-overflow:ellipsis;padding:0 8px;white-space:pre;tab-size:4}
.t3k-textdiff-wrap .t3k-textdiff-code{white-space:pre-wrap;overflow-wrap:anywhere}
.t3k-textdiff-wrap .t3k-textdiff-gutter{white-space:normal}
.t3k-textdiff-del{background:color-mix(in srgb,var(--destructive) 14%,transparent)}
.t3k-textdiff-ins{background:color-mix(in srgb,var(--success) 16%,transparent)}
.t3k-textdiff-none{background:var(--muted)}
.t3k-textdiff-g-del{background:color-mix(in srgb,var(--destructive) 26%,transparent);color:var(--foreground)}
.t3k-textdiff-g-ins{background:color-mix(in srgb,var(--success) 28%,transparent);color:var(--foreground)}
.t3k-textdiff-wm{color:inherit;background:transparent;padding:0;border-radius:2px}
.t3k-textdiff-wm-del{background:color-mix(in srgb,var(--destructive) 38%,transparent)}
.t3k-textdiff-wm-ins{background:color-mix(in srgb,var(--success) 42%,transparent)}
.t3k-textdiff-fold{display:flex;align-items:center;gap:10px;padding:0 8px;background:var(--muted);color:var(--muted-foreground);font-family:var(--font-sans);font-size:12px;line-height:20px;white-space:nowrap}
.t3k-textdiff-fold button{margin-left:auto}
.t3k-textdiff-gap{padding:0 8px;background:var(--muted);color:var(--muted-foreground);font-family:var(--font-sans);font-style:italic;font-size:12px;line-height:24px}
.t3k-textdiff-hunk{display:flex;flex-direction:column;gap:4px;padding:4px 8px;background:var(--card);color:var(--card-foreground);border-top:1px solid var(--border);border-bottom:1px solid var(--border);font-family:var(--font-sans);font-size:12px;line-height:18px}
.t3k-textdiff-hbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.t3k-textdiff-range{min-width:0;margin-right:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted-foreground)}
.t3k-textdiff-badge{padding:0 6px;border:1px solid var(--border);border-radius:999px;color:var(--muted-foreground);font-size:11px;line-height:16px}
.t3k-textdiff-hunk[data-status="accepted"] .t3k-textdiff-badge{color:var(--success);border-color:var(--success)}
.t3k-textdiff-hunk[data-status="rejected"] .t3k-textdiff-badge{color:var(--destructive);border-color:var(--destructive)}
.t3k-textdiff-note{padding-top:2px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--foreground)}
.t3k-textdiff-actions{display:flex;justify-content:flex-end;gap:6px}
.t3k-textdiff-chead{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:4px 8px;background:var(--card);color:var(--card-foreground);border-top:1px solid var(--border);font-family:var(--font-sans);font-size:12px;line-height:18px}
.t3k-textdiff-title{font-weight:600}
.t3k-textdiff-state{margin-right:auto;color:var(--muted-foreground)}
.t3k-textdiff-chead[data-state="unresolved"] .t3k-textdiff-state{color:var(--warning)}
.t3k-textdiff-edit{display:flex;flex-direction:column;gap:6px;padding:6px 8px;background:var(--card);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.t3k-textdiff-ta{display:block;width:100%;min-height:72px;resize:vertical;padding:6px 8px;font-family:var(--font-mono);font-size:12.5px;line-height:20px;tab-size:4;color:var(--foreground);background:var(--background);border:1px solid var(--ring);border-radius:calc(var(--radius) - 2px)}
.t3k-textdiff-mline.t3k-textdiff-side-ours{background:color-mix(in srgb,var(--info) 14%,transparent);box-shadow:inset 3px 0 0 var(--info)}
.t3k-textdiff-mline.t3k-textdiff-side-theirs{background:color-mix(in srgb,var(--warning) 14%,transparent);box-shadow:inset 3px 0 0 var(--warning)}
.t3k-textdiff-mline.t3k-textdiff-side-result,.t3k-textdiff-mline.t3k-textdiff-side-edited{box-shadow:inset 3px 0 0 var(--success)}
.t3k-textdiff-mline.t3k-textdiff-placeholder .t3k-textdiff-code{font-style:italic;color:var(--muted-foreground)}
.t3k-textdiff-sep{width:1px;align-self:stretch;margin:2px 2px;background:var(--border)}
.t3k-textdiff-htitle{font-weight:600}
.t3k-textdiff-mlabel{display:flex;align-items:center;gap:6px;padding:0 8px;font-family:var(--font-sans);font-size:11px;line-height:20px;color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.t3k-textdiff-mlabel.t3k-textdiff-side-ours{box-shadow:inset 3px 0 0 var(--info)}
.t3k-textdiff-mlabel.t3k-textdiff-side-theirs{box-shadow:inset 3px 0 0 var(--warning)}
.t3k-textdiff-mlabel.t3k-textdiff-side-base{box-shadow:inset 3px 0 0 var(--muted-foreground)}
.t3k-textdiff-mline.t3k-textdiff-side-base{background:var(--muted);color:var(--muted-foreground);box-shadow:inset 3px 0 0 var(--muted-foreground)}
.t3k-textdiff-key{margin-left:4px;color:var(--muted-foreground);font-family:var(--font-mono);font-size:10px}
button[aria-pressed="true"] .t3k-textdiff-key{color:inherit;opacity:.75}
.t3k-textdiff-m3row{display:grid;grid-template-columns:var(--t3k-textdiff-gutter) repeat(var(--t3k-textdiff-ncols,3),minmax(0,1fr));min-height:20px}
.t3k-textdiff-m3row>.t3k-textdiff-code+.t3k-textdiff-code{border-left:1px solid var(--border)}
.t3k-textdiff-cols .t3k-textdiff-m3row>.t3k-textdiff-code{padding:0 8px;box-shadow:inset 0 -2px 0 var(--t3k-textdiff-tone,var(--border))}
.t3k-textdiff-c-ours{--t3k-textdiff-tone:var(--info)}
.t3k-textdiff-c-theirs{--t3k-textdiff-tone:var(--warning)}
.t3k-textdiff-c-base{--t3k-textdiff-tone:var(--muted-foreground)}
.t3k-textdiff-item .t3k-textdiff-c-ours{background:color-mix(in srgb,var(--info) 12%,transparent)}
.t3k-textdiff-item .t3k-textdiff-c-theirs{background:color-mix(in srgb,var(--warning) 12%,transparent)}
.t3k-textdiff-item .t3k-textdiff-c-base{background:var(--muted);color:var(--muted-foreground)}
.t3k-textdiff-item .t3k-textdiff-blank{background:var(--muted)}
.t3k-textdiff-item.t3k-textdiff-m3row>.t3k-textdiff-code{white-space:pre-wrap;overflow-wrap:anywhere;text-overflow:clip}
.t3k-textdiff-item .t3k-textdiff-nolines{font-style:italic;color:var(--muted-foreground)}
.t3k-textdiff-item .t3k-textdiff-unpicked{opacity:.38}
.t3k-textdiff-m3[data-state="unresolved"]{--t3k-textdiff-ol:var(--warning)}
.t3k-textdiff-m3[data-state="resolved"]{--t3k-textdiff-ol:color-mix(in srgb,var(--success) 55%,transparent)}
.t3k-textdiff-m3{box-shadow:inset 1px 0 0 var(--t3k-textdiff-ol),inset -1px 0 0 var(--t3k-textdiff-ol)}
.t3k-textdiff-m3.t3k-textdiff-chead{border-top:0;box-shadow:inset 1px 0 0 var(--t3k-textdiff-ol),inset -1px 0 0 var(--t3k-textdiff-ol),inset 0 1px 0 var(--t3k-textdiff-ol)}
.t3k-textdiff-m3.t3k-textdiff-last{box-shadow:inset 1px 0 0 var(--t3k-textdiff-ol),inset -1px 0 0 var(--t3k-textdiff-ol),inset 0 -1px 0 var(--t3k-textdiff-ol)}
.t3k-textdiff-layout-columns .t3k-textdiff-side-auto{opacity:.5}
.t3k-textdiff-layout-columns .t3k-textdiff-side-auto .t3k-textdiff-gutter{background:transparent}
.t3k-textdiff-empty{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;color:var(--muted-foreground);font-family:var(--font-sans);font-size:13px}
`;

  // ---------- Text helpers ----------

  function splitLines(text) {
    if (text === "") return [];
    const parts = text.split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  }

  function joinLines(lines) {
    return lines.length ? lines.join("\n") + "\n" : "";
  }

  function toLines(v) {
    if (Array.isArray(v)) return v;
    if (typeof v !== "string")
      throw new TypeError("textdiff: expected a string or an array of lines");
    return splitLines(v);
  }

  function range(n) {
    return Array.from({ length: n }, (_, i) => i + 1);
  }

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function actBtn(label, act, id, pressed) {
    const b = node("button", null, label);
    b.type = "button";
    b.dataset.act = act;
    if (id !== undefined) b.dataset.id = id;
    if (pressed !== undefined) b.setAttribute("aria-pressed", String(pressed));
    return b;
  }

  // Adds the shortcut as a quiet hint inside the button and in its tooltip.
  function keyBtn(b, key) {
    b.appendChild(node("span", "t3k-textdiff-key", key));
    b.title = `Shortcut ${key}`;
    b.setAttribute("aria-keyshortcuts", key);
    return b;
  }

  function actionRow(list) {
    const row = node("div", "t3k-textdiff-actions");
    for (const [label, act, id] of list) row.appendChild(actBtn(label, act, id));
    return row;
  }

  function textarea(kind, id, value, label) {
    const ta = node("textarea", "t3k-textdiff-ta");
    ta.spellcheck = false;
    ta.dataset.kind = kind;
    ta.dataset.id = id;
    ta.value = value;
    ta.setAttribute("aria-label", label);
    return ta;
  }

  function appendSegs(parent, segs, kind) {
    for (const s of segs) {
      if (s.changed)
        parent.appendChild(node("mark", "t3k-textdiff-wm t3k-textdiff-wm-" + kind, s.text));
      else parent.appendChild(document.createTextNode(s.text));
    }
  }

  function ensureStyle() {
    if (document.querySelector('style[data-t3kit="textdiff"]')) return;
    const s = document.createElement("style");
    s.dataset.t3kit = "textdiff";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---------- Myers diff on integer token arrays ----------

  // Greedy forward Myers with per-round snapshots (memory is O(D^2) for edit distance D). Returns forward-ordered
  // {K, A, B} arrays with absolute indexes, or null when D exceeds MAX_EDIT_D.
  function myersMid(a, ao, n, b, bo, m) {
    const max = n + m;
    if (max === 0) return { K: [], A: [], B: [] };
    const off = max + 1;
    const V = new Int32Array(2 * max + 3);
    const trace = [];
    let dEnd = -1;
    for (let d = 0; d <= max && d <= MAX_EDIT_D && dEnd < 0; d++) {
      trace.push(V.slice(off - d - 1, off + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x =
          k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])
            ? V[off + k + 1]
            : V[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[ao + x] === b[bo + y]) {
          x++;
          y++;
        }
        V[off + k] = x;
        if (x >= n && y >= m) {
          dEnd = d;
          break;
        }
      }
    }
    if (dEnd < 0) return null;
    const K = [],
      A = [],
      B = [];
    let x = n,
      y = m;
    for (let d = dEnd; d >= 0; d--) {
      const v = trace[d];
      const k = x - y;
      const prevK = k === -d || (k !== d && v[k + d] < v[k + d + 2]) ? k + 1 : k - 1;
      const prevX = v[prevK + d + 1];
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        x--;
        y--;
        K.push(0);
        A.push(ao + x);
        B.push(bo + y);
      }
      if (d > 0) {
        if (x === prevX) {
          K.push(2);
          A.push(-1);
          B.push(bo + prevY);
        } else {
          K.push(1);
          A.push(ao + prevX);
          B.push(-1);
        }
      }
      x = prevX;
      y = prevY;
    }
    K.reverse();
    A.reverse();
    B.reverse();
    return { K, A, B };
  }

  // Trims common prefix and suffix, then runs Myers on the middle. Falls back to one coarse delete and insert block
  // when the middle is too different to diff within MAX_EDIT_D.
  function editOps(a, b) {
    const N = a.length,
      M = b.length;
    const lim = Math.min(N, M);
    let pre = 0;
    while (pre < lim && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < lim - pre && a[N - 1 - suf] === b[M - 1 - suf]) suf++;
    const K = [],
      A = [],
      B = [];
    for (let i = 0; i < pre; i++) {
      K.push(0);
      A.push(i);
      B.push(i);
    }
    const mid = myersMid(a, pre, N - pre - suf, b, pre, M - pre - suf);
    if (mid) {
      for (let q = 0; q < mid.K.length; q++) {
        K.push(mid.K[q]);
        A.push(mid.A[q]);
        B.push(mid.B[q]);
      }
    } else {
      for (let i = pre; i < N - suf; i++) {
        K.push(1);
        A.push(i);
        B.push(-1);
      }
      for (let j = pre; j < M - suf; j++) {
        K.push(2);
        A.push(-1);
        B.push(j);
      }
    }
    for (let i = 0; i < suf; i++) {
      K.push(0);
      A.push(N - suf + i);
      B.push(M - suf + i);
    }
    return { K, A, B };
  }

  // Within each run of deletes and inserts, deletes come first, so row i pairs delete i with insert i.
  // Kind 3 (gap, patch only) is a boundary, with its count in A.
  function normalizeRuns(K, A, B) {
    const oK = [],
      oA = [],
      oB = [];
    let i = 0;
    while (i < K.length) {
      if (K[i] === 1 || K[i] === 2) {
        const dels = [],
          ins = [];
        while (i < K.length && (K[i] === 1 || K[i] === 2)) {
          (K[i] === 1 ? dels : ins).push(i);
          i++;
        }
        for (const q of dels) {
          oK.push(1);
          oA.push(A[q]);
          oB.push(-1);
        }
        for (const q of ins) {
          oK.push(2);
          oA.push(-1);
          oB.push(B[q]);
        }
      } else {
        oK.push(K[i]);
        oA.push(A[i]);
        oB.push(B[i]);
        i++;
      }
    }
    return { K: oK, A: oA, B: oB };
  }

  // Hunks are maximal runs of non-equal ops. Starts follow unified-diff rules: an empty side reports the line before.
  function buildHunks(m) {
    const { K, A, B, aNo, bNo } = m;
    const n = K.length;
    const hunks = [];
    const hunkOf = new Int32Array(n).fill(-1);
    let lastA = 0,
      lastB = 0;
    let i = 0;
    while (i < n) {
      const k = K[i];
      if (k === 0) {
        lastA = aNo[A[i]];
        lastB = bNo[B[i]];
        i++;
        continue;
      }
      if (k === 3) {
        lastA += A[i];
        lastB += A[i];
        i++;
        continue;
      }
      const start = i;
      const beforeA = lastA,
        beforeB = lastB;
      let dels = 0,
        ins = 0,
        firstDel = -1,
        lastDel = -1,
        firstIns = -1,
        lastIns = -1;
      while (i < n && (K[i] === 1 || K[i] === 2)) {
        if (K[i] === 1) {
          if (firstDel < 0) firstDel = i;
          lastDel = i;
          dels++;
        } else {
          if (firstIns < 0) firstIns = i;
          lastIns = i;
          ins++;
        }
        i++;
      }
      const h = hunks.length;
      for (let q = start; q < i; q++) hunkOf[q] = h;
      hunks.push({
        id: "h" + (h + 1),
        aStart: dels ? aNo[A[firstDel]] : beforeA,
        aLines: dels,
        bStart: ins ? bNo[B[firstIns]] : beforeB,
        bLines: ins,
        status: "open",
      });
      lastA = dels ? aNo[A[lastDel]] : beforeA;
      lastB = ins ? bNo[B[lastIns]] : beforeB;
    }
    return { hunks, hunkOf };
  }

  function buildModel(raw) {
    const norm = normalizeRuns(raw.K, raw.A, raw.B);
    const m = {
      kind: raw.kind,
      aText: raw.aText,
      bText: raw.bText,
      aNo: Int32Array.from(raw.aNo),
      bNo: Int32Array.from(raw.bNo),
      K: Uint8Array.from(norm.K),
      A: Int32Array.from(norm.A),
      B: Int32Array.from(norm.B),
    };
    const built = buildHunks(m);
    m.hunks = built.hunks;
    m.hunkOf = built.hunkOf;
    return m;
  }

  function abModel(aLines, bLines, ignoreWs) {
    const ids = new Map();
    const idOf = (s) => {
      const key = ignoreWs ? s.replace(/\s+/g, " ").trim() : s;
      let v = ids.get(key);
      if (v === undefined) {
        v = ids.size;
        ids.set(key, v);
      }
      return v;
    };
    const ops = editOps(Int32Array.from(aLines, idOf), Int32Array.from(bLines, idOf));
    return buildModel({
      kind: "ab",
      aText: aLines,
      bText: bLines,
      aNo: range(aLines.length),
      bNo: range(bLines.length),
      K: ops.K,
      A: ops.A,
      B: ops.B,
    });
  }

  // Model for a one-file patch: hunk lines carry their file line numbers; lines between hunks are a gap (kind 3).
  function patchModel(file) {
    const aText = [],
      aNo = [],
      bText = [],
      bNo = [],
      K = [],
      A = [],
      B = [];
    let lastA = 0;
    for (const h of file.hunks) {
      const aNext = h.aLines > 0 ? h.aStart : h.aStart + 1;
      const bNext = h.bLines > 0 ? h.bStart : h.bStart + 1;
      const gap = aNext - 1 - lastA;
      if (gap > 0) {
        K.push(3);
        A.push(gap);
        B.push(-1);
      }
      let an = aNext,
        bn = bNext;
      for (const l of h.lines) {
        if (l.t === " ") {
          aText.push(l.text);
          aNo.push(an++);
          bText.push(l.text);
          bNo.push(bn++);
          K.push(0);
          A.push(aText.length - 1);
          B.push(bText.length - 1);
        } else if (l.t === "-") {
          aText.push(l.text);
          aNo.push(an++);
          K.push(1);
          A.push(aText.length - 1);
          B.push(-1);
        } else {
          bText.push(l.text);
          bNo.push(bn++);
          K.push(2);
          A.push(-1);
          B.push(bText.length - 1);
        }
      }
      lastA = an - 1;
    }
    return buildModel({ kind: "patch", aText, bText, aNo, bNo, K, A, B });
  }

  // ---------- Word diff ----------

  function wordSegs(a, b) {
    if (a.length > WORD_LIMIT || b.length > WORD_LIMIT) return null;
    const key = a + "\u0001" + b;
    const hit = wordCache.get(key);
    if (hit) return hit;
    const ta = a.match(WORD_RE) || [];
    const tb = b.match(WORD_RE) || [];
    const ids = new Map();
    const id = (t) => {
      let v = ids.get(t);
      if (v === undefined) {
        v = ids.size;
        ids.set(t, v);
      }
      return v;
    };
    const ops = editOps(Int32Array.from(ta, id), Int32Array.from(tb, id));
    const outA = [],
      outB = [];
    const add = (list, text, changed) => {
      const last = list[list.length - 1];
      if (last && last.changed === changed) last.text += text;
      else list.push({ text, changed });
    };
    for (let q = 0; q < ops.K.length; q++) {
      const k = ops.K[q];
      if (k === 0) {
        add(outA, ta[ops.A[q]], false);
        add(outB, tb[ops.B[q]], false);
      } else if (k === 1) add(outA, ta[ops.A[q]], true);
      else add(outB, tb[ops.B[q]], true);
    }
    const res = { a: outA, b: outB };
    if (wordCache.size >= WORD_CACHE_MAX) wordCache.clear();
    wordCache.set(key, res);
    return res;
  }

  // ---------- Three-way merge ----------

  // Changes of `side` against base, as half-open 0-based ranges: base [bs, be) became lines [ss, se).
  function changeList(a, b, ignoreWs, side) {
    const m = abModel(a, b, ignoreWs);
    const out = [];
    let ai = 0,
      bi = 0;
    let i = 0;
    while (i < m.K.length) {
      if (m.K[i] === 0) {
        ai++;
        bi++;
        i++;
        continue;
      }
      const bs = ai,
        ss = bi;
      while (i < m.K.length && m.K[i] !== 0) {
        if (m.K[i] === 1) ai++;
        else bi++;
        i++;
      }
      out.push({ bs, be: ai, ss, se: bi, side });
    }
    return out;
  }

  // Lines of one side across a region of base: base lines where that side made no change.
  function sideLines(base, r, lines, side) {
    const out = [];
    let pos = r.bs;
    for (const c of r.changes) {
      if (c.side !== side) continue;
      for (let q = pos; q < c.bs; q++) out.push(base[q]);
      for (let q = c.ss; q < c.se; q++) out.push(lines[q]);
      pos = c.be;
    }
    for (let q = pos; q < r.be; q++) out.push(base[q]);
    return out;
  }

  function sameLines(x, y) {
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  function pushSpec(specs, spec) {
    const last = specs[specs.length - 1];
    if (spec.kind === "auto" && last && last.kind === "auto")
      last.lines = last.lines.concat(spec.lines);
    else specs.push(spec);
  }

  // Overlapping or touching changes from both sides form one region. A region is auto when only one side changed or
  // both sides produced the same lines; otherwise it is a conflict.
  function diff3Specs(base, ours, theirs, ignoreWs) {
    const changes = changeList(base, ours, ignoreWs, 0)
      .concat(changeList(base, theirs, ignoreWs, 1))
      .sort((x, y) => x.bs - y.bs || x.be - y.be || x.side - y.side);
    const regions = [];
    let cur = null;
    for (const c of changes) {
      if (cur && c.bs <= cur.be) {
        cur.be = Math.max(cur.be, c.be);
        cur.changes.push(c);
      } else {
        cur = { bs: c.bs, be: c.be, changes: [c] };
        regions.push(cur);
      }
    }
    const specs = [];
    let p = 0;
    for (const r of regions) {
      if (r.bs > p) pushSpec(specs, { kind: "auto", lines: base.slice(p, r.bs) });
      const oursChanged = r.changes.some((c) => c.side === 0);
      const theirsChanged = r.changes.some((c) => c.side === 1);
      const oursL = sideLines(base, r, ours, 0);
      const theirsL = sideLines(base, r, theirs, 1);
      if (!theirsChanged) pushSpec(specs, { kind: "auto", lines: oursL });
      else if (!oursChanged) pushSpec(specs, { kind: "auto", lines: theirsL });
      else if (sameLines(oursL, theirsL)) pushSpec(specs, { kind: "auto", lines: oursL });
      else
        specs.push({
          kind: "conflict",
          ours: oursL,
          theirs: theirsL,
          base: base.slice(r.bs, r.be),
          hasBase: true,
        });
      p = r.be;
    }
    if (p < base.length) pushSpec(specs, { kind: "auto", lines: base.slice(p) });
    return specs;
  }

  // Conflict markers to specs. Merge-style markers (no ||||||| section) get hasBase false.
  function parseConflictSegments(text) {
    const lines = splitLines(text);
    const specs = [];
    let auto = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^<{7}(\s|$)/.test(lines[i])) {
        auto.push(lines[i]);
        continue;
      }
      if (auto.length) {
        specs.push({ kind: "auto", lines: auto });
        auto = [];
      }
      const start = i;
      let section = "ours";
      let hasBase = false;
      let closed = false;
      const sec = { ours: [], base: [], theirs: [] };
      for (i = i + 1; i < lines.length; i++) {
        const l = lines[i];
        if (section === "ours" && /^\|{7}(\s|$)/.test(l)) {
          section = "base";
          hasBase = true;
        } else if (section !== "theirs" && /^={7}$/.test(l)) {
          section = "theirs";
        } else if (section === "theirs" && /^>{7}(\s|$)/.test(l)) {
          closed = true;
          break;
        } else sec[section].push(l);
      }
      if (!closed)
        throw new Error(`textdiff: conflict starting at line ${start + 1} has no >>>>>>> marker`);
      specs.push({ kind: "conflict", ours: sec.ours, base: sec.base, theirs: sec.theirs, hasBase });
    }
    if (auto.length) specs.push({ kind: "auto", lines: auto });
    return specs;
  }

  function sideOfSpecs(specs, side) {
    const out = [];
    for (const s of specs) {
      const arr = s.kind === "auto" ? s.lines : s[side];
      for (const l of arr) out.push(l);
    }
    return out;
  }

  // Auto chunks are a1, a2..; conflicts are c1, c2.. so 'c1' is always the first conflict.
  function mergeChunks(specs) {
    let autoNo = 0,
      conflictNo = 0;
    return specs.map((s) => ({
      id: s.kind === "auto" ? "a" + ++autoNo : "c" + ++conflictNo,
      no: s.kind === "auto" ? autoNo : conflictNo,
      kind: s.kind,
      choice: null,
      lines: s.kind === "auto" ? s.lines : null,
      ours: s.kind === "conflict" ? s.ours : null,
      theirs: s.kind === "conflict" ? s.theirs : null,
      base: s.kind === "conflict" ? s.base : null,
      hasBase: s.kind === "conflict" ? s.hasBase : false,
      edited: null,
    }));
  }

  // The lines a chunk contributes to the result, or null while a conflict is unresolved.
  function resolvedLines(c) {
    if (c.kind === "auto") return c.choice === "edited" ? c.edited : c.lines;
    switch (c.choice) {
      case "ours":
        return c.ours;
      case "theirs":
        return c.theirs;
      case "both":
        return c.ours.concat(c.theirs);
      case "both-theirs":
        return c.theirs.concat(c.ours);
      case "base":
        return c.base;
      case "edited":
        return c.edited;
      default:
        return null;
    }
  }

  function textOf(lines) {
    return joinLines(lines || []);
  }

  // ---------- Patch parsing ----------

  function patchName(raw) {
    const name = raw.split("\t")[0].trim();
    if (name === "/dev/null") return null;
    return name.replace(/^[ab]\//, "");
  }

  function parsePatch(text) {
    const lines = splitLines(text);
    const files = [];
    let file = null,
      hunk = null,
      remA = 0,
      remB = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (hunk && (remA > 0 || remB > 0)) {
        const t = line.charAt(0);
        if (t === "-") {
          hunk.lines.push({ t, text: line.slice(1) });
          remA--;
        } else if (t === "+") {
          hunk.lines.push({ t, text: line.slice(1) });
          remB--;
        } else if (t === " " || line === "") {
          hunk.lines.push({ t: " ", text: line.slice(1) });
          remA--;
          remB--;
        } else throw new Error(`textdiff.parsePatch: unexpected line ${i + 1} inside a hunk`);
        continue;
      }
      if (line.startsWith("\\")) continue;
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hm) {
        if (!file) throw new Error(`textdiff.parsePatch: hunk at line ${i + 1} has no file header`);
        hunk = {
          aStart: Number(hm[1]),
          aLines: hm[2] === undefined ? 1 : Number(hm[2]),
          bStart: Number(hm[3]),
          bLines: hm[4] === undefined ? 1 : Number(hm[4]),
          lines: [],
        };
        remA = hunk.aLines;
        remB = hunk.bLines;
        file.hunks.push(hunk);
        continue;
      }
      if (line.startsWith("--- ")) {
        file = { oldName: patchName(line.slice(4)), newName: null, hunks: [] };
        files.push(file);
        hunk = null;
        continue;
      }
      if (line.startsWith("+++ ") && file && file.newName === null) {
        file.newName = patchName(line.slice(4));
        hunk = null;
      }
    }
    return files;
  }

  // ---------- Options and validation ----------

  function checkContext(v) {
    if (!Number.isInteger(v) || v < 0)
      throw new TypeError("textdiff: context must be an integer >= 0");
    return v;
  }

  function checkBool(v, name) {
    if (typeof v !== "boolean") throw new TypeError(`textdiff: ${name} must be a boolean`);
    return v;
  }

  function checkLabels(v) {
    if (!v || typeof v !== "object") throw new TypeError("textdiff: labels must be an object");
    for (const k of Object.keys(v))
      if (!LABEL_KEYS.includes(k)) throw new TypeError(`textdiff: unknown label "${k}"`);
    return v;
  }

  function checkStatus(s) {
    if (!STATUSES.includes(s))
      throw new TypeError(`textdiff: status must be ${STATUSES.join(", ")}`);
    return s;
  }

  function setComment(h, c) {
    if (c === null) {
      delete h.comment;
      return;
    }
    if (typeof c !== "string") throw new TypeError("textdiff: comment must be a string or null");
    if (c.trim() === "") delete h.comment;
    else h.comment = c;
  }

  function readOptions(o) {
    const out = {
      mode: "split",
      context: 3,
      wrap: false,
      ignoreWhitespace: false,
      lineNumbers: true,
      labels: {},
      toolbar: true,
      mergeLayout: "stacked",
    };
    if (o === undefined) return out;
    if (!o || typeof o !== "object")
      throw new TypeError("textdiff.create: options must be an object");
    for (const k of Object.keys(o))
      if (!OPTION_KEYS.includes(k)) throw new TypeError(`textdiff.create: unknown option "${k}"`);
    if (o.mode !== undefined) {
      if (!MODES.includes(o.mode))
        throw new TypeError(`textdiff.create: mode must be ${MODES.join(", ")}`);
      out.mode = o.mode;
    }
    if (o.context !== undefined) out.context = checkContext(o.context);
    if (o.wrap !== undefined) out.wrap = checkBool(o.wrap, "wrap");
    if (o.ignoreWhitespace !== undefined)
      out.ignoreWhitespace = checkBool(o.ignoreWhitespace, "ignoreWhitespace");
    if (o.lineNumbers !== undefined) out.lineNumbers = checkBool(o.lineNumbers, "lineNumbers");
    if (o.labels !== undefined) out.labels = checkLabels(o.labels);
    if (o.toolbar !== undefined) out.toolbar = checkBool(o.toolbar, "toolbar");
    if (o.mergeLayout !== undefined) out.mergeLayout = checkMergeLayout(o.mergeLayout);
    return out;
  }

  function checkMergeLayout(v) {
    if (!MERGE_LAYOUTS.includes(v))
      throw new TypeError(`textdiff: mergeLayout must be ${MERGE_LAYOUTS.join(", ")}`);
    return v;
  }

  function inputKind(input) {
    if (!input || typeof input !== "object")
      throw new TypeError("textdiff.load: input must be an object");
    const kind = INPUT_KINDS.get(Object.keys(input).sort().join(","));
    if (!kind)
      throw new TypeError(
        "textdiff.load: input must be {a, b}, {patch}, {base, ours, theirs} or {conflicted}",
      );
    return kind;
  }

  async function readText(v, key) {
    if (typeof v === "string") return v;
    if (v instanceof Blob) return v.text();
    throw new TypeError(`textdiff.load: "${key}" must be a string, Blob or File`);
  }

  function hunkOut(h) {
    const o = {
      id: h.id,
      aStart: h.aStart,
      aLines: h.aLines,
      bStart: h.bStart,
      bLines: h.bLines,
      status: h.status,
    };
    if (h.comment !== undefined) o.comment = h.comment;
    return o;
  }

  // ---------- Instance ----------

  function create(container, options) {
    if (!(container instanceof HTMLElement))
      throw new TypeError("textdiff.create: container must be an HTMLElement");
    const opt = readOptions(options);
    ensureStyle();

    const st = {
      mode: opt.mode,
      diffMode: opt.mode === "merge" ? "split" : opt.mode,
      kind: null,
      model: null,
      merge: null,
      names: { a: "a", b: "b" },
      context: opt.context,
      wrap: opt.wrap,
      lineNumbers: opt.lineNumbers,
      ignoreWs: opt.ignoreWhitespace,
      toolbar: opt.toolbar,
      mergeLayout: opt.mergeLayout,
      labels: Object.assign(
        { a: "Original", b: "Changed", ours: "Ours", base: "Base", theirs: "Theirs" },
        opt.labels,
      ),
      userLabels: Object.assign({}, opt.labels),
      selected: null,
      items: [],
      offs: new Float64Array(1),
      ownerIndex: new Map(),
      expanded: new Set(),
      commentOpen: new Set(),
      commentDraft: new Map(),
      editing: new Set(),
      editDraft: new Map(),
      loading: false,
      lastUnresolved: 0,
      maxChars: 0,
      narrow: false,
      texts: null,
      destroyed: false,
    };

    const root = node("div", "t3k-textdiff-root");
    root.tabIndex = 0;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Text diff");
    const bar = node("div", "t3k-textdiff-bar");
    const btnSplit = actBtn("Split", "mode");
    btnSplit.dataset.mode = "split";
    const btnUnified = actBtn("Unified", "mode");
    btnUnified.dataset.mode = "unified";
    const btnWrap = actBtn("Wrap", "wrap");
    const btnWs = actBtn("Ignore Whitespace", "ws");
    btnWs.title = "Compare lines with whitespace collapsed";
    const statusEl = node("span", "t3k-textdiff-status");
    statusEl.setAttribute("aria-live", "polite");
    const btnPrev = actBtn("Previous", "prev");
    btnPrev.title = "Previous open change (P)";
    const btnNext = actBtn("Next", "next");
    btnNext.title = "Next open change (N)";
    const sep = node("span", "t3k-textdiff-sep");
    bar.append(btnSplit, btnUnified, sep, btnWrap, btnWs, statusEl, btnPrev, btnNext);
    const cols = node("div", "t3k-textdiff-cols");
    const colsIn = node("div", "t3k-textdiff-srow");
    cols.appendChild(colsIn);
    const scroll = node("div", "t3k-textdiff-scroll");
    const spacer = node("div", "t3k-textdiff-spacer");
    const emptyEl = node("div", "t3k-textdiff-empty");
    scroll.append(spacer, emptyEl);
    root.append(bar, cols, scroll);
    bar.hidden = !st.toolbar;
    container.appendChild(root);

    const pool = new Map();
    const listeners = { change: new Set(), select: new Set(), resolve: new Set() };
    let paintQueued = false;

    // ----- Lookup -----

    function lookupHunk(id) {
      if (st.kind !== "diff" || typeof id !== "string" || !/^h\d+$/.test(id)) return undefined;
      return st.model.hunks[Number(id.slice(1)) - 1];
    }

    function lookupChunk(id) {
      if (st.kind !== "merge" || typeof id !== "string") return undefined;
      return st.merge.byId.get(id);
    }

    function hunkOrThrow(id) {
      const h = lookupHunk(id);
      if (!h) throw new Error(`textdiff: no hunk "${id}"`);
      return h;
    }

    function chunkOrThrow(id) {
      const c = lookupChunk(id);
      if (!c) throw new Error(`textdiff: no chunk "${id}"`);
      return c;
    }

    // ----- Events -----

    function emit(ev, payload) {
      for (const cb of [...listeners[ev]]) cb(payload);
    }

    function unresolvedCount() {
      if (st.kind === "merge")
        return st.merge.chunks.filter((c) => c.kind === "conflict" && c.choice === null).length;
      if (st.kind === "diff") return st.model.hunks.filter((h) => h.status === "open").length;
      return 0;
    }

    function userChanged() {
      emit("change", get());
      const u = unresolvedCount();
      if (u !== st.lastUnresolved) {
        st.lastUnresolved = u;
        emit("resolve", { unresolved: u });
      }
    }

    function select(id) {
      if (st.selected === id) return;
      st.selected = id;
      paint();
      emit("select", id);
    }

    // ----- Status and layout -----

    function statusText() {
      if (st.loading) return "Comparing…";
      if (st.kind === "merge") {
        const conflicts = st.merge.chunks.filter((c) => c.kind === "conflict").length;
        return conflicts
          ? `${unresolvedCount()} unresolved of ${conflicts} conflicts`
          : "No conflicts";
      }
      if (st.kind === "diff") {
        const hs = st.model.hunks;
        if (!hs.length) return "No differences";
        const count = (s) => hs.filter((h) => h.status === s).length;
        return `${count("open")} open, ${count("accepted")} accepted, ${count("rejected")} rejected of ${hs.length} changes`;
      }
      return "";
    }

    // The layout actually drawn: merge for 3-way input, unified when the view is too narrow for two columns.
    function view() {
      if (st.kind === "merge")
        return st.mergeLayout !== "stacked" && !st.narrow ? "columns" : "merge";
      return st.narrow ? "unified" : st.diffMode;
    }

    function updateBar() {
      const v = view();
      btnSplit.setAttribute("aria-pressed", String(v === "split"));
      btnUnified.setAttribute("aria-pressed", String(v === "unified"));
      const merge = st.kind === "merge";
      btnSplit.hidden = merge;
      btnUnified.hidden = merge;
      sep.hidden = merge;
      btnWs.hidden = merge;
      btnSplit.disabled = st.narrow;
      btnSplit.title = st.narrow ? "Too narrow for side by side" : "";
      btnWrap.setAttribute("aria-pressed", String(st.wrap));
      btnWs.setAttribute("aria-pressed", String(st.ignoreWs));
      btnWs.disabled = st.model !== null && st.model.kind === "patch";
      btnPrev.disabled = st.kind === null;
      btnNext.disabled = st.kind === null;
      statusEl.textContent = statusText();
    }

    function paintEmpty() {
      const has = st.items.length > 0;
      emptyEl.hidden = has;
      if (has) return;
      emptyEl.textContent = st.loading
        ? "Comparing…"
        : st.kind === null
          ? "Load two texts or a conflicted file to begin."
          : "Nothing to show.";
    }

    function measureChars() {
      let max = 0;
      const scan = (arr) => {
        if (!arr) return;
        for (const s of arr) if (s.length > max) max = s.length;
      };
      if (st.kind === "diff") {
        scan(st.model.aText);
        scan(st.model.bText);
      } else if (st.kind === "merge") {
        for (const c of st.merge.chunks) {
          scan(c.lines);
          scan(c.ours);
          scan(c.theirs);
          scan(c.base);
          scan(c.edited);
        }
      }
      return max;
    }

    function totalWidth(gutter) {
      const colW = st.maxChars * CHAR_PX + 24;
      if (view() === "split") return 2 * (gutter + colW);
      if (view() === "unified") return 2 * gutter + SIGN_PX + colW;
      return gutter + colW;
    }

    function relayout() {
      const items = st.items;
      const offs = new Float64Array(items.length + 1);
      let y = 0;
      for (let i = 0; i < items.length; i++) {
        offs[i] = y;
        y += items[i].h;
      }
      offs[items.length] = y;
      st.offs = offs;
      spacer.style.height = y + "px";
    }

    function indexAt(y) {
      const offs = st.offs;
      let lo = 0,
        hi = st.items.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offs[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    }

    function paint() {
      const items = st.items;
      const n = items.length;
      if (n === 0) {
        for (const rec of pool.values()) rec.el.remove();
        pool.clear();
        spacer.style.height = "0px";
        return;
      }
      const offs = st.offs;
      const first = indexAt(Math.max(0, scroll.scrollTop - OVERSCAN));
      const last = indexAt(scroll.scrollTop + scroll.clientHeight + OVERSCAN);
      const seen = new Set();
      for (let i = first; i <= last; i++) {
        const it = items[i];
        seen.add(it.key);
        let rec = pool.get(it.key);
        if (!rec) {
          rec = { el: buildEl(it), it };
          pool.set(it.key, rec);
          spacer.appendChild(rec.el);
        }
        rec.el.style.top = offs[i] + "px";
        if (!it.m) rec.el.style.height = it.h + "px";
        rec.el.classList.toggle("t3k-textdiff-sel", it.owner !== null && it.owner === st.selected);
      }
      for (const [key, rec] of pool) {
        if (!seen.has(key)) {
          rec.el.remove();
          pool.delete(key);
        }
      }
      if (scroll.clientHeight === 0) return;
      let changed = false;
      for (let i = first; i <= last; i++) {
        const it = items[i];
        if (!it.m) continue;
        const h = pool.get(it.key).el.offsetHeight;
        if (h !== it.h) {
          it.h = h;
          changed = true;
        }
      }
      if (changed) {
        relayout();
        for (const rec of pool.values()) rec.el.style.top = st.offs[rec.it.idx] + "px";
      }
    }

    // Rebuilds every painted row. Focus inside a removed row (a clicked button) moves to the root so keys keep working.
    function invalidate() {
      const hadFocus = spacer.contains(document.activeElement);
      for (const rec of pool.values()) rec.el.remove();
      pool.clear();
      paint();
      if (hadFocus && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
    }

    function schedulePaint() {
      if (paintQueued) return;
      paintQueued = true;
      requestAnimationFrame(flushPaint);
    }

    function flushPaint() {
      paintQueued = false;
      if (!st.destroyed) paint();
    }

    function repaint() {
      invalidate();
      updateBar();
    }

    function rebuild() {
      st.maxChars = measureChars();
      st.items = buildItems();
      const gutter = st.lineNumbers ? GUTTER_PX : 0;
      root.style.setProperty("--t3k-textdiff-gutter", gutter + "px");
      root.classList.toggle("t3k-textdiff-wrap", st.wrap);
      // Split without wrap fits the viewport (long lines end in an ellipsis; wrap shows them whole). Unified and merge
      // without wrap scroll horizontally to the widest line.
      const v = view();
      const width = st.wrap || v === "split" || v === "columns" ? "" : totalWidth(gutter) + "px";
      spacer.style.width = width;
      colsIn.style.width = width;
      cols.hidden = (v !== "split" && v !== "columns") || st.kind === null;
      root.classList.toggle("t3k-textdiff-layout-columns", v === "columns");
      root.style.setProperty("--t3k-textdiff-ncols", String(mergeSides().length));
      colsIn.className = v === "columns" ? "t3k-textdiff-m3row" : "t3k-textdiff-srow";
      colsIn.replaceChildren(
        ...(v === "split"
          ? [
              node("span", "t3k-textdiff-gutter"),
              node("span", "t3k-textdiff-code", st.labels.a),
              node("span", "t3k-textdiff-gutter"),
              node("span", "t3k-textdiff-code", st.labels.b),
            ]
          : v === "columns"
            ? [
                node("span", "t3k-textdiff-gutter"),
                ...mergeSides().map((side) =>
                  node("span", "t3k-textdiff-code t3k-textdiff-c-" + side, st.labels[side]),
                ),
              ]
            : []),
      );
      relayout();
      syncViewport();
      invalidate();
      paintEmpty();
      updateBar();
    }

    // ----- Item model -----

    function buildItems() {
      const list = [];
      st.ownerIndex = new Map();
      const add = (it) => {
        it.idx = list.length;
        list.push(it);
        if (it.owner !== null && !st.ownerIndex.has(it.owner)) st.ownerIndex.set(it.owner, it.idx);
        return it;
      };
      if (st.kind === "diff") buildDiffItems(add);
      else if (st.kind === "merge") buildMergeItems(add);
      return list;
    }

    function buildDiffItems(add) {
      const m = st.model;
      const K = m.K,
        A = m.A,
        B = m.B;
      const n = K.length;
      const ctx = st.context;
      const split = view() === "split";

      const eqRow = (q) => {
        const a = A[q],
          b = B[q];
        const aCell = { n: m.aNo[a], t: m.aText[a], k: "eq" };
        const bCell = { n: m.bNo[b], t: m.bText[b], k: "eq" };
        if (split)
          return add({
            t: "srow",
            key: "r" + q,
            owner: null,
            hi: -1,
            L: aCell,
            R: bCell,
            pair: false,
            h: ROW_H,
            m: st.wrap,
          });
        return add({
          t: "urow",
          key: "r" + q,
          owner: null,
          hi: -1,
          k: "eq",
          ga: aCell.n,
          gb: bCell.n,
          x: aCell.t,
          pt: null,
          h: ROW_H,
          m: st.wrap,
        });
      };
      const eqRange = (from, to) => {
        for (let q = from; q < to; q++) eqRow(q);
      };
      const changeRows = (from, to, hi, owner) => {
        const dels = [],
          ins = [];
        for (let q = from; q < to; q++) (K[q] === 1 ? dels : ins).push(q);
        if (split) {
          const rows = Math.max(dels.length, ins.length);
          for (let r = 0; r < rows; r++) {
            const dq = dels[r],
              iq = ins[r];
            const L = dq === undefined ? null : { n: m.aNo[A[dq]], t: m.aText[A[dq]], k: "del" };
            const R = iq === undefined ? null : { n: m.bNo[B[iq]], t: m.bText[B[iq]], k: "ins" };
            add({
              t: "srow",
              key: "c" + from + "_" + r,
              owner,
              hi,
              L,
              R,
              pair: L !== null && R !== null,
              h: ROW_H,
              m: st.wrap,
            });
          }
          return;
        }
        dels.forEach((dq, r) => {
          const iq = ins[r];
          add({
            t: "urow",
            key: "u" + dq,
            owner,
            hi,
            k: "del",
            ga: m.aNo[A[dq]],
            gb: null,
            x: m.aText[A[dq]],
            pt: iq === undefined ? null : m.bText[B[iq]],
            h: ROW_H,
            m: st.wrap,
          });
        });
        ins.forEach((iq, r) => {
          const dq = dels[r];
          add({
            t: "urow",
            key: "u" + iq,
            owner,
            hi,
            k: "ins",
            ga: null,
            gb: m.bNo[B[iq]],
            x: m.bText[B[iq]],
            pt: dq === undefined ? null : m.aText[A[dq]],
            h: ROW_H,
            m: st.wrap,
          });
        });
      };

      let i = 0;
      while (i < n) {
        if (K[i] === 0) {
          let j = i;
          while (j < n && K[j] === 0) j++;
          const lead = i > 0 ? ctx : 0;
          const trail = j < n ? ctx : 0;
          const hidden = j - i - lead - trail;
          const fk = "f" + i;
          if (hidden <= 1 || st.expanded.has(fk)) {
            eqRange(i, j);
          } else {
            eqRange(i, i + lead);
            add({ t: "fold", key: fk, owner: null, hi: -1, count: hidden, h: FOLD_H, m: false });
            eqRange(j - trail, j);
          }
          i = j;
        } else if (K[i] === 3) {
          add({ t: "gap", key: "g" + i, owner: null, hi: -1, count: A[i], h: FOLD_H, m: false });
          i++;
        } else {
          let j = i;
          while (j < n && (K[j] === 1 || K[j] === 2)) j++;
          const hi = m.hunkOf[i];
          const owner = m.hunks[hi].id;
          add({ t: "hunk", key: "H" + owner, owner, hi, h: HUNK_H, m: true });
          changeRows(i, j, hi, owner);
          i = j;
        }
      }
    }

    // The columns of the column layout.
    function mergeSides() {
      return st.mergeLayout === "columns-no-base" ? ["ours", "theirs"] : ["ours", "base", "theirs"];
    }

    function buildMergeItems(add) {
      let resultNo = 0;
      const columns = view() === "columns";
      const label = (c, side, text) => {
        add({
          t: "mlabel",
          key: "L" + c.id + side,
          owner: c.id,
          cid: c.id,
          side,
          x: text,
          h: LABEL_H,
          m: false,
          hi: -1,
        });
      };
      const sideItems = (c, side, lines, numbered) => {
        if (!lines.length) {
          add({
            t: "mline",
            key: "l" + c.id + side + "e",
            owner: c.id,
            cid: c.id,
            side,
            x: "",
            n: null,
            empty: true,
            h: ROW_H,
            m: st.wrap,
            hi: -1,
          });
          return;
        }
        lines.forEach((t, k) => {
          add({
            t: "mline",
            key: "l" + c.id + side + k,
            owner: c.id,
            cid: c.id,
            side,
            x: t,
            n: numbered ? ++resultNo : null,
            empty: false,
            h: ROW_H,
            m: st.wrap,
            hi: -1,
          });
        });
      };
      for (const c of st.merge.chunks) {
        if (c.kind === "conflict")
          add({ t: "chead", key: "K" + c.id, owner: c.id, cid: c.id, h: CHEAD_H, m: true, hi: -1 });
        if (st.editing.has(c.id)) {
          add({ t: "edit", key: "E" + c.id, owner: c.id, cid: c.id, h: EDIT_H, m: true, hi: -1 });
          continue;
        }
        if (columns && c.kind === "conflict" && c.choice !== "edited") {
          const rows = Math.max(
            1,
            ...mergeSides().map((side) => (side === "base" && !c.hasBase ? 0 : c[side].length)),
          );
          for (let r = 0; r < rows; r++) {
            add({
              t: "m3row",
              key: "m" + c.id + "_" + r,
              owner: c.id,
              cid: c.id,
              r,
              last: r === rows - 1,
              h: ROW_H,
              m: true,
              hi: -1,
            });
          }
          if (c.choice !== null) resultNo += resolvedLines(c).length;
          continue;
        }
        if (c.kind === "conflict" && c.choice === null) {
          label(c, "ours", st.labels.ours);
          sideItems(c, "ours", c.ours, false);
          if (c.hasBase) {
            label(c, "base", st.labels.base);
            sideItems(c, "base", c.base, false);
          }
          label(c, "theirs", st.labels.theirs);
          sideItems(c, "theirs", c.theirs, false);
          continue;
        }
        const side = c.choice === "edited" ? "edited" : c.kind === "auto" ? "auto" : "result";
        sideItems(c, side, resolvedLines(c), true);
      }
    }

    // ----- Element builders -----

    function buildEl(it) {
      const el = node("div", "t3k-textdiff-item");
      // Headers, folds and editors stay pinned to the viewport while code rows scroll sideways.
      if (it.t !== "srow" && it.t !== "urow" && it.t !== "mline" && it.t !== "m3row")
        el.classList.add("t3k-textdiff-band");
      if (it.owner !== null) el.dataset.owner = it.owner;
      switch (it.t) {
        case "srow":
          buildSplit(el, it);
          break;
        case "urow":
          buildUnified(el, it);
          break;
        case "mline":
          buildLine(el, it);
          break;
        case "m3row":
          buildRow3(el, it);
          break;
        case "mlabel":
          buildLabel(el, it);
          break;
        case "fold":
          buildFold(el, it);
          break;
        case "gap":
          buildGap(el, it);
          break;
        case "hunk":
          buildHunk(el, it);
          break;
        case "chead":
          buildChead(el, it);
          break;
        case "edit":
          buildEdit(el, it);
          break;
        default:
          throw new Error("textdiff: unknown item " + it.t);
      }
      if (
        (it.t === "srow" || it.t === "urow") &&
        it.hi >= 0 &&
        st.model.hunks[it.hi].status === "rejected"
      )
        el.classList.add("t3k-textdiff-rej");
      return el;
    }

    function appendCell(parent, c, segs) {
      const g = node(
        "span",
        c ? "t3k-textdiff-gutter t3k-textdiff-g-" + c.k : "t3k-textdiff-gutter",
        c && st.lineNumbers ? String(c.n) : "",
      );
      const code = node("span", "t3k-textdiff-code t3k-textdiff-" + (c ? c.k : "none"));
      if (c && segs) appendSegs(code, segs, c.k);
      else if (c) code.textContent = c.t;
      parent.append(g, code);
    }

    function buildSplit(el, it) {
      el.classList.add("t3k-textdiff-srow");
      const segs = it.pair ? wordSegs(it.L.t, it.R.t) : null;
      appendCell(el, it.L, segs ? segs.a : null);
      appendCell(el, it.R, segs ? segs.b : null);
    }

    function buildUnified(el, it) {
      el.classList.add("t3k-textdiff-urow");
      const ga = node(
        "span",
        "t3k-textdiff-gutter",
        st.lineNumbers && it.ga !== null ? String(it.ga) : "",
      );
      const gb = node(
        "span",
        "t3k-textdiff-gutter",
        st.lineNumbers && it.gb !== null ? String(it.gb) : "",
      );
      if (it.k === "del") ga.classList.add("t3k-textdiff-g-del");
      if (it.k === "ins") gb.classList.add("t3k-textdiff-g-ins");
      const sign = node(
        "span",
        "t3k-textdiff-sign",
        it.k === "del" ? "-" : it.k === "ins" ? "+" : " ",
      );
      const code = node("span", "t3k-textdiff-code t3k-textdiff-" + it.k);
      const segs =
        it.pt !== null ? (it.k === "del" ? wordSegs(it.x, it.pt) : wordSegs(it.pt, it.x)) : null;
      if (segs) appendSegs(code, it.k === "del" ? segs.a : segs.b, it.k);
      else code.textContent = it.x;
      el.append(ga, gb, sign, code);
    }

    function buildLine(el, it) {
      el.classList.add("t3k-textdiff-mline", "t3k-textdiff-side-" + it.side);
      if (it.empty) el.classList.add("t3k-textdiff-placeholder");
      const g = node(
        "span",
        "t3k-textdiff-gutter",
        st.lineNumbers && it.n !== null ? String(it.n) : "",
      );
      const code = node("span", "t3k-textdiff-code", it.empty ? "(no lines)" : it.x);
      el.append(g, code);
    }

    // One row of a conflict in the column layout: the r-th line of each side (blank when a side is shorter).
    function buildRow3(el, it) {
      const c = chunkOrThrow(it.cid);
      el.classList.add("t3k-textdiff-m3row", "t3k-textdiff-m3");
      if (it.last) el.classList.add("t3k-textdiff-last");
      el.dataset.state = c.choice === null ? "unresolved" : "resolved";
      el.appendChild(node("span", "t3k-textdiff-gutter", ""));
      const picked = c.choice === null ? null : PICKED[c.choice];
      for (const side of mergeSides()) {
        const lines = side === "base" && !c.hasBase ? null : c[side];
        const code = node("span", "t3k-textdiff-code t3k-textdiff-c-" + side);
        if (lines && it.r < lines.length) code.textContent = lines[it.r];
        else if (it.r === 0) {
          code.classList.add("t3k-textdiff-nolines");
          code.textContent = lines ? "(no lines)" : "(no base section)";
        } else code.classList.add("t3k-textdiff-blank");
        if (picked && !picked.includes(side)) code.classList.add("t3k-textdiff-unpicked");
        el.appendChild(code);
      }
    }

    function buildLabel(el, it) {
      el.classList.add("t3k-textdiff-mlabel", "t3k-textdiff-side-" + it.side);
      el.textContent = it.x;
    }

    function buildFold(el, it) {
      el.classList.add("t3k-textdiff-fold");
      el.appendChild(node("span", null, `${it.count} unchanged lines`));
      const b = actBtn("Show", "fold");
      b.dataset.key = it.key;
      el.appendChild(b);
    }

    function buildGap(el, it) {
      el.classList.add("t3k-textdiff-gap");
      el.textContent = `${it.count} lines not in the patch`;
    }

    function buildHunk(el, it) {
      const h = st.model.hunks[it.hi];
      el.classList.add("t3k-textdiff-hunk");
      el.dataset.status = h.status;
      const bar = node("div", "t3k-textdiff-hbar");
      const parts = [];
      if (h.aLines) parts.push(`${h.aLines} removed`);
      if (h.bLines) parts.push(`${h.bLines} added`);
      const at = h.aLines ? h.aStart : h.bStart;
      const range = node("span", "t3k-textdiff-range", `Line ${at} · ${parts.join(", ")}`);
      range.title = `@@ -${h.aStart},${h.aLines} +${h.bStart},${h.bLines} @@`;
      bar.append(
        node("span", "t3k-textdiff-htitle", `Change ${it.hi + 1}`),
        range,
        node("span", "t3k-textdiff-badge", STATUS_LABEL[h.status]),
        keyBtn(actBtn("Accept", "accept", h.id, h.status === "accepted"), "A"),
        keyBtn(actBtn("Reject", "reject", h.id, h.status === "rejected"), "R"),
        keyBtn(actBtn(h.comment === undefined ? "Comment" : "Edit Comment", "comment", h.id), "C"),
      );
      el.appendChild(bar);
      if (st.commentOpen.has(h.id)) {
        const value = st.commentDraft.has(h.id) ? st.commentDraft.get(h.id) : (h.comment ?? "");
        el.append(
          textarea("comment", h.id, value, "Comment on this change"),
          actionRow([
            ["Cancel", "cancel-comment", h.id],
            ["Save", "save-comment", h.id],
          ]),
        );
      } else if (h.comment !== undefined) {
        el.appendChild(node("div", "t3k-textdiff-note", h.comment));
      }
    }

    function buildChead(el, it) {
      const c = chunkOrThrow(it.cid);
      el.classList.add("t3k-textdiff-chead");
      if (view() === "columns" && c.choice !== "edited" && !st.editing.has(c.id))
        el.classList.add("t3k-textdiff-m3");
      el.dataset.state = c.choice === null ? "unresolved" : "resolved";
      el.append(
        node("span", "t3k-textdiff-title", `Conflict ${c.no}`),
        node(
          "span",
          "t3k-textdiff-state",
          c.choice === null ? "Unresolved" : `Resolved: ${CHOICE_LABEL[c.choice]}`,
        ),
      );
      for (const [choice, label, key] of CHOICE_BUTTONS) {
        const b = keyBtn(actBtn(label, "choose", c.id, c.choice === choice), key);
        b.dataset.choice = choice;
        if (choice === "base" && !c.hasBase) b.disabled = true;
        el.appendChild(b);
      }
      el.appendChild(keyBtn(actBtn("Edit", "edit", c.id, c.choice === "edited"), "E"));
      if (c.choice !== null) el.appendChild(actBtn("Reopen", "reopen", c.id));
    }

    function buildEdit(el, it) {
      el.classList.add("t3k-textdiff-edit");
      el.append(
        textarea("edit", it.cid, st.editDraft.get(it.cid) ?? "", "Edit the result for this change"),
        actionRow([
          ["Cancel", "cancel-edit", it.cid],
          ["Save", "save-edit", it.cid],
        ]),
      );
    }

    // ----- Actions -----

    // Re-diffs {a, b} input with the new whitespace rule. Decisions carry over to hunks whose ranges did not change.
    function setIgnoreWs(v) {
      st.ignoreWs = v;
      if (st.kind !== "diff" || st.model.kind !== "ab") return;
      const keyOf = (h) => `${h.aStart},${h.aLines},${h.bStart},${h.bLines}`;
      const prev = new Map(st.model.hunks.map((h) => [keyOf(h), h]));
      st.model = abModel(st.texts.a, st.texts.b, v);
      for (const h of st.model.hunks) {
        const old = prev.get(keyOf(h));
        if (!old) continue;
        h.status = old.status;
        if (old.comment !== undefined) h.comment = old.comment;
      }
      st.selected = null;
      st.expanded.clear();
      st.commentOpen.clear();
      st.commentDraft.clear();
    }

    function setMode(mode) {
      if (!MODES.includes(mode)) throw new TypeError(`textdiff: mode must be ${MODES.join(", ")}`);
      if (st.kind === "merge" && mode !== "merge")
        throw new Error("textdiff: a three-way merge shows only merge mode");
      if (st.kind === "diff" && mode === "merge")
        throw new Error("textdiff: a 2-way diff cannot use merge mode");
      if (mode !== "merge") st.diffMode = mode;
      st.mode = mode;
    }

    function applyChoice(c, choice, text) {
      if (choice === null) {
        c.choice = null;
        st.editing.delete(c.id);
        st.editDraft.delete(c.id);
        return;
      }
      if (!CHOICES.includes(choice))
        throw new TypeError(`textdiff: choice must be one of ${CHOICES.join(", ")} or null`);
      if (c.kind === "auto" && choice !== "edited")
        throw new TypeError(`textdiff: auto chunk ${c.id} only accepts "edited"`);
      if (choice === "base" && !c.hasBase)
        throw new TypeError(`textdiff: ${c.id} has no base section (merge-style markers)`);
      if (choice === "edited") {
        if (typeof text !== "string")
          throw new TypeError(`textdiff: "edited" needs the text for ${c.id}`);
        c.edited = splitLines(text);
      } else if (text !== undefined) {
        throw new TypeError('textdiff: text only applies to the "edited" choice');
      }
      c.choice = choice;
      st.editing.delete(c.id);
      st.editDraft.delete(c.id);
    }

    function choose(id, choice, text) {
      if (st.kind !== "merge")
        throw new Error(
          "textdiff.choose: needs a three-way merge (load {base, ours, theirs} or {conflicted})",
        );
      applyChoice(chunkOrThrow(id), choice, text);
      rebuild();
      userChanged();
    }

    function decide(id, status, comment) {
      if (st.kind !== "diff") throw new Error("textdiff.decide: needs a 2-way diff");
      const h = hunkOrThrow(id);
      h.status = checkStatus(status);
      if (comment !== undefined) setComment(h, comment);
      repaint();
      userChanged();
    }

    function toggleStatus(id, target) {
      const h = hunkOrThrow(id);
      decide(id, h.status === target ? "open" : target);
    }

    function focusItem(key, selector) {
      const rec = pool.get(key);
      const target = rec ? rec.el.querySelector(selector) : null;
      if (target) target.focus();
    }

    function openComment(id) {
      const h = hunkOrThrow(id);
      st.commentOpen.add(id);
      if (!st.commentDraft.has(id)) st.commentDraft.set(id, h.comment ?? "");
      select(id);
      repaint();
      focusItem("H" + id, "textarea");
    }

    function closeComment(id) {
      st.commentOpen.delete(id);
      st.commentDraft.delete(id);
      repaint();
    }

    function saveComment(id) {
      const h = hunkOrThrow(id);
      const text = st.commentDraft.has(id) ? st.commentDraft.get(id) : (h.comment ?? "");
      st.commentOpen.delete(id);
      st.commentDraft.delete(id);
      decide(id, h.status, text);
    }

    function startEdit(id) {
      const c = chunkOrThrow(id);
      const cur = resolvedLines(c) ?? (c.kind === "conflict" ? c.ours : []);
      st.editing.add(id);
      st.editDraft.set(id, joinLines(cur));
      select(id);
      rebuild();
      focusItem("E" + id, "textarea");
    }

    function saveEdit(id) {
      choose(id, "edited", st.editDraft.has(id) ? st.editDraft.get(id) : "");
    }

    function cancelEdit(id) {
      st.editing.delete(id);
      st.editDraft.delete(id);
      rebuild();
    }

    function revealOwner(id) {
      const i = st.ownerIndex.get(id);
      if (i === undefined) return;
      scroll.scrollTop = Math.max(0, st.offs[i] - 24);
      paint();
    }

    function focus(id) {
      if (st.kind !== "merge") throw new Error("textdiff.focus: needs a three-way merge");
      chunkOrThrow(id);
      select(id);
      revealOwner(id);
      return id;
    }

    function step(dir) {
      const merge = st.kind === "merge";
      if (st.kind === null) return null;
      const all = merge ? st.merge.chunks.map((c) => c.id) : st.model.hunks.map((h) => h.id);
      const open = merge
        ? st.merge.chunks.filter((c) => c.kind === "conflict" && c.choice === null).map((c) => c.id)
        : st.model.hunks.filter((h) => h.status === "open").map((h) => h.id);
      if (!open.length) return null;
      const index = new Map(all.map((id, i) => [id, i]));
      const pos = st.selected === null ? -1 : (index.get(st.selected) ?? -1);
      let target = null;
      if (dir > 0) target = open.find((id) => index.get(id) > pos) ?? null;
      else if (pos < 0) target = open[open.length - 1];
      else for (const id of open) if (index.get(id) < pos) target = id;
      if (target === null) return null;
      select(target);
      revealOwner(target);
      return target;
    }

    // ----- Input -----

    function onClick(e) {
      const btn = e.target.closest("button[data-act]");
      if (btn) {
        act(btn.dataset.act, btn.dataset);
        return;
      }
      const item = e.target.closest(".t3k-textdiff-item");
      if (item && item.dataset.owner) select(item.dataset.owner);
    }

    function act(name, d) {
      switch (name) {
        case "mode":
          setMode(d.mode);
          rebuild();
          break;
        case "wrap":
          st.wrap = !st.wrap;
          rebuild();
          break;
        case "ws":
          setIgnoreWs(!st.ignoreWs);
          rebuild();
          userChanged();
          break;
        case "reopen":
          choose(d.id, null);
          break;
        case "prev":
          step(-1);
          break;
        case "next":
          step(1);
          break;
        case "accept":
          toggleStatus(d.id, "accepted");
          break;
        case "reject":
          toggleStatus(d.id, "rejected");
          break;
        case "comment":
          openComment(d.id);
          break;
        case "cancel-comment":
          closeComment(d.id);
          break;
        case "save-comment":
          saveComment(d.id);
          break;
        case "fold":
          st.expanded.add(d.key);
          rebuild();
          break;
        case "choose":
          choose(d.id, d.choice);
          break;
        case "edit":
          startEdit(d.id);
          break;
        case "save-edit":
          saveEdit(d.id);
          break;
        case "cancel-edit":
          cancelEdit(d.id);
          break;
        default:
          throw new Error("textdiff: unknown action " + name);
      }
    }

    function onInput(e) {
      const t = e.target;
      if (t.tagName !== "TEXTAREA") return;
      if (t.dataset.kind === "edit") st.editDraft.set(t.dataset.id, t.value);
      else if (t.dataset.kind === "comment") st.commentDraft.set(t.dataset.id, t.value);
    }

    function onKey(e) {
      const t = e.target;
      if (t.tagName === "TEXTAREA") {
        const id = t.dataset.id;
        if (e.key === "Escape") {
          e.preventDefault();
          if (t.dataset.kind === "edit") cancelEdit(id);
          else closeComment(id);
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          if (t.dataset.kind === "edit") saveEdit(id);
          else saveComment(id);
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || st.kind === null) return;
      const sel = st.selected;
      const merge = st.kind === "merge";
      const digit = /^Digit([1-4])$/.exec(e.code || "");
      if (digit) {
        const c = merge && sel !== null ? lookupChunk(sel) : undefined;
        if (!c || c.kind !== "conflict") return;
        const dg = digit[1];
        if (dg === "4" && !c.hasBase) return;
        e.preventDefault();
        choose(
          c.id,
          dg === "1"
            ? "ours"
            : dg === "2"
              ? "theirs"
              : dg === "3"
                ? e.shiftKey
                  ? "both-theirs"
                  : "both"
                : "base",
        );
        return;
      }
      const key = e.key.toLowerCase();
      let handled = true;
      if (key === "n") step(1);
      else if (key === "p") step(-1);
      else if (key === "e" && merge && sel !== null && lookupChunk(sel)) startEdit(sel);
      else if ((key === "a" || key === "r") && !merge && sel !== null && lookupHunk(sel))
        toggleStatus(sel, key === "a" ? "accepted" : "rejected");
      else if (key === "c" && !merge && sel !== null && lookupHunk(sel)) openComment(sel);
      else handled = false;
      if (handled) e.preventDefault();
    }

    function syncViewport() {
      root.style.setProperty("--t3k-textdiff-vw", scroll.clientWidth + "px");
      root.style.setProperty("--t3k-textdiff-sx", scroll.scrollLeft + "px");
    }

    function onScroll() {
      cols.scrollLeft = scroll.scrollLeft;
      root.style.setProperty("--t3k-textdiff-sx", scroll.scrollLeft + "px");
      schedulePaint();
    }

    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKey);
    root.addEventListener("input", onInput);
    scroll.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      const w = root.clientWidth;
      const narrow = w > 0 && w < NARROW_PX;
      syncViewport();
      if (narrow !== st.narrow) {
        st.narrow = narrow;
        rebuild();
      } else schedulePaint();
    });
    ro.observe(root);

    // ----- Public methods -----

    async function load(input) {
      const kind = inputKind(input);
      const texts = {};
      for (const k of Object.keys(input)) texts[k] = await readText(input[k], k);
      st.loading = true;
      updateBar();
      paintEmpty();
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (kind === "ab") {
          st.kind = "diff";
          st.merge = null;
          st.texts = { a: splitLines(texts.a), b: splitLines(texts.b) };
          st.model = abModel(st.texts.a, st.texts.b, st.ignoreWs);
          st.names = { a: st.userLabels.a ?? "a", b: st.userLabels.b ?? "b" };
          st.labels.a = st.userLabels.a ?? "Original";
          st.labels.b = st.userLabels.b ?? "Changed";
        } else if (kind === "patch") {
          const files = parsePatch(texts.patch);
          if (files.length !== 1)
            throw new Error(`textdiff.load: {patch} must hold one file, found ${files.length}`);
          st.kind = "diff";
          st.merge = null;
          st.texts = null;
          st.model = patchModel(files[0]);
          st.names = { a: files[0].oldName || "a", b: files[0].newName || "b" };
          st.labels.a = st.userLabels.a ?? (files[0].oldName || "Original");
          st.labels.b = st.userLabels.b ?? (files[0].newName || "Changed");
        } else {
          const specs =
            kind === "3way"
              ? diff3Specs(
                  splitLines(texts.base),
                  splitLines(texts.ours),
                  splitLines(texts.theirs),
                  st.ignoreWs,
                )
              : parseConflictSegments(texts.conflicted);
          st.kind = "merge";
          st.model = null;
          st.texts = null;
          const chunks = mergeChunks(specs);
          st.merge = { chunks, byId: new Map(chunks.map((c) => [c.id, c])) };
        }
        st.selected = null;
        st.expanded.clear();
        st.commentOpen.clear();
        st.commentDraft.clear();
        st.editing.clear();
        st.editDraft.clear();
        st.mode = st.kind === "merge" ? "merge" : st.diffMode;
        st.lastUnresolved = unresolvedCount();
        scroll.scrollTop = 0;
        rebuild();
      } finally {
        st.loading = false;
        updateBar();
      }
      if (st.kind === "merge") {
        return {
          chunks: get().chunks,
          conflicts: st.merge.chunks.filter((c) => c.kind === "conflict").map((c) => c.id),
        };
      }
      return { hunks: get().hunks };
    }

    function get() {
      if (st.kind === "merge") {
        return {
          chunks: st.merge.chunks.map((c) => ({
            id: c.id,
            kind: c.kind,
            choice: c.choice,
            text: textOf(resolvedLines(c)),
          })),
          unresolved: unresolvedCount(),
        };
      }
      return { hunks: st.kind === "diff" ? st.model.hunks.map(hunkOut) : [] };
    }

    function set(p) {
      if (!p || typeof p !== "object") throw new TypeError("textdiff.set: expected an object");
      for (const k of Object.keys(p))
        if (!SET_KEYS.includes(k)) throw new TypeError(`textdiff.set: unknown key "${k}"`);
      if (p.mode !== undefined) setMode(p.mode);
      if (p.context !== undefined) st.context = checkContext(p.context);
      if (p.wrap !== undefined) st.wrap = checkBool(p.wrap, "wrap");
      if (p.lineNumbers !== undefined) st.lineNumbers = checkBool(p.lineNumbers, "lineNumbers");
      if (p.labels !== undefined) {
        Object.assign(st.userLabels, checkLabels(p.labels));
        Object.assign(st.labels, p.labels);
      }
      if (p.ignoreWhitespace !== undefined)
        setIgnoreWs(checkBool(p.ignoreWhitespace, "ignoreWhitespace"));
      if (p.toolbar !== undefined) bar.hidden = !(st.toolbar = checkBool(p.toolbar, "toolbar"));
      if (p.mergeLayout !== undefined) st.mergeLayout = checkMergeLayout(p.mergeLayout);
      if (p.hunks !== undefined) {
        for (const h of p.hunks) {
          const hunk = hunkOrThrow(h.id);
          if (h.status !== undefined) hunk.status = checkStatus(h.status);
          if ("comment" in h) setComment(hunk, h.comment);
        }
      }
      if (p.chunks !== undefined) {
        for (const c of p.chunks) {
          const chunk = chunkOrThrow(c.id);
          if (c.choice !== undefined) applyChoice(chunk, c.choice, c.text);
          else if (c.text !== undefined) throw new TypeError("textdiff.set: text needs a choice");
        }
      }
      st.lastUnresolved = unresolvedCount();
      rebuild();
    }

    function result(opts) {
      const o = opts || {};
      if (st.kind === "merge") {
        const open = unresolvedCount();
        if (open > 0 && !o.allowMarkers)
          throw new Error(
            `textdiff.result: ${open} unresolved conflict(s); resolve them or pass {allowMarkers: true}`,
          );
        const out = [];
        for (const c of st.merge.chunks) {
          const r = resolvedLines(c);
          if (r) {
            for (const l of r) out.push(l);
            continue;
          }
          out.push(`<<<<<<< ${st.labels.ours}`);
          for (const l of c.ours) out.push(l);
          if (c.hasBase) {
            out.push(`||||||| ${st.labels.base}`);
            for (const l of c.base) out.push(l);
          }
          out.push("=======");
          for (const l of c.theirs) out.push(l);
          out.push(`>>>>>>> ${st.labels.theirs}`);
        }
        return joinLines(out);
      }
      if (st.kind !== "diff") return "";
      const m = st.model;
      if (m.kind === "patch")
        throw new Error("textdiff.result: a patch holds only its hunks; use acceptedPatch()");
      const out = [];
      for (let q = 0; q < m.K.length; q++) {
        const k = m.K[q];
        const acc = m.hunkOf[q] >= 0 && m.hunks[m.hunkOf[q]].status === "accepted";
        if (k === 0) out.push(m.aText[m.A[q]]);
        else if (k === 1 && !acc) out.push(m.aText[m.A[q]]);
        else if (k === 2 && acc) out.push(m.bText[m.B[q]]);
      }
      return joinLines(out);
    }

    // Accepted changes become a patch against a. Rejected and open changes stay as context. Gaps break hunks.
    function acceptedPatch() {
      if (st.kind !== "diff") throw new Error("textdiff.acceptedPatch: needs a 2-way diff");
      const m = st.model;
      if (!m) return "";
      const P = [];
      let oc = 0,
        nc = 0;
      const push = (t, s, ch) => {
        P.push({ t, s, ch, ob: oc, nb: nc });
        if (t === " " || t === "-") oc++;
        if (t === " " || t === "+") nc++;
      };
      for (let q = 0; q < m.K.length; q++) {
        const k = m.K[q];
        if (k === 3) {
          P.push({ b: true });
          oc += m.A[q];
          nc += m.A[q];
          continue;
        }
        const acc = m.hunkOf[q] >= 0 && m.hunks[m.hunkOf[q]].status === "accepted";
        if (k === 0) push(" ", m.aText[m.A[q]], false);
        else if (k === 1) {
          if (acc) push("-", m.aText[m.A[q]], true);
          else push(" ", m.aText[m.A[q]], false);
        } else if (acc) push("+", m.bText[m.B[q]], true);
      }
      const include = new Uint8Array(P.length);
      P.forEach((e, idx) => {
        if (e.b || !e.ch) return;
        for (let j = idx; j >= 0 && j >= idx - st.context; j--) {
          if (P[j].b) break;
          include[j] = 1;
        }
        for (let j = idx; j < P.length && j <= idx + st.context; j++) {
          if (P[j].b) break;
          include[j] = 1;
        }
      });
      const out = [];
      let idx = 0;
      while (idx < P.length) {
        if (!include[idx] || P[idx].b) {
          idx++;
          continue;
        }
        let end = idx;
        while (end + 1 < P.length && include[end + 1] && !P[end + 1].b) end++;
        const group = P.slice(idx, end + 1);
        let oldCount = 0,
          newCount = 0;
        for (const e of group) {
          if (e.t === " " || e.t === "-") oldCount++;
          if (e.t === " " || e.t === "+") newCount++;
        }
        const first = group[0];
        const oldStart = oldCount ? first.ob + 1 : first.ob;
        const newStart = newCount ? first.nb + 1 : first.nb;
        out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
        for (const e of group) out.push(e.t + e.s);
        idx = end + 1;
      }
      if (!out.length) return "";
      return [`--- ${st.names.a}`, `+++ ${st.names.b}`].concat(out).join("\n") + "\n";
    }

    function on(ev, cb) {
      if (!EVENTS.includes(ev)) throw new TypeError(`textdiff.on: unknown event "${ev}"`);
      if (typeof cb !== "function") throw new TypeError("textdiff.on: callback must be a function");
      listeners[ev].add(cb);
      return () => listeners[ev].delete(cb);
    }

    function destroy() {
      if (st.destroyed) return;
      st.destroyed = true;
      ro.disconnect();
      scroll.removeEventListener("scroll", onScroll);
      root.remove();
      pool.clear();
      for (const set of Object.values(listeners)) set.clear();
    }

    rebuild();
    return {
      load,
      get,
      set,
      decide,
      choose,
      next: () => step(1),
      prev: () => step(-1),
      focus,
      result,
      acceptedPatch,
      on,
      destroy,
    };
  }

  // ---------- Statics ----------

  function diffLines(a, b) {
    return abModel(toLines(a), toLines(b), false).hunks.map((h) => ({
      aStart: h.aStart,
      aLines: h.aLines,
      bStart: h.bStart,
      bLines: h.bLines,
    }));
  }

  function diffWords(a, b) {
    if (typeof a !== "string" || typeof b !== "string")
      throw new TypeError("textdiff.diffWords: expected two strings");
    const ta = a.match(WORD_RE) || [];
    const tb = b.match(WORD_RE) || [];
    const ids = new Map();
    const id = (t) => {
      let v = ids.get(t);
      if (v === undefined) {
        v = ids.size;
        ids.set(t, v);
      }
      return v;
    };
    const raw = editOps(Int32Array.from(ta, id), Int32Array.from(tb, id));
    const ops = normalizeRuns(raw.K, raw.A, raw.B);
    const out = [];
    for (let q = 0; q < ops.K.length; q++) {
      const k = ops.K[q];
      const type = k === 0 ? "equal" : k === 1 ? "delete" : "insert";
      const text = k === 2 ? tb[ops.B[q]] : ta[ops.A[q]];
      const last = out[out.length - 1];
      if (last && last.type === type) last.text += text;
      else out.push({ type, text });
    }
    return out;
  }

  function diff3(base, ours, theirs, options) {
    const ignoreWs = Boolean(options && options.ignoreWhitespace);
    return diff3Specs(toLines(base), toLines(ours), toLines(theirs), ignoreWs).map((s) =>
      s.kind === "auto"
        ? { kind: "auto", lines: s.lines }
        : { kind: "conflict", base: s.base, ours: s.ours, theirs: s.theirs },
    );
  }

  function parseConflicts(text) {
    const specs = parseConflictSegments(text);
    return {
      base: specs.some((s) => s.kind === "conflict" && s.hasBase)
        ? joinLines(sideOfSpecs(specs, "base"))
        : null,
      ours: joinLines(sideOfSpecs(specs, "ours")),
      theirs: joinLines(sideOfSpecs(specs, "theirs")),
      hasBase: specs.some((s) => s.kind === "conflict" && s.hasBase),
    };
  }

  t3kit.textdiff = { create, diffLines, diffWords, diff3, parseConflicts, parsePatch };
})();
