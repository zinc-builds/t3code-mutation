/**
 * t3kit.player: edit-list video player. Plays a timeline value (EDL) across several source videos as one seamless
 *   sequence (two alternating <video> slots), with per-clip speed and CSS-filter colour, pro transport and stills.
 * create(container, { value?, media?, track?, time?, fps=30, loop=false, muted=false, volume=1, controls=true })
 *   value  timeline value { tracks:[{ id, kind?, hidden?, muted?, clips:[Clip] }] } (what t3kit.timeline get()
 *          returns), or { clips:[Clip] } / Clip[] for one track. playhead/markers/range are ignored: use time.
 *   Clip   { id?, src, in, out, start?, speed=1, color?, volumeDb=0, muted?, label? }  in/out = source seconds.
 *          Timeline span = start .. start + (out - in) / speed (speed 0.0625..16). No start = right after the previous
 *          clip. Gaps play as an empty stage. color { brightness, contrast, saturation, temp: -100..100 (0 = none),
 *          look?: 'warm'|'cool'|'vintage'|'punch'|'mono' }.
 *   media  { [src]: asset url | Blob | File }; clip.src (or t3-edl/1 clip.source) is looked up here, else it must be a
 *          URL. http(s) URLs play in place with crossOrigin 'anonymous'; Blobs become object URLs the player revokes.
 *   track  id of the track to play. Default: the first non-audio, non-hidden track with clips. One track, no compositing.
 *   controls false = picture only (no scrub bar, transport or clip badge).
 * Instance
 *   get()  -> { value, time, duration, playing, clipIndex, clipId, loop, muted, volume } (JSON-serialisable)
 *   set({ value?, media?, track?, time?, playing?, loop?, muted?, volume? }) -> Promise. Never emits 'change'.
 *          A value that changes only color/volume/label restyles live (no reseek); otherwise (a renewed media URL
 *          too) the playhead and play state are kept.
 *   play() / seek(t) / toggle() -> Promise. pause(). seek keeps the play state; rapid seeks coalesce to the newest.
 *   time() / duration() -> timeline seconds.   clipAt(t) -> { index, id, sourceTime } | null (null in a gap)
 *   frame(t = time(), { maxSide = 1920, filtered = true }) -> Promise<HTMLCanvasElement>: still at timeline t with
 *          the clip colour, longest side <= maxSide (Infinity = native). Rejects in a gap. Never disturbs playback.
 *   on(event, cb) -> unsubscribe.   destroy() -> removes DOM, media elements, object URLs and listeners.
 *   setAudioChain(build | null): sound runs through build(ctx, input) -> last AudioNode (Web Audio); null = direct.
 * Events
 *   'change'     user transport only (play/pause, scrub, keys, mute, volume, loop); payload get()
 *   'timeupdate' every presented frame while playing, plus after seek/pause/cut: { time, duration, playing,
 *                clipIndex (-1 in a gap), clipId, sourceTime }. Drive a timeline playhead from this.
 *   'ended'      payload get(); never fires while loop is on.   'error' { message }; playback stops.
 * Keys (player focused): Space/K play-pause, L play, Left/Right frame (Shift = 1 s), Home/End, M mute.
 *   Click the picture to play/pause. The scrub bar shows the clips; a drag resumes playback on release.
 * Performance: requestVideoFrameCallback clock, idle while paused; CSS-filter colour; frame() on a hidden decoder.
 * Example
 *   const p = t3kit.player.create(el, { value: timeline.get(), media: { 'clip.mp4': asset.url } });
 *   p.on('timeupdate', ({ time }) => movePlayhead(time));      // keep a timeline in sync
 *   timeline.on('change', (v) => p.set({ value: v }));         // edits re-sequence; colour-only edits restyle live
 *   await p.play();
 *   const still = await p.frame(4.5);                          // <canvas>
 */
