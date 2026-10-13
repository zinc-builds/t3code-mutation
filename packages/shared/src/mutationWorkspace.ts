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

export const WORKSPACE_MUTATE_TOOL_NAME = "workspace_mutate";
export const WORKSPACE_RESTORE_TOOL_NAME = "workspace_restore";
export const WORKSPACE_STATE_TOOL_NAME = "workspace_state";

/** Key the `workspace_mutate` result carries its reference under. */
export const WORKSPACE_OUTPUT_KEY = "mutationWorkspace";

export const WORKSPACE_MAX_TITLE_LENGTH = 120;
export const WORKSPACE_MAX_ASSETS = 16;
/** Largest state a workspace may store, as UTF-8 JSON. */
export const WORKSPACE_MAX_STATE_BYTES = 64 * 1024;

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
  const { attachmentId, title, assets } = value as Record<string, unknown>;
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
  return {
    attachmentId,
    title: title.trim().slice(0, WORKSPACE_MAX_TITLE_LENGTH) || "Workspace",
    assets: readAssets,
  };
}

export function workspaceReferencesEqual(left: WorkspaceReference, right: WorkspaceReference) {
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
} as const;

export interface WorkspaceBridgeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type WorkspaceBridgeRequest =
  | { readonly id: string | number; readonly method: typeof WORKSPACE_BRIDGE_METHODS.initialize }
  | {
      readonly id: string | number;
      readonly method: typeof WORKSPACE_BRIDGE_METHODS.send;
      readonly text: string;
    }
  | {
      readonly id: string | number;
      readonly method: typeof WORKSPACE_BRIDGE_METHODS.attach;
      readonly files: ReadonlyArray<File>;
    }
  | {
      readonly id: string | number;
      readonly method: typeof WORKSPACE_BRIDGE_METHODS.download;
      readonly file: File;
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

/** A page's bridge message, or undefined when `data` is not one. */
export function readWorkspaceBridgeMessage(
  data: unknown,
): WorkspaceBridgeRequest | WorkspaceBridgeNotification | undefined {
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
    case WORKSPACE_BRIDGE_METHODS.send:
      return hasId && typeof p.text === "string" && p.text.trim() !== ""
        ? { id, method, text: p.text }
        : undefined;
    case WORKSPACE_BRIDGE_METHODS.attach:
      return hasId && Array.isArray(p.files) && p.files.length > 0 && p.files.every(isFileLike)
        ? { id, method, files: p.files }
        : undefined;
    case WORKSPACE_BRIDGE_METHODS.download:
      return hasId && isFileLike(p.file) ? { id, method, file: p.file } : undefined;
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
 * `data-t3-composer`; the bridge reports where it sits and sizes it to the
 * composer the host lays over it.
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
});
var initialized=null;
function init(){if(!initialized){initialized=request(M.initialize).then(function(r){var assets=(r&&r.assets||[]).map(function(a){return{name:a.name,mimeType:a.mimeType,source:a.source,file:a.file,url:URL.createObjectURL(a.file)};});return{state:r?r.state:undefined,assets:assets};});}return initialized;}
var slot=null,lastRect="";
function report(){var r=slot&&slot.isConnected?slot.getBoundingClientRect():null;var rect=r&&r.width>0?{x:r.left,y:r.top,width:r.width,height:r.height}:null;var key=JSON.stringify(rect);if(key===lastRect)return;lastRect=key;notify(M.composerSlot,{rect:rect});}
function sizeSlot(){if(slot&&composerHeight>0)slot.style.minHeight=composerHeight+"px";}
var ro=window.ResizeObserver?new ResizeObserver(report):null;
function findSlot(){var s=document.querySelector("[data-t3-composer]");if(s===slot)return;if(slot&&ro)ro.unobserve(slot);slot=s;if(slot){sizeSlot();if(ro)ro.observe(slot);}report();}
document.addEventListener("DOMContentLoaded",function(){findSlot();if(window.MutationObserver)new MutationObserver(findSlot).observe(document.body,{childList:true,subtree:true});if(ro)ro.observe(document.documentElement);});
window.addEventListener("scroll",report,true);window.addEventListener("resize",report);
window.t3=window.t3||{};
window.t3.workspace={
ready:function(){return init();},
assets:function(){return init().then(function(r){return r.assets;});},
initialState:function(){return init().then(function(r){return r.state;});},
setState:function(state){lastState=state;if(stateTimer)clearTimeout(stateTimer);stateTimer=setTimeout(function(){stateTimer=null;notify(M.setState,{state:lastState});},250);},
send:function(text){return request(M.send,{text:String(text)});},
attach:function(files){var list=(Array.isArray(files)?files:[files]).map(function(f){return f instanceof File?f:new File([f.blob||f],f.name||"export",{type:(f.blob||f).type});});return request(M.attach,{files:list});},
download:function(blob,name){var f=blob instanceof File?blob:new File([blob],name||"export",{type:blob.type});return request(M.download,{file:f});},
restore:function(){notify(M.restore);},
on:function(name,cb){(listeners[name]=listeners[name]||[]).push(cb);return function(){listeners[name]=(listeners[name]||[]).filter(function(x){return x!==cb;});};}
};
})();`;

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
  "Design it like the professional application this task deserves (a Lightroom-style develop panel for photos, a multi-track timeline for video, a mixer for audio, a grid for data), dense and purposeful, built for this user's request and their media.",
  "Place the chat where an assistant panel belongs in that layout by adding one empty element with the attribute data-t3-composer (at least 320px wide, e.g. the bottom of an inspector sidebar); T3 lays its native chat composer over that element and sizes its height. Without one, the composer docks along the bottom edge.",
  "The page runs in an opaque-origin sandbox: no cookies, storage, or same-origin requests; use the bridge for everything about the thread.",
  "Bridge API on window.t3.workspace:",
  "assets() resolves to [{name, mimeType, source, file, url}] with the images the user attached in this thread plus the files you passed as `assets`; url is a blob: URL you can draw to a canvas or play in <video>.",
  "initialState() resolves to the state the user's controls had before this page loaded (kept across rebuilds of the workspace in the same thread), or undefined.",
  "setState(object) stores the current control values (JSON, under 64KB); call it whenever a control changes so you can read them with workspace_state.",
  "send(text) sends a chat message as the user; attach(fileOrFiles) puts exported files in the composer for the user to send to you; download(blobOrFile, name) saves a file to the user's machine; restore() returns the thread to chat; on('agent-status', cb) reports 'working' or 'idle'.",
  "Preview edits live in the page (canvas 2D, WebGL, Web Audio, <video> with CSS filters) so every control responds instantly; offer an Export action that uses attach() or download(). Heavy operations the browser cannot do well are yours to run with your own tools when the user asks.",
].join(" ");
