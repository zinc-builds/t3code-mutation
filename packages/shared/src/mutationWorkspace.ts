/**
 * Mutation workspaces: an agent rebuilds a thread's interface around the task
 * at hand (a photo editor, a video timeline) with T3's `workspace_mutate` MCP
 * tool, and hands it back to chat with `workspace_restore`. The page is a
 * self-contained document stored as a thread attachment, like an HTML render,
 * with a bridge script injected so it can read the thread's media, keep its
 * control state, and host the chat composer.
 *
 * The bridge speaks JSON-RPC 2.0 over postMessage, like HTML renders and MCP
 * Apps, under its own `t3/workspace/*` methods.
 */

import { HOST_CONTEXT_CHANGED_METHOD } from "./htmlRender.ts";
import {
  readStoredWorkspaceChrome,
  WORKSPACE_CHROME_BRIDGE_METHODS,
  WORKSPACE_CHROME_BRIDGE_SCRIPT,
  type WorkspaceChrome,
} from "./mutationWorkspaceChrome.ts";

export const WORKSPACE_MUTATE_TOOL_NAME = "workspace_mutate";
export const WORKSPACE_RESTORE_TOOL_NAME = "workspace_restore";
export const WORKSPACE_STATE_TOOL_NAME = "workspace_state";
export const WORKSPACE_KIT_DOCS_TOOL_NAME = "workspace_kit_docs";

/** Key the `workspace_mutate` result carries its reference under. */
export const WORKSPACE_OUTPUT_KEY = "mutationWorkspace";

export const WORKSPACE_MAX_TITLE_LENGTH = 120;
export const WORKSPACE_MAX_ASSETS = 16;
// The RPC contract's state error names the limit, so the contract owns it.
export { WORKSPACE_MAX_STATE_BYTES } from "@t3tools/contracts";

/** A file the agent handed the workspace, served from the environment host. */
export interface WorkspaceAssetReference {
  /** Absolute path on the environment host. */
  readonly path: string;
  readonly name: string;
}

/** What a `workspace_mutate` result carries so clients can show the workspace. */
export interface WorkspaceReference {
  readonly attachmentId: string;
  readonly title: string;
  readonly assets: ReadonlyArray<WorkspaceAssetReference>;
  /** The native chrome the agent declared (mutationWorkspaceChrome.ts); absent for a bare page. */
  readonly chrome?: WorkspaceChrome;
}

function readAsset(value: unknown): WorkspaceAssetReference | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { path, name } = value as Record<string, unknown>;
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) return undefined;
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return undefined;
  return { path, name };
}

export function readWorkspaceReference(value: unknown): WorkspaceReference | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { attachmentId, title, assets, chrome } = value as Record<string, unknown>;
  if (
    typeof attachmentId !== "string" ||
    attachmentId.length === 0 ||
    attachmentId.length > 256 ||
    typeof title !== "string" ||
    !Array.isArray(assets) ||
    assets.length > WORKSPACE_MAX_ASSETS
  ) {
    return undefined;
  }
  const readAssets = assets.flatMap((asset) => {
    const read = readAsset(asset);
    return read === undefined ? [] : [read];
  });
  if (readAssets.length !== assets.length) return undefined;
  const readChrome = readStoredWorkspaceChrome(chrome);
  return {
    attachmentId,
    title: title.trim().slice(0, WORKSPACE_MAX_TITLE_LENGTH) || "Workspace",
    assets: readAssets,
    ...(readChrome === undefined ? {} : { chrome: readChrome }),
  };
}

export function workspaceReferencesEqual(left: WorkspaceReference, right: WorkspaceReference) {
  // Chrome, like the page, is fixed per attachment, so the attachment id covers it.
  return (
    left.attachmentId === right.attachmentId &&
    left.title === right.title &&
    left.assets.length === right.assets.length &&
    left.assets.every(
      (asset, index) =>
        asset.path === right.assets[index]?.path && asset.name === right.assets[index]?.name,
    )
  );
}