(function () {
  const t3kit = (window.t3kit = window.t3kit || {});

  const EPS = 1e-3;
  const PRELOAD_LEAD = 1; // timeline seconds before a cut when the standby slot is seeked to the next clip
  const NARROW_PX = 520;
  const MIN_SPEED = 0.0625; // HTMLMediaElement.playbackRate limits
  const MAX_SPEED = 16;
  const URL_RE = /^(blob:|data:|https?:|file:|\.{0,2}\/)/;
  // An http(s) source (a workspace asset URL, served with CORS) loads with crossOrigin 'anonymous': without it Web
  // Audio hears silence from the element and frames drawn from it taint their canvas. blob: and data: stay as they are.
  function setSource(el, url) {
    if (/^https?:$/.test(new URL(url, document.baseURI).protocol)) el.crossOrigin = "anonymous";
    else el.removeAttribute("crossorigin");
    el.src = url;
  }
  const SET_KEYS = ["value", "media", "track", "time", "playing", "loop", "muted", "volume"];
  const EVENTS = ["change", "timeupdate", "ended", "error"];
  const COLOR_KEYS = ["brightness", "contrast", "saturation", "temp"];
  const LOOKS = {
    warm: "sepia(0.18)",
    cool: "hue-rotate(-12deg)",
    vintage: "sepia(0.35) contrast(0.95)",
    punch: "contrast(1.15) saturate(1.25)",
    mono: "grayscale(1)",
  };
  const ICON = {
    start: "M3 3h1.6v10H3zM13 3v10L5.4 8z",
    back: "M10.5 3v10L5 8z",
    play: "M5 3v10l8-5z",
    pause: "M4 3h3v10H4zM9 3h3v10H9z",
    fwd: "M5.5 3v10L11 8z",
    end: "M3 3v10l7.6-5zM11.4 3H13v10h-1.6z",
    volume: "M2 6h2.6L8 3v10L4.6 10H2zM10.2 4.6l.9-.9a6 6 0 0 1 0 8.6l-.9-.9a4.7 4.7 0 0 0 0-6.8z",
    muted:
      "M2 6h2.6L8 3v10L4.6 10H2zM9.6 6l.9-.9 1.6 1.6 1.6-1.6.9.9L13 7.6l1.6 1.6-.9.9-1.6-1.6-1.6 1.6-.9-.9 1.6-1.6z",
    loop: "M3 6a3 3 0 0 1 3-3h6.5V1.8L15 4.2 12.5 6.6V5H6a1 1 0 0 0-1 1v1H3zm10 4a3 3 0 0 1-3 3H3.5v1.2L1 11.8l2.5-2.4V11H10a1 1 0 0 0 1-1V9h2z",
  };
  const STYLE = `
.t3k-player-root{box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-radius:var(--radius);font:13px/1.4 var(--font-sans);outline:none;-webkit-user-select:none;user-select:none}
.t3k-player-root:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.t3k-player-stage{position:relative;flex:1 1 auto;min-height:72px;aspect-ratio:var(--t3k-player-ar,16 / 9);overflow:hidden;background:var(--background);cursor:pointer}
.t3k-player-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;pointer-events:none}
.t3k-player-video.t3k-player-shown{opacity:1}
.t3k-player-empty{position:absolute;inset:0;display:none;place-items:center;color:var(--muted-foreground);font-size:12px;cursor:default}
.t3k-player-is-empty .t3k-player-empty{display:grid}
.t3k-player-badge{position:absolute;left:10px;top:10px;max-width:calc(100% - 20px);box-sizing:border-box;padding:2px 8px;border:1px solid var(--border);border-radius:calc(var(--radius) - 4px);background:var(--popover);color:var(--foreground);font:11px/1.6 var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.t3k-player-badge:empty{display:none}
.t3k-player-scrub{position:relative;flex:none;height:26px;border-top:1px solid var(--border);background:var(--muted)}
.t3k-player-segs{position:absolute;inset:5px 0;pointer-events:none}
.t3k-player-seg{position:absolute;top:0;bottom:0;box-sizing:border-box;border-left:1px solid var(--card);background:color-mix(in srgb,var(--primary) 16%,var(--muted))}
.t3k-player-seg.t3k-player-cur{background:color-mix(in srgb,var(--primary) 34%,var(--muted))}
.t3k-player-fill{position:absolute;inset:0;transform-origin:0 50%;transform:scaleX(0);background:color-mix(in srgb,var(--primary) 18%,transparent);pointer-events:none}
.t3k-player-range{position:absolute;inset:0;width:100%;height:100%;margin:0;background:transparent;-webkit-appearance:none;appearance:none;cursor:pointer}
.t3k-player-range:disabled{cursor:default}
.t3k-player-range::-webkit-slider-runnable-track{height:100%;background:transparent}
.t3k-player-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:2px;height:26px;border:0;border-radius:0;background:var(--primary)}
.t3k-player-range::-moz-range-track{background:transparent}
.t3k-player-range::-moz-range-thumb{width:2px;height:26px;border:0;border-radius:0;background:var(--primary)}
.t3k-player-range:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.t3k-player-bar{display:flex;flex:none;align-items:center;gap:2px;min-width:0;padding:6px 8px;border-top:1px solid var(--border)}
.t3k-player-btn{display:inline-grid;flex:none;place-items:center;width:28px;height:28px;margin:0;padding:0;border:0;border-radius:calc(var(--radius) - 2px);background:transparent;color:var(--foreground);cursor:pointer}
.t3k-player-btn:hover:not(:disabled){background:color-mix(in srgb,var(--foreground) 9%,transparent)}
.t3k-player-btn:disabled{opacity:.4;cursor:default}
.t3k-player-btn[aria-pressed="true"]{color:var(--primary)}
.t3k-player-btn svg{width:16px;height:16px;fill:currentColor}
.t3k-player-btn.t3k-player-play{width:32px;height:32px;margin:0 4px;background:var(--primary);color:var(--primary-foreground)}
.t3k-player-btn.t3k-player-play:hover:not(:disabled){background:color-mix(in srgb,var(--primary) 86%,var(--foreground))}
.t3k-player-time{min-width:0;overflow:hidden;text-overflow:ellipsis;margin:0 10px;font:12px/1 var(--font-mono);font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--foreground)}
.t3k-player-dur{color:var(--muted-foreground)}
.t3k-player-spacer{flex:1 1 auto;min-width:4px}
.t3k-player-vol{width:76px;margin:0 6px 0 2px;accent-color:var(--primary)}
.t3k-player-btn:focus-visible,.t3k-player-vol:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.t3k-player-narrow .t3k-player-step,.t3k-player-narrow .t3k-player-vol,.t3k-player-narrow .t3k-player-dur{display:none}
.t3k-player-narrow .t3k-player-time{margin:0 6px}
.t3k-player-bare .t3k-player-scrub,.t3k-player-bare .t3k-player-bar,.t3k-player-bare .t3k-player-badge{display:none}
`;

  const round3 = (x) => Math.round(x * 1000) / 1000;
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  function injectStyle() {
    if (document.head.querySelector('style[data-t3kit="player"]')) return;
    const style = document.createElement("style");
    style.dataset.t3kit = "player";
    style.textContent = STYLE;
    document.head.append(style);
  }

  function timecode(seconds, fps) {
    const frames = Math.max(0, Math.floor(seconds * fps + 1e-4));
    const s = Math.floor(frames / fps);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(frames % fps)}`;
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  // Resolves on `name`; rejects on a media error.
  function waitEvent(v, name) {
    return new Promise((resolve, reject) => {
      const onOk = () => {
        v.removeEventListener("error", onErr);
        resolve();
      };
      const onErr = () => {
        v.removeEventListener(name, onOk);
        reject(
          new Error(
            `t3kit.player: media error ${v.error ? v.error.code : "?"} while waiting for ${name}`,
          ),
        );
      };
      v.addEventListener(name, onOk, { once: true });
      v.addEventListener("error", onErr, { once: true });
    });
  }

  // Resolves once v shows source time t. `superseded` (optional) resolves when a newer request takes the element,
  // and stale() then reports it, so an abandoned seek never blocks its caller.
  async function seekVideo(v, t, stale, superseded) {
    const wait = (p) => (superseded ? Promise.race([p, superseded]) : p);
    if (v.error) throw new Error(`t3kit.player: media error ${v.error.code}`);
    if (v.readyState < 2) await wait(waitEvent(v, "loadeddata"));
    if (stale()) return;
    if (v.seeking || Math.abs(v.currentTime - t) >= 0.0005) {
      const seeked = waitEvent(v, "seeked");
      v.currentTime = t;
      await wait(seeked);
    }
  }

  function colorFilter(color, where) {
    if (color === undefined || color === null) return "none";
    if (!isObj(color)) throw new TypeError(`t3kit.player: ${where}.color must be an object`);
    const k = {};
    for (const key of COLOR_KEYS) {
      const v = color[key] ?? 0;
      if (!Number.isFinite(v))
        throw new TypeError(`t3kit.player: ${where}.color.${key} must be a number -100..100`);
      k[key] = Math.min(100, Math.max(-100, v));
    }
    const parts = [];
    if (k.brightness) parts.push(`brightness(${(1 + k.brightness / 100).toFixed(3)})`);
    if (k.contrast) parts.push(`contrast(${(1 + k.contrast / 100).toFixed(3)})`);
    if (k.saturation) parts.push(`saturate(${(1 + k.saturation / 100).toFixed(3)})`);
    if (k.temp > 0) parts.push(`sepia(${((k.temp / 100) * 0.3).toFixed(3)})`);
    if (k.temp < 0) parts.push(`hue-rotate(${((k.temp / 100) * 15).toFixed(2)}deg)`);
    if (color.look !== undefined && color.look !== null && color.look !== "") {
      if (!Object.hasOwn(LOOKS, color.look))
        throw new TypeError(`t3kit.player: ${where}.color.look "${color.look}" is unknown`);
      parts.push(LOOKS[color.look]);
    }
    return parts.join(" ") || "none";
  }

  function tracksOf(value) {
    if (Array.isArray(value)) return [{ id: "main", clips: value }];
    if (isObj(value) && Array.isArray(value.tracks)) return value.tracks;
    if (isObj(value) && Array.isArray(value.clips)) return [{ id: "main", clips: value.clips }];
    throw new TypeError(
      "t3kit.player: value must be { tracks:[...] }, { clips:[...] } or an array of clips",
    );
  }

  // Flattens one track of the value into playable clips sorted by start. urlFor throws for unknown media.
  function compile(value, trackId, urlFor) {
    if (value === null) return [];
    const tracks = tracksOf(value);
    let track;
    if (trackId === undefined || trackId === null) {
      track = tracks.find(
        (t) => t.kind !== "audio" && !t.hidden && Array.isArray(t.clips) && t.clips.length > 0,
      );
      if (!track) return [];
    } else {
      track = tracks.find((t) => t.id === trackId);
      if (!track) throw new Error(`t3kit.player: no track with id "${trackId}"`);
    }
    if (!Array.isArray(track.clips))
      throw new TypeError(`t3kit.player: track "${track.id}" needs a clips array`);
    let cursor = 0;
    const clips = track.clips.map((c, i) => {
      const where = `clips[${i}]`;
      if (!isObj(c)) throw new TypeError(`t3kit.player: ${where} must be an object`);
      const src = c.src ?? c.source;
      if (typeof src !== "string" || src === "")
        throw new TypeError(`t3kit.player: ${where}.src must name a media key or URL`);
      if (!(Number.isFinite(c.in) && c.in >= 0 && Number.isFinite(c.out) && c.out > c.in)) {
        throw new RangeError(`t3kit.player: ${where} needs 0 <= in < out (source seconds)`);
      }
      const speed = c.speed ?? 1;
      if (!(Number.isFinite(speed) && speed >= MIN_SPEED && speed <= MAX_SPEED)) {
        throw new RangeError(`t3kit.player: ${where}.speed must be ${MIN_SPEED}..${MAX_SPEED}`);
      }
      const start = c.start ?? cursor;
      if (!(Number.isFinite(start) && start >= 0))
        throw new RangeError(`t3kit.player: ${where}.start must be >= 0`);
      const end = start + (c.out - c.in) / speed;
      cursor = end;
      const volumeDb = c.volumeDb ?? 0;
      if (!Number.isFinite(volumeDb))
        throw new TypeError(`t3kit.player: ${where}.volumeDb must be a number`);
      return {
        id: c.id ?? null,
        label: String(c.label ?? c.name ?? `Clip ${i + 1}`),
        url: urlFor(src),
        start,
        end,
        in: c.in,
        out: c.out,
        speed,
        filter: colorFilter(c.color, where),
        gain: Math.min(1, 10 ** (volumeDb / 20)),
        muted: Boolean(c.muted || track.muted),
      };
    });
    clips.sort((a, b) => a.start - b.start);
    for (let i = 1; i < clips.length; i++) {
      if (clips[i].start < clips[i - 1].end - EPS) {
        throw new RangeError(
          `t3kit.player: "${clips[i - 1].label}" and "${clips[i].label}" overlap on the track`,
        );
      }
    }
    return clips;
  }

  const timing = (clips) =>
    clips.map((c) => `${c.url}|${c.start}|${c.in}|${c.out}|${c.speed}`).join("\n");

  function buttonHtml(icon, label, cls = "") {
    return `<button type="button" class="t3k-player-btn ${cls}" data-act="${icon}" aria-label="${label}" title="${label}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${ICON[icon]}"></path></svg></button>`;
  }

  function create(container, options = {}) {
    if (!(container instanceof HTMLElement))
      throw new TypeError("t3kit.player: create(container) needs an HTMLElement");
    if (!isObj(options)) throw new TypeError("t3kit.player: options must be an object");
    injectStyle();
    const fps = options.fps ?? 30;
    if (!(Number.isInteger(fps) && fps >= 1 && fps <= 240))
      throw new RangeError("t3kit.player: fps must be an integer 1..240");

    const root = document.createElement("div");
    root.className = "t3k-player-root";
    root.tabIndex = 0;
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Video player");
    root.classList.toggle("t3k-player-bare", options.controls === false);
    root.innerHTML = `
      <div class="t3k-player-stage">
        <div class="t3k-player-empty">Nothing to play</div>
        <div class="t3k-player-badge"></div>
      </div>
      <div class="t3k-player-scrub">
        <div class="t3k-player-segs"></div>
        <div class="t3k-player-fill"></div>
        <input class="t3k-player-range" type="range" min="0" max="0" step="any" value="0" aria-label="Playhead">
      </div>
      <div class="t3k-player-bar">
        ${buttonHtml("start", "Go to start")}${buttonHtml("back", "Previous frame", "t3k-player-step")}${buttonHtml("play", "Play", "t3k-player-play")}${buttonHtml("fwd", "Next frame", "t3k-player-step")}${buttonHtml("end", "Go to end")}
        <span class="t3k-player-time"><span class="t3k-player-now">00:00:00:00</span><span class="t3k-player-dur"> / 00:00:00:00</span></span>
        <span class="t3k-player-spacer"></span>
        ${buttonHtml("volume", "Mute", "t3k-player-mute")}<input class="t3k-player-vol" type="range" min="0" max="1" step="0.01" value="1" aria-label="Volume">${buttonHtml("loop", "Loop", "t3k-player-loop")}
      </div>`;
    container.append(root);

    const q = (sel) => root.querySelector(sel);
    const stage = q(".t3k-player-stage");
    const badge = q(".t3k-player-badge");
    const segs = q(".t3k-player-segs");
    const fill = q(".t3k-player-fill");
    const range = q(".t3k-player-range");
    const nowLabel = q(".t3k-player-now");
    const durLabel = q(".t3k-player-dur");
    const volInput = q(".t3k-player-vol");
    const btn = Object.fromEntries(
      [...root.querySelectorAll("[data-act]")].map((b) => [b.dataset.act, b]),
    );
    const playPath = btn.play.querySelector("path");
    const mutePath = btn.volume.querySelector("path");

    let value = null; // the value as given (cloned), returned by get()
    let trackId;
    let media = {};
    const blobUrls = new Map(); // Blob -> object URL we own
    let clips = [];
    let duration = 0;
    let loop = false;
    let muted = false;
    let volume = 1;
    let active = 0;
    let clipIdx = -1;
    let time = 0;
    let playing = false;
    let transition = false; // a cut is in flight; blocks duplicate cut triggers
    let gen = 0; // bumped by every operation that must cancel in-flight async work
    let playReq = 0;
    let gapRaf = 0;
    let scrubbing = false;
    let scrubResume = false;
    let seekQueue = Promise.resolve();
    let seekTarget = null;
    let seekResume = false;
    let grabChain = Promise.resolve();
    let grabber = null;
    let grabToken = 0;
    let destroyed = false;
    let lastFailure = null;
    let shownPlaying = null;
    let shownClip = null;
    const listeners = Object.fromEntries(EVENTS.map((name) => [name, new Set()]));

    const clampT = (t) => Math.min(Math.max(0, t), duration);
    const emit = (name, payload) => {
      for (const cb of [...listeners[name]]) cb(payload);
    };
    const emitChange = () => emit("change", get());

    // Two slots: one plays, the other is seeked to the next clip ahead of the cut.
    const slots = [0, 1].map(() => {
      const el = document.createElement("video");
      el.className = "t3k-player-video";
      el.playsInline = true;
      el.preload = "auto";
      el.disablePictureInPicture = true;
      stage.prepend(el);
      const slot = {
        el,
        url: null,
        key: null,
        idx: -1,
        ready: null,
        token: 0,
        wake: null,
        frameCb: 0,
      };
      const isLive = () => playing && !transition && slots[active] === slot && clipIdx >= 0;
      // A clip ending at the source's natural end stops presenting frames before the clock reaches it.
      el.addEventListener("ended", () => {
        if (isLive()) cut();
      });
      // Safety net for hidden tabs, where video frame callbacks pause but media time keeps running.
      el.addEventListener("timeupdate", () => {
        if (isLive() && el.currentTime >= clips[clipIdx].out - EPS) cut();
      });
      el.addEventListener("loadedmetadata", () => {
        if (el.videoWidth && el.videoHeight)
          stage.style.setProperty("--t3k-player-ar", `${el.videoWidth} / ${el.videoHeight}`);
      });
      el.addEventListener("error", () => {
        if (!destroyed && el.getAttribute("src"))
          fail(new Error(`t3kit.player: media error ${el.error ? el.error.code : "?"}`));
      });
      return slot;
    });

    // ---- media ----
    function resolver(map) {
      return (src) => {
        if (Object.hasOwn(map, src)) {
          const m = map[src];
          if (typeof m === "string") return m;
          if (m instanceof Blob) {
            if (!blobUrls.has(m)) blobUrls.set(m, URL.createObjectURL(m));
            return blobUrls.get(m);
          }
          throw new TypeError(`t3kit.player: media["${src}"] must be a Blob, File or URL string`);
        }
        if (URL_RE.test(src)) return src;
        throw new Error(`t3kit.player: no media for src "${src}"; pass media: { "${src}": blob }`);
      };
    }
    // Chrome's media loader can still be reading a blob: URL for a few ms after the element is unloaded, and revoking
    // it then logs ERR_FILE_NOT_FOUND, so revocation waits until the loader has let go (measured: 50 ms suffices).
    function revokeAfterRelease(urls) {
      setTimeout(() => {
        for (const url of urls) URL.revokeObjectURL(url);
      }, 250);
    }
    // Revokes object URLs for Blobs no longer in `map` and unloads any element still pointing at one.
    function pruneUrls(map) {
      const keep = new Set(Object.values(map));
      const revoked = new Set();
      for (const [blob, url] of blobUrls) {
        if (!keep.has(blob)) {
          blobUrls.delete(blob);
          revoked.add(url);
        }
      }
      if (!revoked.size) return;
      for (const s of slots) {
        if (!revoked.has(s.url)) continue;
        s.token += 1;
        if (s.wake) s.wake();
        s.url = null;
        s.key = null;
        s.idx = -1;
        s.el.removeAttribute("src");
        s.el.load();
      }
      if (grabber && revoked.has(grabber.dataset.url)) {
        delete grabber.dataset.url;
        grabber.removeAttribute("src");
        grabber.load();
      }
      revokeAfterRelease(revoked);
    }

    // ---- helpers ----
    function clipIndexAt(t) {
      return clips.findIndex((c) => t >= c.start - EPS && t < c.end - EPS);
    }
    function locate(t) {
      if (clips.length && t >= duration - EPS) return clips.length - 1;
      return clipIndexAt(t);
    }
    function sourceAt(idx, t) {
      const c = clips[idx];
      return Math.min(c.out, Math.max(c.in, c.in + (t - c.start) * c.speed));
    }
    function applyLook(slot) {
      const c = clips[slot.idx];
      if (!c) return;
      slot.el.style.filter = c.filter;
      slot.el.volume = Math.min(1, volume * c.gain);
      slot.el.muted = muted || c.muted;
    }
    function showActive(on) {
      slots.forEach((s, i) => s.el.classList.toggle("t3k-player-shown", on && i === active));
    }
    function pauseAll() {
      for (const s of slots) s.el.pause();
    }
    function cancelClock() {
      for (const s of slots) {
        if (s.frameCb) {
          s.el.cancelVideoFrameCallback(s.frameCb);
          s.frameCb = 0;
        }
      }
      if (gapRaf) {
        cancelAnimationFrame(gapRaf);
        gapRaf = 0;
      }
    }
    function haltPlayback() {
      playing = false;
      transition = false;
      gen += 1;
      cancelClock();
      pauseAll();
    }

    // Seeks slot i to clip idx at srcTime. Reuses the pending seek while the request is unchanged.
    function prepare(i, idx, srcTime) {
      const s = slots[i];
      const key = `${idx}@${srcTime}`;
      if (s.key === key) return s.ready;
      const c = clips[idx];
      const token = ++s.token;
      if (s.wake) s.wake(); // releases the superseded request, which then sees it is stale
      const superseded = new Promise((resolve) => {
        s.wake = resolve;
      });
      s.key = key;
      s.idx = idx;
      applyLook(s);
      if (s.url !== c.url) {
        s.url = c.url;
        setSource(s.el, c.url);
      }
      // Assigning src runs the load algorithm, which resets the rate, so the rate comes after it.
      s.el.defaultPlaybackRate = c.speed;
      s.el.playbackRate = c.speed;
      s.ready = seekVideo(s.el, srcTime, () => s.token !== token, superseded);
      return s.ready;
    }
    // Prefers a slot already cued to this frame, then one holding the same source, so a seek never blanks the picture.
    function pickSlot(idx, srcTime) {
      if (slots[1 - active].key === `${idx}@${srcTime}`) return 1 - active;
      if (slots[active].url === clips[idx].url) return active;
      return 1 - active;
    }
    function swapTo(i) {
      if (i === active) return;
      slots[active].el.pause();
      active = i;
    }
    function nextIndex(idx) {
      if (idx + 1 < clips.length) return idx + 1;
      return loop ? 0 : -1;
    }

    // ---- UI ----
    function renderSegments() {
      segs.replaceChildren(
        ...clips.map((c) => {
          const seg = document.createElement("div");
          seg.className = "t3k-player-seg";
          seg.style.left = `${(c.start / duration) * 100}%`;
          seg.style.width = `${((c.end - c.start) / duration) * 100}%`;
          return seg;
        }),
      );
      range.max = String(duration);
      shownClip = null;
    }
    function syncControls() {
      const none = clips.length === 0;
      root.classList.toggle("t3k-player-is-empty", none);
      for (const b of [btn.start, btn.back, btn.play, btn.fwd, btn.end]) b.disabled = none;
      range.disabled = none;
      btn.volume.setAttribute("aria-pressed", String(muted));
      btn.volume.setAttribute("aria-label", muted ? "Unmute" : "Mute");
      mutePath.setAttribute("d", muted ? ICON.muted : ICON.volume);
      btn.loop.setAttribute("aria-pressed", String(loop));
      volInput.value = String(volume);
    }
    function publish() {
      const c = clipIdx >= 0 ? clips[clipIdx] : null;
      if (shownPlaying !== playing) {
        shownPlaying = playing;
        btn.play.setAttribute("aria-label", playing ? "Pause" : "Play");
        btn.play.title = playing ? "Pause" : "Play";
        playPath.setAttribute("d", playing ? ICON.pause : ICON.play);
      }
      setText(nowLabel, timecode(time, fps));
      setText(durLabel, ` / ${timecode(duration, fps)}`);
      if (!scrubbing) range.value = String(time);
      range.setAttribute("aria-valuetext", timecode(time, fps));
      fill.style.transform = `scaleX(${duration > 0 ? time / duration : 0})`;
      if (shownClip !== clipIdx) {
        const prev = segs.querySelector(".t3k-player-cur");
        if (prev) prev.classList.remove("t3k-player-cur");
        if (c) segs.children[clipIdx].classList.add("t3k-player-cur");
        shownClip = clipIdx;
        let text = "";
        if (c)
          text = `${clipIdx + 1}/${clips.length} · ${c.label}${c.speed === 1 ? "" : ` · ${c.speed}×`}`;
        else if (clips.length) text = "Gap";
        setText(badge, text);
      }
      emit("timeupdate", {
        time: round3(time),
        duration: round3(duration),
        playing,
        clipIndex: clipIdx,
        clipId: c ? c.id : null,
        sourceTime: c ? round3(sourceAt(clipIdx, time)) : null,
      });
    }

    // ---- clock: runs only while the active element presents frames ----
    function watchActive() {
      cancelClock();
      const s = slots[active];
      s.frameCb = s.el.requestVideoFrameCallback(onFrame);
    }
    function onFrame(_now, meta) {
      const s = slots[active];
      s.frameCb = 0;
      if (!playing || transition || clipIdx < 0) return;
      const c = clips[clipIdx];
      time = Math.max(c.start, c.start + (meta.mediaTime - c.in) / c.speed);
      if (time >= c.end - EPS) {
        cut();
        return;
      }
      const next = nextIndex(clipIdx);
      if (next >= 0 && time >= c.end - PRELOAD_LEAD)
        prepare(1 - active, next, clips[next].in).catch(fail);
      publish();
      s.frameCb = s.el.requestVideoFrameCallback(onFrame);
    }

    function cut() {
      if (transition) return;
      transition = true;
      cancelClock();
      const finished = clips[clipIdx];
      const next = clipIdx + 1;
      if (next >= clips.length) {
        finish();
        return;
      }
      time = finished.end;
      if (clips[next].start > finished.end + EPS) {
        runGap(next, gen);
        return;
      }
      enterClip(next, gen).catch(fail);
    }

    // Plays empty timeline on the wall clock, then enters clip nextIdx.
    function runGap(nextIdx, g) {
      pauseAll();
      showActive(false);
      clipIdx = -1;
      const from = time;
      const target = clips[nextIdx].start;
      const wall = performance.now();
      prepare(1 - active, nextIdx, clips[nextIdx].in).catch(fail);
      const step = (now) => {
        gapRaf = 0;
        if (g !== gen) return;
        time = Math.min(target, from + Math.max(0, now - wall) / 1000); // rAF stamps can predate `wall`
        if (time >= target - EPS) {
          enterClip(nextIdx, g).catch(fail);
          return;
        }
        publish();
        gapRaf = requestAnimationFrame(step);
      };
      publish();
      gapRaf = requestAnimationFrame(step);
    }

    // Swaps to the standby slot, which the preload has normally already seeked to the clip's in point.
    async function enterClip(idx, g) {
      transition = true;
      const incoming = 1 - active;
      await prepare(incoming, idx, clips[idx].in);
      if (g !== gen) return;
      slots[active].key = null; // the outgoing element has played on, so its cue is stale
      swapTo(incoming);
      clipIdx = idx;
      time = clips[idx].start;
      showActive(true);
      startPlayback(g);
    }

    function startPlayback(g) {
      const s = slots[active];
      s.key = null; // playing moves the element away from its cue
      transition = false;
      watchActive();
      s.el.play().catch((err) => {
        // AbortError means a pause or new src interrupted play(); that is not a failure.
        if (g === gen && err.name !== "AbortError") fail(err);
      });
      publish();
    }

    function finish() {
      haltPlayback();
      if (loop) {
        time = 0;
        playInternal().catch(fail);
        return;
      }
      time = duration;
      publish();
      emit("ended", get());
    }

    // ---- transport ----
    async function playInternal() {
      if (playing || clips.length === 0) return;
      if (time >= duration - EPS) time = 0;
      playing = true;
      transition = true;
      const g = (gen += 1);
      const idx = clipIndexAt(time);
      if (idx < 0) {
        runGap(
          clips.findIndex((c) => c.start >= time - EPS),
          g,
        );
        return;
      }
      const src = sourceAt(idx, time);
      const target = pickSlot(idx, src);
      publish();
      await prepare(target, idx, src);
      if (g !== gen) return;
      swapTo(target);
      clipIdx = idx;
      showActive(true);
      startPlayback(g);
    }
    async function doPlay() {
      resumeAudio();
      const req = ++playReq;
      await seekQueue;
      if (req !== playReq || destroyed) return;
      await playInternal();
    }
    // ---- audio chain (setAudioChain): both slots -> mix -> build(ctx, mix) -> speakers ----
    let actx = null;
    let mix = null;
    let chainOut = null;
    function setAudioChain(build) {
      alive();
      if (build !== null && typeof build !== "function")
        throw new TypeError(
          "t3kit.player: setAudioChain(build | null) needs a function (ctx, input) => AudioNode",
        );
      if (!actx) {
        if (build === null) return;
        actx = new AudioContext();
        mix = actx.createGain();
        for (const s of slots) actx.createMediaElementSource(s.el).connect(mix);
      }
      mix.disconnect();
      if (chainOut) chainOut.disconnect();
      chainOut = null;
      if (build) {
        const out = build(actx, mix);
        if (!(out instanceof AudioNode))
          throw new TypeError(
            "t3kit.player: setAudioChain build(ctx, input) must return an AudioNode",
          );
        out.connect(actx.destination);
        chainOut = out;
      } else mix.connect(actx.destination);
      resumeAudio();
    }
    // A context made before any user gesture starts suspended; play() (a gesture) resumes it.
    function resumeAudio() {
      if (actx && actx.state === "suspended") actx.resume().catch(fail);
    }
    function doPause() {
      playReq += 1;
      if (!playing) return;
      if (clipIdx >= 0 && !transition) {
        const c = clips[clipIdx];
        const el = slots[active].el;
        time = Math.min(c.end, Math.max(c.start, c.start + (el.currentTime - c.in) / c.speed));
      }
      haltPlayback();
      publish();
    }

    function seekTo(t, resume) {
      if (!Number.isFinite(t))
        throw new TypeError("t3kit.player: time must be a finite number of seconds");
      seekTarget = clampT(t);
      if (resume) seekResume = true;
      const run = seekQueue.then(drainSeeks);
      seekQueue = run.catch(fail);
      return run;
    }
    async function drainSeeks() {
      while (seekTarget !== null) {
        const t = seekTarget;
        seekTarget = null;
        await applySeek(t);
      }
      if (seekResume) {
        seekResume = false;
        await playInternal();
      }
    }
    async function applySeek(t) {
      haltPlayback();
      time = t;
      const g = gen;
      const idx = locate(t);
      if (idx < 0) {
        clipIdx = -1;
        showActive(false);
        publish();
        return;
      }
      const src = sourceAt(idx, t);
      const target = pickSlot(idx, src);
      await prepare(target, idx, src);
      if (g !== gen) return;
      swapTo(target);
      clipIdx = idx;
      showActive(true);
      publish();
    }

    // ---- value ----
    function load(nextValue, nextTrack, nextMedia) {
      let compiled;
      try {
        compiled = compile(nextValue, nextTrack, resolver(nextMedia));
      } catch (err) {
        pruneUrls(media); // drop object URLs created for the rejected media map, then report
        throw err;
      }
      value = nextValue;
      trackId = nextTrack;
      media = nextMedia;
      pruneUrls(media);
      const sameTiming = clips.length > 0 && timing(compiled) === timing(clips);
      clips = compiled;
      if (sameTiming) {
        for (const s of slots) applyLook(s);
        shownClip = null;
        return false;
      }
      haltPlayback();
      for (const s of slots) {
        s.key = null;
        s.idx = -1;
      }
      duration = clips.length ? clips[clips.length - 1].end : 0;
      clipIdx = -1;
      time = clampT(time);
      renderSegments();
      if (!clips.length) showActive(false);
      return true;
    }

    function set(partial = {}) {
      alive();
      if (!isObj(partial))
        throw new TypeError("t3kit.player: set() takes an object, e.g. set({ value })");
      for (const key of Object.keys(partial)) {
        if (!SET_KEYS.includes(key))
          throw new TypeError(
            `t3kit.player: set() has no key "${key}" (use ${SET_KEYS.join(", ")})`,
          );
      }
      if (partial.media !== undefined && !isObj(partial.media))
        throw new TypeError("t3kit.player: media must be an object");
      if (
        partial.volume !== undefined &&
        !(Number.isFinite(partial.volume) && partial.volume >= 0 && partial.volume <= 1)
      ) {
        throw new RangeError("t3kit.player: volume must be 0..1");
      }
      const wasPlaying = playing || seekResume;
      let reseek = false;
      if (
        partial.value !== undefined ||
        partial.track !== undefined ||
        partial.media !== undefined
      ) {
        reseek = load(
          partial.value === undefined ? value : structuredClone(partial.value),
          partial.track === undefined ? trackId : partial.track,
          partial.media === undefined ? media : { ...partial.media },
        );
      }
      if (partial.loop !== undefined) loop = Boolean(partial.loop);
      if (partial.muted !== undefined) muted = Boolean(partial.muted);
      if (partial.volume !== undefined) volume = partial.volume;
      if (partial.muted !== undefined || partial.volume !== undefined)
        for (const s of slots) applyLook(s);
      syncControls();
      const resume = partial.playing ?? wasPlaying;
      if (partial.time !== undefined) return seekTo(partial.time, resume);
      if (reseek && clips.length) return seekTo(time, resume);
      publish();
      if (partial.playing === true) return doPlay();
      if (partial.playing === false) doPause();
      return Promise.resolve();
    }

    function get() {
      const c = clipIdx >= 0 ? clips[clipIdx] : null;
      return {
        value: value === null ? null : structuredClone(value),
        time: round3(time),
        duration: round3(duration),
        playing,
        clipIndex: clipIdx,
        clipId: c ? c.id : null,
        loop,
        muted,
        volume,
      };
    }

    function on(name, cb) {
      if (!Object.hasOwn(listeners, name))
        throw new Error(`t3kit.player: unknown event "${name}" (use ${EVENTS.join(", ")})`);
      if (typeof cb !== "function") throw new TypeError("t3kit.player: on() needs a callback");
      listeners[name].add(cb);
      return () => listeners[name].delete(cb);
    }

    // ---- stills: serialised on one hidden decoder, so the playback slots are never disturbed ----
    function frame(t = time, { maxSide = 1920, filtered = true } = {}) {
      alive();
      if (!Number.isFinite(t))
        throw new TypeError("t3kit.player: frame(time) needs a finite number of seconds");
      if (!(maxSide > 0)) throw new RangeError("t3kit.player: maxSide must be > 0");
      const job = grabChain.then(() => grabStill(t, maxSide, filtered));
      grabChain = job.then(
        () => undefined,
        (err) => err, // keeps the queue alive; the caller receives the rejection through `job`
      );
      return job;
    }
    async function grabStill(t, maxSide, filtered) {
      const idx = locate(clampT(t));
      if (idx < 0) throw new Error(`t3kit.player: no clip at ${round3(t)} s (gap or empty edit)`);
      const c = clips[idx];
      if (!grabber) {
        grabber = document.createElement("video");
        grabber.preload = "auto";
        grabber.muted = true;
        grabber.playsInline = true;
      }
      const token = ++grabToken;
      if (grabber.dataset.url !== c.url) {
        grabber.dataset.url = c.url;
        setSource(grabber, c.url);
      }
      await seekVideo(grabber, sourceAt(idx, clampT(t)), () => token !== grabToken);
      const vw = grabber.videoWidth;
      const vh = grabber.videoHeight;
      const scale = Math.min(1, maxSide / Math.max(vw, vh));
      const bitmap = await createImageBitmap(grabber, {
        resizeWidth: Math.max(1, Math.round(vw * scale)),
        resizeHeight: Math.max(1, Math.round(vh * scale)),
        resizeQuality: "high",
      });
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (filtered) ctx.filter = c.filter;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return canvas;
    }

    function fail(err) {
      if (destroyed || err === lastFailure) return; // one failure can reach here through several promise chains
      lastFailure = err;
      haltPlayback();
      publish();
      console.error(err);
      emit("error", { message: err instanceof Error ? err.message : String(err) });
    }
    function alive() {
      if (destroyed) throw new Error("t3kit.player: instance was destroyed");
    }

    // ---- user input ----
    function userToggle() {
      if (!clips.length) return;
      if (playing) {
        doPause();
        emitChange();
      } else {
        doPlay().then(emitChange, fail);
      }
    }
    function userSeek(t, resume) {
      if (!clips.length) return;
      seekTo(t, resume).then(emitChange, fail);
    }
    function stepFrames(n) {
      const base = Math.round(time * fps);
      doPause();
      userSeek((base + n) / fps, false);
    }
    function setMuted(next) {
      muted = next;
      for (const s of slots) applyLook(s);
      syncControls();
      emitChange();
    }

    btn.play.addEventListener("click", userToggle);
    btn.start.addEventListener("click", () => userSeek(0, playing));
    btn.end.addEventListener("click", () => userSeek(duration, false));
    btn.back.addEventListener("click", () => stepFrames(-1));
    btn.fwd.addEventListener("click", () => stepFrames(1));
    btn.volume.addEventListener("click", () => setMuted(!muted));
    btn.loop.addEventListener("click", () => {
      loop = !loop;
      syncControls();
      emitChange();
    });
    volInput.addEventListener("input", () => {
      volume = Number(volInput.value);
      if (muted && volume > 0) muted = false;
      for (const s of slots) applyLook(s);
      syncControls();
      emitChange();
    });
    stage.addEventListener("pointerdown", () => root.focus({ preventScroll: true }));
    stage.addEventListener("click", userToggle);
    const endScrub = () => {
      scrubbing = false;
      if (!scrubResume) return;
      scrubResume = false;
      doPlay().then(emitChange, fail);
    };
    range.addEventListener("pointerdown", () => {
      scrubbing = true;
      scrubResume = playing;
      doPause();
      window.addEventListener("pointerup", endScrub, { once: true });
    });
    range.addEventListener("input", () => userSeek(Number(range.value), playing && !scrubbing));
    root.addEventListener("keydown", (e) => {
      if (!clips.length || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest("input")) return; // the range and volume sliders keep their own keys
      if (e.target.closest("button") && (e.key === " " || e.key === "Enter")) return;
      const step = e.shiftKey ? fps : 1;
      const actions = {
        " ": userToggle,
        k: userToggle,
        K: userToggle,
        l: () => !playing && userToggle(),
        L: () => !playing && userToggle(),
        ArrowLeft: () => stepFrames(-step),
        ArrowRight: () => stepFrames(step),
        Home: () => userSeek(0, playing),
        End: () => userSeek(duration, false),
        m: () => setMuted(!muted),
        M: () => setMuted(!muted),
      };
      const act = actions[e.key];
      if (!act) return;
      e.preventDefault();
      act();
    });

    const resizeObserver = new ResizeObserver((entries) => {
      root.classList.toggle("t3k-player-narrow", entries[0].contentRect.width < NARROW_PX);
    });
    resizeObserver.observe(root);

    function destroy() {
      if (destroyed) return;
      haltPlayback();
      destroyed = true;
      window.removeEventListener("pointerup", endScrub);
      for (const v of [...slots.map((s) => s.el), grabber]) {
        if (!v) continue;
        v.removeAttribute("src");
        v.load();
      }
      revokeAfterRelease([...blobUrls.values()]);
      blobUrls.clear();
      if (actx) actx.close().catch(fail);
      resizeObserver.disconnect();
      root.remove();
      for (const bucket of Object.values(listeners)) bucket.clear();
    }

    renderSegments();
    syncControls();
    publish();
    set({
      value: options.value ?? null,
      media: options.media ?? {},
      track: options.track,
      time: options.time ?? 0,
      loop: options.loop ?? false,
      muted: options.muted ?? false,
      volume: options.volume ?? 1,
    }).catch(fail);

    return {
      get,
      set,
      play: () => (alive(), doPlay()),
      pause: () => (alive(), doPause()),
      toggle: () => (alive(), playing ? Promise.resolve(doPause()) : doPlay()),
      seek: (t) => (alive(), seekTo(t, playing || seekResume)),
      time: () => round3(time),
      duration: () => round3(duration),
      clipAt(t) {
        const i = locate(clampT(t));
        return i < 0
          ? null
          : { index: i, id: clips[i].id, sourceTime: round3(sourceAt(i, clampT(t))) };
      },
      frame,
      setAudioChain,
      on,
      destroy,
    };
  }

  t3kit.player = { create };
})();
