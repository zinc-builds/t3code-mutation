import {
  readWorkspaceBridgeMessage,
  WORKSPACE_BRIDGE_METHODS,
  WORKSPACE_FRAME_SANDBOX,
  type WorkspaceBridgeNotification,
  type WorkspaceBridgeRequest,
} from "@t3tools/shared/mutationWorkspace";
import { readWorkspaceChromeBridgeMessage } from "@t3tools/shared/mutationWorkspaceChrome";
import { readHtmlRenderLinkRequest } from "@t3tools/shared/htmlRender";
import * as Predicate from "effect/Predicate";

/**
 * The React Native side of a mutation workspace's bridge.
 *
 * The WebView loads a small outer page that hosts the workspace page in a real
 * opaque-origin iframe, as web does, so the page's bridge (`window.parent`
 * postMessage, File objects) works unchanged. The outer page only relays:
 *
 * - page → React Native: each message, with any File in it encoded as base64
 *   (React Native messages are strings), in the order the page sent them, and
 *   whether the user had just touched the page when it arrived.
 * - React Native → page: `__t3WorkspaceReceive(message)`, and
 *   `__t3WorkspaceInitialize(id, state, assets)`, which fetches each asset's
 *   signed URL into a File before answering the page's `initialize`, except
 *   video and audio, which the page plays from their URL and gets as the URL
 *   and size.
 *
 * The outer page is loaded with the environment's origin as its base URL, so
 * those asset fetches are same-origin and need no CORS. The page's own media
 * loads are cross-origin from its opaque origin, which the asset route allows. Every frame can reach
 * `ReactNativeWebView`, so the outer page wraps what it relays with a secret
 * only it holds, and React Native drops anything else. Once the page frame
 * loads a second time (it navigated itself), the outer page stops relaying.
 */

/** Largest file a page may hand React Native in one message (send, attach, download). */
export const WORKSPACE_WEBVIEW_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** A File the page sent, as the outer page encoded it. */
interface WireFile {
  readonly t3File: true;
  readonly name: string;
  readonly type: string;
  readonly base64: string;
}

const isWireFile = (value: unknown): value is WireFile =>
  Predicate.isObject(value) &&
  value.t3File === true &&
  typeof value.name === "string" &&
  typeof value.type === "string" &&
  typeof value.base64 === "string";

/** A File the page sent, read for React Native. */
export interface WorkspaceEncodedFile {
  readonly name: string;
  readonly mimeType: string;
  readonly base64: string;
}

const readWireFile = (file: WireFile): WorkspaceEncodedFile => ({
  name: file.name.trim().slice(0, 255) || "export",
  mimeType: file.type,
  base64: file.base64,
});

/** An asset React Native hands the outer page for the page's `initialize`. */
export type WorkspaceWebViewAsset = {
  readonly name: string;
  readonly mimeType: string;
  /** A signed asset URL on the environment's origin. */
  readonly url: string;
} & (
  | { readonly source: "attachment"; readonly attachmentId: string }
  | { readonly source: "file"; readonly path: string }
) &
  (
    | { readonly stream: false }
    /** Handed to the page as `url` and `size`, never fetched (`workspaceAssetStreams`). */
    | { readonly stream: true; readonly size: number }
  );

export type WorkspaceWebViewMessage =
  | {
      readonly kind: "bridge";
      readonly message: WorkspaceBridgeRequest<WorkspaceEncodedFile> | WorkspaceBridgeNotification;
      /** Whether the user had just clicked or pressed a key in the page. */
      readonly active: boolean;
    }
  | { readonly kind: "set-chrome"; readonly id: string | number }
  | {
      readonly kind: "open-link";
      readonly id: string | number;
      readonly url: string;
      readonly active: boolean;
    }
  /** The page frame loaded a second document; the bridge stopped. */
  | { readonly kind: "navigated" }
  /** The outer page could not fetch the page's assets for `initialize`. */
  | { readonly kind: "assets-failed"; readonly message: string };

/**
 * A relayed message from the outer page holding `secret`, or undefined for
 * anything else: another frame posting to React Native, or a message no host
 * handles.
 */
export function readWorkspaceWebViewMessage(
  raw: string,
  secret: string,
): WorkspaceWebViewMessage | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return undefined; // Not JSON, so not the outer page.
  }
  if (!Predicate.isObject(envelope) || envelope.secret !== secret) return undefined;
  const { message } = envelope;
  const active = envelope.active === true;
  if (Predicate.isObject(message) && message.t3 === "navigated") return { kind: "navigated" };
  if (Predicate.isObject(message) && message.t3 === "assets-failed") {
    return {
      kind: "assets-failed",
      message:
        typeof message.message === "string" && message.message.trim() !== ""
          ? message.message
          : "The workspace's files could not be loaded.",
    };
  }
  const bridge = readWorkspaceBridgeMessage(message, isWireFile);
  if (bridge !== undefined) return { kind: "bridge", message: readFiles(bridge), active };
  const chrome = readWorkspaceChromeBridgeMessage(message);
  if (chrome !== undefined && "id" in chrome) return { kind: "set-chrome", id: chrome.id };
  const link = readHtmlRenderLinkRequest(message);
  if (link !== undefined) return { kind: "open-link", id: link.id, url: link.url, active };
  return undefined;
}