// Bridge methods. Requests carry an id and get a result or error back;
// notifications do not.
export const WORKSPACE_BRIDGE_METHODS = {
  /** Request from the page: initial state and the media it can work on. */
  initialize: "t3/workspace/initialize",
  /** Notification from the page: replace its stored control state. */
  setState: "t3/workspace/set-state",
  /** Request from the page: send a chat message as the user. */
  send: "t3/workspace/send",
  /** Request from the page: put files in the composer for the user to send. */
  attach: "t3/workspace/attach",
  /** Request from the page: save a file through the browser. */
  download: "t3/workspace/download",
  /** Notification from the page: the user wants the chat interface back. */
  restore: "t3/workspace/restore",
  /** Notification from the page: where the composer slot sits, or null for none. */
  composerSlot: "t3/workspace/composer-slot",
  /** Notification from the host: the composer's height, so the slot can fit it. */
  composerSize: "t3/workspace/composer-size",
  /** Notification from the host: whether the agent is working. */
  agentStatus: "t3/workspace/agent-status",
  /** Notification from the host: the page's last state was not stored, and why. */
  stateError: "t3/workspace/state-error",
  ...WORKSPACE_CHROME_BRIDGE_METHODS,
} as const;

export interface WorkspaceBridgeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A request from the page. Files arrive as `File`s where the host reads the
 * page's messages directly; a host that relays them across another boundary
 * (React Native) reads its own encoding of them.
 */
export type WorkspaceBridgeRequest<F = File> =
  | { readonly id: string | number; readonly method: typeof WORKSPACE_BRIDGE_METHODS.initialize }
  | {
      readonly id: string | number;
      readonly method: typeof WORKSPACE_BRIDGE_METHODS.send;
      readonly text: string;
      /** Sent in the same message; empty when the page sent text only. */
      readonly files: ReadonlyArray<F>;
    }
  | {
      readonly id: string | number;
      readonly method: typeof WORKSPACE_BRIDGE_METHODS.attach;
      readonly files: ReadonlyArray<F>;
    }
  | {
      readonly id: string | number;
      readonly method: typeof WORKSPACE_BRIDGE_METHODS.download;
      readonly file: F;
    };

export type WorkspaceBridgeNotification =
  | { readonly method: typeof WORKSPACE_BRIDGE_METHODS.setState; readonly state: unknown }
  | { readonly method: typeof WORKSPACE_BRIDGE_METHODS.restore }
  | {
      readonly method: typeof WORKSPACE_BRIDGE_METHODS.composerSlot;
      readonly rect: WorkspaceBridgeRect | null;
    };

function isFileLike(value: unknown): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

function readRect(value: unknown): WorkspaceBridgeRect | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  return [x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))
    ? { x: x as number, y: y as number, width: width as number, height: height as number }
    : undefined;
}

/**
 * A page's bridge message, or undefined when `data` is not one. Files are
 * `File`s unless `isFile` reads the host's own encoding of them.
 */
