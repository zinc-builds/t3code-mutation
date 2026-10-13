/**
 * Publish-time validation of a workspace page: T3 boots the finished page in
 * its preview browser, with a stand-in for the client that hosts the
 * workspace bridge, and hands what went wrong back to the agent in the
 * `workspace_mutate` result. This module holds the pure parts: the host
 * stand-in, and how an observation becomes the agent-facing result.
 */
import {
  WORKSPACE_BRIDGE_METHODS,
  WORKSPACE_MUTATE_TOOL_NAME,
} from "@t3tools/shared/mutationWorkspace";
import { TEMPLATE_CUSTOM_SCRIPT_ERROR_MARKER } from "@t3tools/workspace-kit";
import * as Option from "effect/Option";

import type { PageObservation } from "../htmlRender/HtmlRender.ts";

export interface WorkspaceValidationError {
  /** A template's `customScript` bolt-on, an uncaught exception, or a console error. */
  readonly source: "customScript" | "exception" | "console";
  readonly message: string;
}

/** What the agent learns about its page from publishing it. */
export interface WorkspaceValidation {
  /** No errors were seen. With `skipped`, the page was not checked at all. */
  readonly ok: boolean;
  readonly errors: ReadonlyArray<WorkspaceValidationError>;
  /** Errors past the ones listed. */
  readonly moreErrors?: number;
  /** Why the page was not checked. */
  readonly skipped?: string;
  /** Asset paths too large to load in validation; the page booted without them. */
  readonly omittedAssets?: ReadonlyArray<string>;
}

/** An asset the stand-in hands the page, fetched from the validation page's own origin. */
export interface ValidationAsset {
  readonly name: string;
  readonly mimeType: string;
  readonly path: string;
  readonly url: string;
}

export const validationAssetUrl = (index: number) => `/t3-validation/asset/${index}`;

/** How long after load, or after `initialize` is answered, a quiet page counts as booted. */
const QUIET_MS = 1_000;
const MAX_LISTED_ERRORS = 10;

/** Resolves once the page has booted; see `validationHostScript`. */
export const VALIDATION_SETTLED_EXPRESSION =
  "(window.__t3WorkspaceValidation || { settled: true }).settled";

/** Console messages carrying this prefix count as errors at any level. */
export const VALIDATION_PROBLEM_PREFIXES = [TEMPLATE_CUSTOM_SCRIPT_ERROR_MARKER];

/**
 * The client's side of the workspace bridge, for a page loaded on its own.
 * There the bridge's `window.parent` is the page itself, so this script, run
 * first, takes over `postMessage` and answers the bridge the way the client
 * would: `initialize` with the assets (or a placeholder photo when there are
 * none, standing in for the thread's attached images) and the chrome's
 * control values; every other request succeeds; notifications are dropped.
 */