function readFiles(
  message: WorkspaceBridgeRequest<WireFile> | WorkspaceBridgeNotification,
): WorkspaceBridgeRequest<WorkspaceEncodedFile> | WorkspaceBridgeNotification {
  switch (message.method) {
    case WORKSPACE_BRIDGE_METHODS.send:
    case WORKSPACE_BRIDGE_METHODS.attach:
      return { ...message, files: message.files.map(readWireFile) };
    case WORKSPACE_BRIDGE_METHODS.download:
      return { ...message, file: readWireFile(message.file) };
    default:
      return message;
  }
}

const jsonForScript = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/** Script that delivers a host message to the page. */
export function workspaceReceiveScript(message: unknown): string {
  return `window.__t3WorkspaceReceive&&window.__t3WorkspaceReceive(${jsonForScript(message)});true;`;
}

/** Script that answers the page's `initialize`, once the outer page has fetched the assets. */
export function workspaceInitializeScript(
  id: string | number,
  state: unknown,
  assets: ReadonlyArray<WorkspaceWebViewAsset>,
): string {
  return `window.__t3WorkspaceInitialize&&window.__t3WorkspaceInitialize(${jsonForScript(id)},${jsonForScript(state ?? null)},${jsonForScript(assets)});true;`;
}

/** The outer page: the workspace page at `src` in a sandboxed frame, and the relay. */
export function workspaceOuterDocument(src: string, secret: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{border:0;display:block;width:100%;height:100%}</style></head>
<body><iframe id="page" sandbox="${WORKSPACE_FRAME_SANDBOX}"></iframe>
<script>(function(){
var frame=document.getElementById("page"),secret=${jsonForScript(secret)},MAX=${WORKSPACE_WEBVIEW_MAX_FILE_BYTES},loads=0,live=true,queue=Promise.resolve();
function relay(m,active){window.ReactNativeWebView.postMessage(JSON.stringify({secret:secret,active:active,message:m}));}
function toPage(m){if(live&&frame.contentWindow)frame.contentWindow.postMessage(m,"*");}
function fail(id,message){if(id!=null)toPage({jsonrpc:"2.0",id:id,error:{code:-32000,message:message}});}
function encode(v){
if(typeof Blob!=="undefined"&&v instanceof Blob){
if(v.size>MAX)return Promise.reject(new Error((v.name||"The file")+" is too large to hand to T3 on this device."));
return new Promise(function(resolve,reject){var r=new FileReader();r.onload=function(){var s=String(r.result);resolve({t3File:true,name:v.name||"export",type:v.type||"",base64:s.slice(s.indexOf(",")+1)});};r.onerror=function(){reject(r.error||new Error("The file could not be read."));};r.readAsDataURL(v);});}
if(Array.isArray(v))return Promise.all(v.map(encode));
if(v&&typeof v==="object"){var k=Object.keys(v);return Promise.all(k.map(function(x){return encode(v[x]);})).then(function(r){var o={};k.forEach(function(x,i){o[x]=r[i];});return o;});}
return Promise.resolve(v);}
frame.addEventListener("load",function(){loads+=1;if(loads>1&&live){live=false;relay({t3:"navigated"},false);}});
window.addEventListener("message",function(e){
if(!live||e.source!==frame.contentWindow)return;var d=e.data;
var active=!navigator.userActivation||navigator.userActivation.isActive;
queue=queue.then(function(){return encode(d).then(function(m){if(live)relay(m,active);},function(err){fail(d&&d.id,err&&err.message||"The file could not be read.");});});});
window.__t3WorkspaceReceive=function(m){toPage(m);};
window.__t3WorkspaceInitialize=function(id,state,assets){
Promise.all(assets.map(function(a){var who={name:a.name,mimeType:a.mimeType,source:a.source,attachmentId:a.attachmentId,path:a.path};
if(a.stream){who.url=a.url;who.size=a.size;return who;}
return fetch(a.url).then(function(r){if(!r.ok)throw new Error(a.name+" could not be loaded (HTTP "+r.status+").");return r.blob();}).then(function(b){who.file=new File([b],a.name,{type:a.mimeType});return who;});}))
.then(function(files){toPage({jsonrpc:"2.0",id:id,result:{state:state===null?undefined:state,assets:files}});},
function(err){var message=err&&err.message||"The workspace's files could not be loaded.";fail(id,message);relay({t3:"assets-failed",message:message},false);});};
frame.src=${jsonForScript(src)};
})();</script></body></html>`;
}