export function readWorkspaceBridgeMessage(
  data: unknown,
): WorkspaceBridgeRequest | WorkspaceBridgeNotification | undefined;
export function readWorkspaceBridgeMessage<F>(
  data: unknown,
  isFile: (value: unknown) => value is F,
): WorkspaceBridgeRequest<F> | WorkspaceBridgeNotification | undefined;
export function readWorkspaceBridgeMessage(
  data: unknown,
  isFile: (value: unknown) => boolean = isFileLike,
): WorkspaceBridgeRequest<unknown> | WorkspaceBridgeNotification | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, id, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || typeof method !== "string") return undefined;
  const p = (typeof params === "object" && params !== null ? params : {}) as Record<
    string,
    unknown
  >;
  const hasId = typeof id === "string" || typeof id === "number";
  switch (method) {
    case WORKSPACE_BRIDGE_METHODS.initialize:
      return hasId ? { id, method } : undefined;
    case WORKSPACE_BRIDGE_METHODS.send: {
      const files =
        p.files === undefined
          ? []
          : Array.isArray(p.files) && p.files.every(isFile)
            ? p.files
            : undefined;
      return hasId && typeof p.text === "string" && p.text.trim() !== "" && files !== undefined
        ? { id, method, text: p.text, files }
        : undefined;
    }
    case WORKSPACE_BRIDGE_METHODS.attach:
      return hasId && Array.isArray(p.files) && p.files.length > 0 && p.files.every(isFile)
        ? { id, method, files: p.files }
        : undefined;
    case WORKSPACE_BRIDGE_METHODS.download:
      return hasId && isFile(p.file) ? { id, method, file: p.file } : undefined;
    case WORKSPACE_BRIDGE_METHODS.setState:
      return { method, state: p.state };
    case WORKSPACE_BRIDGE_METHODS.restore:
      return { method };
    case WORKSPACE_BRIDGE_METHODS.composerSlot: {
      const rect = readRect(p.rect);
      return rect === undefined ? undefined : { method, rect };
    }
    default:
      return undefined;
  }
}

export function workspaceBridgeResult(id: string | number, result: unknown) {
  return { jsonrpc: "2.0", id, result } as const;
}

export function workspaceBridgeError(id: string | number, message: string) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } } as const;
}

export function workspaceBridgeNotification(method: string, params: unknown) {
  return { jsonrpc: "2.0", method, params } as const;
}

/**
 * The page-side bridge, `window.t3.workspace`. It runs in <head> before the
 * page's own scripts. The composer slot is any element marked
 * `data-t3-composer`; the bridge reports where it sits (again after any
 * layout change that can move it) and sizes it to the composer the host lays
 * over it. The bridge runs before the theme bootstrap, so its `theme` event
 * waits a task for the bootstrap to apply the new variables.
 */