export function validationHostScript(input: {
  readonly assets: ReadonlyArray<ValidationAsset>;
  readonly controls: Readonly<Record<string, unknown>>;
}): string {
  const config = JSON.stringify({
    assets: input.assets,
    controls: input.controls,
    initialize: WORKSPACE_BRIDGE_METHODS.initialize,
    controlsMethod: WORKSPACE_BRIDGE_METHODS.controls,
    composerSize: WORKSPACE_BRIDGE_METHODS.composerSize,
    agentStatus: WORKSPACE_BRIDGE_METHODS.agentStatus,
    quietMs: QUIET_MS,
  }).replace(/</g, "\\u003c");
  return `(function(){
var C=${config},post=window.postMessage.bind(window),timer,settle;
var settled=new Promise(function(r){settle=r;});
function arm(){clearTimeout(timer);timer=setTimeout(settle,C.quietMs);}
window.addEventListener("load",arm);
window.__t3WorkspaceValidation={settled:settled};
function placeholder(){var c=document.createElement("canvas");c.width=1600;c.height=1067;var g=c.getContext("2d"),l=g.createLinearGradient(0,0,1600,1067);l.addColorStop(0,"#3b5b7a");l.addColorStop(0.5,"#c9a26b");l.addColorStop(1,"#2d2a26");g.fillStyle=l;g.fillRect(0,0,1600,1067);
return new Promise(function(r){c.toBlob(r,"image/png");}).then(function(b){return{name:"placeholder.png",mimeType:"image/png",source:"attachment",attachmentId:"validation-placeholder",file:new File([b],"placeholder.png",{type:"image/png"})};});}
function assets(){if(C.assets.length===0)return placeholder().then(function(a){return[a];});
return Promise.all(C.assets.map(function(a){return fetch(a.url).then(function(r){if(!r.ok)throw new Error(a.name+" could not be loaded.");return r.blob();}).then(function(b){return{name:a.name,mimeType:a.mimeType,source:"file",path:a.path,file:new File([b],a.name,{type:a.mimeType})};});}));}
window.postMessage=function(m,o,t){
if(!m||m.jsonrpc!=="2.0"||typeof m.method!=="string"||m.method.indexOf("t3/workspace/")!==0)return post(m,o,t);
if(m.id==null)return;
var init=m.method===C.initialize;
(init?assets().then(function(a){return{state:undefined,assets:a};}):Promise.resolve({})).then(function(result){
post({jsonrpc:"2.0",id:m.id,result:result},"*");
if(init){post({jsonrpc:"2.0",method:C.controlsMethod,params:{values:C.controls}},"*");post({jsonrpc:"2.0",method:C.composerSize,params:{height:0}},"*");post({jsonrpc:"2.0",method:C.agentStatus,params:{status:"idle"}},"*");arm();}
},function(e){post({jsonrpc:"2.0",id:m.id,error:{code:-32000,message:String(e&&e.message||e)}},"*");arm();});
};
})();`;
}

/** Inserts the host stand-in at the start of the head, ahead of the bridge T3 injected there. */
export function injectValidationHost(html: string, script: string): string {
  const markup = `<script>${script.replace(/<\/script/gi, "<\\/script")}</script>`;
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}

const toError = (problem: PageObservation["problems"][number]): WorkspaceValidationError => {
  const at = problem.text.indexOf(TEMPLATE_CUSTOM_SCRIPT_ERROR_MARKER);
  if (at !== -1) {
    return {
      source: "customScript",
      message:
        problem.text.slice(at + TEMPLATE_CUSTOM_SCRIPT_ERROR_MARKER.length).trim() ||
        "customScript failed.",
    };
  }
  return { source: problem.source, message: problem.text };
};

/**
 * The agent-facing result of one observation: each distinct error once, in
 * the order the page reported them, the first few listed. `None` means the
 * preview browser is not installed.
 */
export function shapeValidation(
  observation: Option.Option<PageObservation>,
  omittedAssets: ReadonlyArray<string> = [],
): WorkspaceValidation {
  const assetNote = omittedAssets.length === 0 ? {} : { omittedAssets };
  if (Option.isNone(observation)) {
    return {
      ok: true,
      errors: [],
      skipped: "T3's preview browser is not installed on this machine.",
      ...assetNote,
    };
  }
  const seen = new Set<string>();
  const errors: Array<WorkspaceValidationError> = [];
  for (const problem of observation.value.problems) {
    const error = toError(problem);
    const key = `${error.source}\0${error.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push(error);
  }
  const moreErrors = Math.max(0, errors.length - MAX_LISTED_ERRORS) + observation.value.omitted;
  return {
    ok: errors.length === 0 && observation.value.omitted === 0,
    errors: errors.slice(0, MAX_LISTED_ERRORS),
    ...(moreErrors === 0 ? {} : { moreErrors }),
    ...assetNote,
  };
}

/** A validation that could not run, and why. */
export const skippedValidation = (reason: string): WorkspaceValidation => ({
  ok: true,
  errors: [],
  skipped: reason,
});

/** What the `workspace_mutate` result tells the agent to do next. */
export function workspaceMutateAdvice(validation: WorkspaceValidation): string {
  const shown =
    "The thread now shows this workspace in place of chat, with the composer inside it.";
  if (!validation.ok) {
    return `${shown} It reported errors while it loaded (see validation.errors): fix them with another ${WORKSPACE_MUTATE_TOOL_NAME} call before replying, without asking the user.`;
  }
  const reply = "Reply in a sentence or two; the user is already looking at it.";
  return validation.skipped === undefined
    ? `${shown} It loaded without errors. ${reply}`
    : `${shown} It was not checked for errors (${validation.skipped}). ${reply}`;
}
