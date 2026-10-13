/**
 * t3kit.links: wire kit primitives together so pages never hand-sync them. No DOM; load after the primitives.
 * Every helper returns link: call link() (or link.destroy()) to unlink; link.sync() re-pushes after silent set() calls.
 *
 * links.playerTimeline(player, timeline) -> link   one edit list, one playhead, one transport.
 *   Loads timeline.get() into the player at its playhead. Timeline edits, undo and trims re-sequence the player
 *   (colour-only edits restyle live); timeline scrubs, seeks and keys seek it; the player's clock moves the timeline
 *   playhead. Timeline Space/K/L and its play/pause buttons run the player (timeline.setTransport), and play, pause or
 *   end in the player shows in the timeline. Create the player with controls: false for a single visible transport.
 *   sync(): after timeline.set(), reload its value into the player.
 * links.developHistogram(develop, histogram) -> link   the histogram shows the developed look, refreshed on each
 *   develop 'render' (setImage, set, edits; at most once per frame, one analysis in flight). sync(): refresh now.
 * links.curvesDevelop(curves, develop) -> link   curve edits drive develop's curves (curves.lut() r/g/b with the
 *   master folded in; identity curves switch the pass off). The curve backdrop shows the developed histogram (not
 *   refreshed while the curve itself is being dragged). develop's Reset All resets the curves. sync(): push now.
 * links.historyState(history, getValues, setValues, { sources?, idleMs = 300, thumb? }?) -> link
 *   Undo, redo, jump and presets call setValues(state). getValues() -> JSON state; setValues(state) must set() every
 *   primitive the state covers (set() is silent, so links never echo). On link an empty history adopts getValues();
 *   otherwise its active state is applied. sources { Label: instance }: each instance's 'change' pushes a step named
 *   Label once it is idle for idleMs (a drag = one step). thumb() -> canvas | Blob | ImageBitmap for each step.
 *   link.commit(label) pushes getValues() now. sync(): apply the active state again.
 *
 * Example:
 *   const media = { 'clip.mp4': blob };
 *   const tl = t3kit.timeline.create(tlEl, { value: edl });
 *   const pl = t3kit.player.create(plEl, { media, controls: false });
 *   t3kit.links.playerTimeline(pl, tl);
 *   t3kit.links.developHistogram(dev, hist);  t3kit.links.curvesDevelop(curves, dev);
 *   const h = t3kit.links.historyState(history, () => ({ dev: dev.get(), curves: curves.get() }),
 *     (s) => { dev.set(s.dev); curves.set(s.curves); }, { sources: { Develop: dev, Curves: curves } });
 */