const BRIDGE_SCRIPT = `(function(){
var M=${JSON.stringify(WORKSPACE_BRIDGE_METHODS)},n=0,pending={},listeners={},stateTimer=null,lastState;
function post(m){window.parent.postMessage(m,"*");}
function request(method,params){return new Promise(function(resolve,reject){var id="w"+(++n);pending[id]={resolve:resolve,reject:reject};post({jsonrpc:"2.0",id:id,method:method,params:params||{}});});}
function notify(method,params){post({jsonrpc:"2.0",method:method,params:params||{}});}
function emit(name,value){(listeners[name]||[]).slice().forEach(function(cb){try{cb(value);}catch(e){console.error(e);}});}
var composerHeight=0;
window.addEventListener("message",function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.jsonrpc!=="2.0")return;
if(d.id!=null&&pending[d.id]){var p=pending[d.id];delete pending[d.id];if(d.error)p.reject(new Error(d.error.message||"Request failed."));else p.resolve(d.result);return;}
if(d.method===M.composerSize&&d.params&&typeof d.params.height==="number"){composerHeight=d.params.height;sizeSlot();emit("composer-size",composerHeight);}
if(d.method===M.agentStatus&&d.params){emit("agent-status",d.params.status);}
if(d.method===M.stateError&&d.params){emit("state-error",new Error(String(d.params.message||"The workspace controls were not saved.")));}
if(d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&d.params&&d.params.styles){var t=d.params.theme==="light"?"light":"dark";setTimeout(function(){emit("theme",{appearance:t});});}
});
var initialized=null;
function init(){if(!initialized){initialized=request(M.initialize).then(function(r){var assets=(r&&r.assets||[]).map(function(a){return{name:a.name,mimeType:a.mimeType,source:a.source,path:a.path,attachmentId:a.attachmentId,file:a.file,url:URL.createObjectURL(a.file)};});return{state:r?r.state:undefined,assets:assets};},function(e){initialized=null;throw e;});}return initialized;}
var slot=null,lastRect="";
function report(){var r=slot&&slot.isConnected?slot.getBoundingClientRect():null;var rect=r&&r.width>0?{x:r.left,y:r.top,width:r.width,height:r.height}:null;var key=JSON.stringify(rect);if(key===lastRect)return;lastRect=key;notify(M.composerSlot,{rect:rect});}
function sizeSlot(){if(slot&&composerHeight>0)slot.style.minHeight=composerHeight+"px";}
var ro=window.ResizeObserver?new ResizeObserver(report):null;
function findSlot(){var s=document.querySelector("[data-t3-composer]");if(s===slot)return;if(slot&&ro)ro.unobserve(slot);slot=s;if(slot){sizeSlot();if(ro)ro.observe(slot);}report();}
document.addEventListener("DOMContentLoaded",function(){findSlot();if(window.MutationObserver)new MutationObserver(findSlot).observe(document.body,{childList:true,subtree:true});if(ro)ro.observe(document.documentElement);});
window.addEventListener("scroll",report,true);window.addEventListener("resize",report);
var settling=0;function settle(){if(!settling)settling=requestAnimationFrame(function(){settling=0;report();});}
document.addEventListener("DOMContentLoaded",function(){if(window.MutationObserver)new MutationObserver(settle).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:["class","style","hidden","open"]});});
document.addEventListener("transitionend",settle,true);document.addEventListener("animationend",settle,true);
function flushState(){if(stateTimer){clearTimeout(stateTimer);stateTimer=null;notify(M.setState,{state:lastState});}}
window.addEventListener("pagehide",flushState);
function toFiles(files){return(Array.isArray(files)?files:[files]).map(function(f){return f instanceof File?f:new File([f.blob||f],f.name||"export",{type:(f.blob||f).type});});}
window.t3=window.t3||{};
window.t3.workspace={
ready:function(){return init();},
assets:function(){return init().then(function(r){return r.assets;});},
initialState:function(){return init().then(function(r){return r.state;});},
setState:function(state){lastState=state;if(stateTimer)clearTimeout(stateTimer);stateTimer=setTimeout(function(){stateTimer=null;notify(M.setState,{state:lastState});},250);},
send:function(text,opts){return request(M.send,{text:String(text),files:opts&&opts.files!=null?toFiles(opts.files):undefined});},
attach:function(files){return request(M.attach,{files:toFiles(files)});},
download:function(blob,name){var f=blob instanceof File?blob:new File([blob],name||"export",{type:blob.type});return request(M.download,{file:f});},
restore:function(){flushState();notify(M.restore);},
on:function(name,cb){(listeners[name]=listeners[name]||[]).push(cb);return function(){listeners[name]=(listeners[name]||[]).filter(function(x){return x!==cb;});};}
};
})();
${WORKSPACE_CHROME_BRIDGE_SCRIPT}`;

/** Inserts the bridge at the start of the document head, before the page's own scripts. */
export function injectWorkspaceBridge(html: string): string {
  const markup = `<script>${BRIDGE_SCRIPT}</script>`;
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}

/** Agent-facing description of the page contract, used in the tool description. */
export const WORKSPACE_PAGE_GUIDE = [
  "The page becomes the whole app view: it fills the window edge to edge (100vh/100dvh layouts are right here), with no title banner, no window chrome, and no close button; T3 provides the way back.",
  "Design it like the professional application this task deserves (a Lightroom-style develop panel for photos, a multi-track timeline for video, a mixer for audio, a grid for data), dense and purposeful, built for this user's request and their media. Keys reach the page only while it has focus, so give every shortcut a visible button too, and ignore shortcuts while focus is in a text field.",
  "Make it look native to T3: style every surface, border, text, and control with the theme variables listed below (var(--background), var(--card), var(--border), var(--foreground), var(--muted-foreground), var(--primary), var(--ring), var(--radius), var(--font-sans)), never with hardcoded colors or fonts, so it matches the app around it in light and dark mode. --background is the thread's own canvas; give a media viewport a neutral surround derived from it, such as color-mix(in oklab, var(--background), #777 9%). Only the user's media and data keep their own colors.",
  "Place the chat where an assistant panel belongs by adding one empty element with the attribute data-t3-composer, at least 320px wide, at the bottom of a fixed-height column (for example an inspector sidebar), not inside a scrolling area, with nothing after it, padded like any panel. T3 lays its native composer over it bottom-aligned, sets its min-height to the composer's height, and follows it when it moves; on('composer-size', cb) reports that height. Without one, the composer docks along the bottom edge.",
  "The page runs in an opaque-origin sandbox that allows only scripts and forms: localStorage, sessionStorage, IndexedDB, and cookies throw or are absent (many libraries touch them on import, so load only libraries that tolerate this); alert, confirm, and prompt do nothing, so build confirmations into the page; window.open, <a download>, and the clipboard do not work; http(s) links open in the user's browser. Images from other origins taint a canvas unless served with CORS; blob: URLs from assets do not.",
  "Pass the page inline as html: never write it, or a scratch copy of it, into the user's project or anywhere else on disk.",
  "Bridge API on window.t3.workspace. Boot with const { state, assets } = await t3.workspace.ready(); it rejects with an Error when loading fails, and calling it again retries.",
  'assets: [{name, mimeType, source, path, attachmentId, file, url}]. source is "attachment" for each image the user attached in this thread (attachmentId identifies it; other attachment types are not included) and "file" for each path you passed as `assets` (path is that absolute path). Name media by path or attachmentId in anything the page sends back, so you can apply the edit to the original. mimeType may be generic, so check the extension too. url is a blob: URL for <img>, canvas, <video>, and <audio>.',
  "Keep <video> and <audio> elements you draw from in the document (visually hidden, not display:none) and seek them to force a frame, or the browser never decodes one; decode audio for waveforms with an OfflineAudioContext's decodeAudioData(await file.arrayBuffer()).",
  "state is what your page last stored in this thread (it survives rebuilds), or undefined. It may come from an older version of your page, so merge it over your defaults and ignore keys you no longer use.",
  "setState(object) replaces the stored state: compact JSON under 64KB, never media or datasets, with a version field and everything needed to look the same after a rebuild or reload (control values, selection, zoom, playhead, open panels). Call it whenever any of these change; it is debounced and flushed when the page leaves, and on('state-error', cb) gets an Error when storing fails (T3 already tells the user). You read it with workspace_state, and T3 adds it to each message the user sends while the workspace is open.",
  "send(text, { files }) posts a chat message as the user, with optional files attached to that same message (Files named like edit.json; a bare Blob is named export). T3 accepts it only during the user's click or key press, so call it directly in the handler, with any files prepared beforehand, before slow work. Keep the text short and human; put machine-readable payloads in files. attach(fileOrFiles) puts files in the composer for the user to send with their own words; download(blobOrFile, name) saves a file to the user's machine. Each returns a promise that resolves, or rejects with an Error that says why; T3 already shows failed downloads and loads to the user.",
  "restore() returns the thread to chat. on(event, cb) returns an unsubscribe function: 'agent-status' gets 'working' or 'idle'; 'theme' gets {appearance} after load and on every theme change, once the variables apply, so read them with getComputedStyle when you draw and redraw canvases then.",
  "Preview edits live in the page (canvas 2D, WebGL, Web Audio, <video>) so every control responds instantly, and offer an Export: when the browser can render the result at full quality, send or attach the file; otherwise send a machine-readable description of the edit (develop settings JSON, an edit decision list, a recipe) that names media by path, and apply it to the originals with your own tools when it arrives.",
].join(" ");