(function () {
  "use strict";
  const t3kit = (window.t3kit = window.t3kit || {});

  function need(instance, methods, what) {
    if (!instance || typeof instance !== "object")
      throw new TypeError(`t3kit.links: ${what} must be a t3kit.${what} instance`);
    for (const m of methods) {
      if (typeof instance[m] !== "function")
        throw new TypeError(`t3kit.links: ${what} has no ${m}() (pass a t3kit.${what} instance)`);
    }
  }

  // The returned handle: a function that unlinks once, plus sync() and destroy().
  function makeLink(offs, sync, extra = {}) {
    let live = true;
    const unlink = () => {
      if (!live) return;
      live = false;
      for (const off of offs.splice(0)) off();
    };
    unlink.destroy = unlink;
    unlink.sync = () => {
      if (!live) throw new Error("t3kit.links: sync() after unlink");
      sync();
    };
    unlink.isLinked = () => live;
    return Object.assign(unlink, extra);
  }

  function playerTimeline(player, timeline) {
    need(player, ["get", "set", "seek", "play", "pause", "on"], "player");
    need(timeline, ["get", "seek", "play", "pause", "on", "setTransport"], "timeline");
    let echo = false; // true while this link writes into one side, so that side's events are not bounced back
    let timelinePlaying = false;
    const quietly = (fn) => {
      echo = true;
      try {
        fn();
      } finally {
        echo = false;
      }
    };
    const load = () => {
      const edl = timeline.get();
      return player.set({ value: edl, time: edl.playhead });
    };
    const offs = [
      timeline.on("play", ({ playing }) => {
        timelinePlaying = playing;
      }),
      timeline.on("change", (edl) => {
        if (!echo) player.set({ value: edl });
      }),
      timeline.on("playhead", (t) => {
        if (!echo) player.seek(t);
      }),
      player.on("timeupdate", ({ time, playing }) => {
        if (echo) return;
        quietly(() => {
          timeline.seek(time);
          if (playing && !timelinePlaying) timeline.play(1);
          else if (!playing && timelinePlaying) timeline.pause();
        });
      }),
      () => timeline.setTransport(null),
    ];
    timeline.setTransport({
      play: () => {
        if (!echo) player.play();
      },
      pause: () => {
        if (!echo) player.pause();
      },
    });
    load();
    return makeLink(offs, load);
  }

  function developHistogram(develop, histogram) {
    need(develop, ["on", "getImageData"], "develop");
    need(histogram, ["update"], "histogram");
    let busy = false;
    let again = false;
    let live = true;
    // getImageData() runs synchronously inside develop's 'render', before the next frame is presented.
    async function refresh() {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          await histogram.update(develop.getImageData());
        } while (again && live);
      } finally {
        busy = false;
      }
    }
    const offs = [
      develop.on("render", () => {
        refresh();
      }),
      () => {
        live = false;
      },
    ];
    return makeLink(offs, () => {
      refresh();
    });
  }

  function isIdentity(lut) {
    for (let i = 0; i < 256; i++) if (lut[i] !== i) return false;
    return true;
  }

  function curvesDevelop(curves, develop) {
    need(curves, ["lut", "on", "reset", "setHistogram"], "curves");
    need(develop, ["set", "on", "histogram"], "develop");
    let ownRender = false; // the next develop render was caused by a curve drag, so the backdrop stays put
    const push = () => {
      const lut = curves.lut();
      develop.set({
        curves: [lut.r, lut.g, lut.b].every(isIdentity) ? null : { r: lut.r, g: lut.g, b: lut.b },
      });
    };
    const offs = [
      curves.on("change", () => {
        ownRender = true;
        push();
      }),
      develop.on("render", () => {
        if (ownRender) {
          ownRender = false;
          return;
        }
        curves.setHistogram(develop.histogram());
      }),
      develop.on("change", (value) => {
        const lut = curves.lut();
        if (value.curves === null && ![lut.rgb, lut.r, lut.g, lut.b].every(isIdentity))
          curves.reset();
      }),
    ];
    push();
    return makeLink(offs, push);
  }

  function historyState(history, getValues, setValues, options = {}) {
    need(history, ["get", "set", "push", "on"], "history");
    if (typeof getValues !== "function" || typeof setValues !== "function") {
      throw new TypeError("t3kit.links.historyState: getValues and setValues must be functions");
    }
    for (const key of Object.keys(options)) {
      if (!["sources", "idleMs", "thumb"].includes(key)) {
        throw new TypeError(
          `t3kit.links.historyState: unknown option "${key}" (use sources, idleMs, thumb)`,
        );
      }
    }
    const sources = options.sources ?? {};
    const idleMs = options.idleMs ?? 300;
    const thumb = options.thumb ?? null;
    if (!Number.isFinite(idleMs) || idleMs < 0)
      throw new RangeError("t3kit.links.historyState: idleMs must be >= 0");
    if (thumb !== null && typeof thumb !== "function")
      throw new TypeError("t3kit.links.historyState: thumb must be a function");

    const RESTORE = new Set(["undo", "redo", "jump", "applyPreset"]);
    let timer = 0;
    let pendingLabel = null;
    const apply = () => setValues(structuredClone(history.get().state));
    const commit = (label) => {
      if (typeof label !== "string" || !label)
        throw new TypeError("t3kit.links.historyState: commit(label) needs a label");
      clearTimeout(timer);
      timer = 0;
      pendingLabel = null;
      return history.push(label, getValues(), thumb ? thumb() : undefined);
    };
    const offs = [
      history.on("change", (_model, { action }) => {
        if (!RESTORE.has(action)) return;
        clearTimeout(timer); // an edit still settling is superseded by the restored step
        timer = 0;
        pendingLabel = null;
        apply();
      }),
      () => clearTimeout(timer),
    ];
    for (const [label, instance] of Object.entries(sources)) {
      need(instance, ["on"], `history source "${label}"`);
      offs.push(
        instance.on("change", () => {
          if (pendingLabel !== null && pendingLabel !== label) commit(pendingLabel);
          pendingLabel = label;
          clearTimeout(timer);
          timer = setTimeout(() => commit(label), idleMs);
        }),
      );
    }
    if (history.get().state === null) history.set({ state: getValues() });
    else apply();
    return makeLink(offs, apply, { commit });
  }

  t3kit.links = { playerTimeline, developHistogram, curvesDevelop, historyState };
})();
