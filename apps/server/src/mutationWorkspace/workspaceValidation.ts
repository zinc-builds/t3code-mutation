/**
 * Publish-time validation of a workspace page: T3 boots the finished page in
 * its preview browser, with a stand-in for the client that hosts the
 * workspace bridge, optionally runs its export, and hands what went wrong
 * back to the agent in the `workspace_mutate` result. This module holds the
 * pure parts: the host stand-in, the in-page report, and how an observation
 * becomes the agent-facing result.
 */
import {
  WORKSPACE_BRIDGE_METHODS,
  WORKSPACE_MUTATE_TOOL_NAME,
} from "@t3tools/shared/mutationWorkspace";
import {
  applyWorkspaceChromePatch,
  resolveWorkspaceChromeValues,
  WORKSPACE_CHROME_MISSING_ERROR,
  type WorkspaceChrome,
} from "@t3tools/shared/mutationWorkspaceChrome";
import { TEMPLATE_CUSTOM_SCRIPT_ERROR_MARKER } from "@t3tools/workspace-kit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PageObservation } from "../htmlRender/HtmlRender.ts";
import type { FfmpegCommandCheck } from "./FfmpegDryRun.ts";

/**
 * How far validation goes. `boot` loads the page and reports what broke;
 * `full` then runs `window.t3template.export()` and dry-runs the ffmpeg
 * commands it returns.
 */
export type WorkspaceValidationLevel = "boot" | "full";

export const WORKSPACE_VALIDATION_LEVELS = ["boot", "full"] as const;

export interface WorkspaceValidationError {
  /**
   * A template's `customScript` bolt-on, an uncaught exception, a console
   * error, the export (its rejection, an unreadable file, or anything the
   * page reported while it ran), an ffmpeg command's dry run, or a
   * `setChrome` patch T3 would reject.
   */
  readonly source: "customScript" | "exception" | "console" | "export" | "ffmpeg" | "chrome";
  readonly message: string;
}

/** A file the export produced. */
export interface WorkspaceExportFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  /** Pixel size, for an image. */
  readonly width?: number;
  readonly height?: number;
}

/** What running the page's export found; errors it raised are in `errors`. */
export interface WorkspaceExportCheck {
  /** Why export() was not run or did not finish. */
  readonly skipped?: string;
  /** Files it returned, attached, or downloaded. */
  readonly files: ReadonlyArray<WorkspaceExportFile>;
  /** Each returned ffmpeg command's dry run, in order; a failure's stderr is in `errors`. */
  readonly ffmpeg?: ReadonlyArray<
    | { readonly command: number; readonly status: "ok" | "failed" }
    | { readonly command: number; readonly status: "not-run"; readonly reason: string }
  >;
  /** Why the ffmpeg commands were not dry-run. */
  readonly ffmpegSkipped?: string;
}

/** What the agent learns about its page from publishing it. */
export interface WorkspaceValidation {
  readonly level: WorkspaceValidationLevel;
  /** No errors were seen. With `skipped`, the page was not checked at all. */
  readonly ok: boolean;
  readonly errors: ReadonlyArray<WorkspaceValidationError>;
  /** Errors past the ones listed. */
  readonly moreErrors?: number;
  /** Why the page was not checked. */
  readonly skipped?: string;
  /** Asset paths too large to load in validation; the page booted without them. */
  readonly omittedAssets?: ReadonlyArray<string>;
  /** With level `full`, once the page booted. */
  readonly export?: WorkspaceExportCheck;
}

/**
 * The level when the agent names none: a template with a `customScript`
 * bolt-on gets `full`, since a bolt-on is what most often breaks an export
 * that loads cleanly; everything else gets `boot`.
 */
export function defaultValidationLevel(
  template: { readonly options: Readonly<Record<string, unknown>> } | undefined,
): WorkspaceValidationLevel {
  const script = template?.options.customScript;
  return typeof script === "string" && script.trim() !== "" ? "full" : "boot";
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
/** Export files a returned ffmpeg command names are handed back for its dry run, up to this many bytes. */
const MAX_EXPORT_INPUT_BYTES = 8 * 1024 * 1024;

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
 * control values; `setChrome` fails without chrome, as in the client, and is
 * otherwise recorded for T3 to check; files the page attaches or downloads
 * are kept for the export report (an export may return those Files, or
 * describe them as `{ name, type, size }`, which must match one the page
 * delivered); every other request succeeds;
 * notifications are dropped.
 * A template page counts as booted only once it has published
 * `window.t3template` and been quiet since: templates run `customScript` right
 * after that, which on a photo can come well over a second after `initialize`.
 * `report` (see `validationReportExpression`) then hands back what the page
 * did, after running its export when asked.
 */
export function validationHostScript(input: {
  readonly assets: ReadonlyArray<ValidationAsset>;
  readonly controls: Readonly<Record<string, unknown>>;
  readonly template: boolean;
  readonly chrome: boolean;
}): string {
  const config = JSON.stringify({
    assets: input.assets,
    controls: input.controls,
    initialize: WORKSPACE_BRIDGE_METHODS.initialize,
    controlsMethod: WORKSPACE_BRIDGE_METHODS.controls,
    composerSize: WORKSPACE_BRIDGE_METHODS.composerSize,
    agentStatus: WORKSPACE_BRIDGE_METHODS.agentStatus,
    setChrome: WORKSPACE_BRIDGE_METHODS.setChrome,
    attach: WORKSPACE_BRIDGE_METHODS.attach,
    download: WORKSPACE_BRIDGE_METHODS.download,
    quietMs: QUIET_MS,
    template: input.template,
    chrome: input.chrome,
    chromeMissing: WORKSPACE_CHROME_MISSING_ERROR,
    maxInputBytes: MAX_EXPORT_INPUT_BYTES,
  }).replace(/</g, "\\u003c");
  return `(function(){
var C=${config},post=window.postMessage.bind(window),timer,settle,published=false;
var settled=new Promise(function(r){settle=r;});
function quiet(){if(!C.template||published||window.t3template)return settle();timer=setTimeout(wait,50);}
function wait(){if(!window.t3template){timer=setTimeout(wait,50);return;}published=true;arm();}
function arm(){clearTimeout(timer);timer=setTimeout(quiet,C.quietMs);}
window.addEventListener("load",arm);
var V=window.__t3WorkspaceValidation={settled:settled,chromePatches:[],files:[]};
function message(e){return String(e&&e.message||e);}
function b64(buffer){var b=new Uint8Array(buffer),s="";for(var i=0;i<b.length;i+=32768)s+=String.fromCharCode.apply(null,b.subarray(i,i+32768));return btoa(s);}
function describe(f,cmds,budget){var d={name:f.name||"export",type:f.type,size:f.size},steps=[];
if(/^image\\//.test(f.type)&&f.type!=="image/svg+xml")steps.push(createImageBitmap(f).then(function(b){d.width=b.width;d.height=b.height;b.close();},function(e){d.decodeError=message(e);}));
if(budget.left>=f.size&&cmds.some(function(c){return c.indexOf(d.name)!==-1;})){budget.left-=f.size;steps.push(f.arrayBuffer().then(function(a){d.base64=b64(a);}));}
return Promise.all(steps).then(function(){return d;});}
V.report=function(o){var out={chromePatches:V.chromePatches};
if(!o.export)return Promise.resolve(out);
var t=window.t3template;if(!t||typeof t.export!=="function"){out.export={available:false};return Promise.resolve(out);}
V.files=[];
return new Promise(function(r){r(t.export());}).then(function(v){return{ok:true,value:v};},function(e){return{ok:false,error:message(e)};}).then(function(x){
var v=x.ok&&x.value&&typeof x.value==="object"?x.value:null,files=[],keys={},problems=[],cmds=[];
function add(f){var k=(f.name||"")+"\\0"+f.size+"\\0"+f.type;if(!keys[k]){keys[k]=1;files.push(f);}}
var described=[];
if(v&&v.files!==undefined){if(Array.isArray(v.files))v.files.forEach(function(f,i){if(f instanceof Blob)add(f);else if(f&&typeof f==="object"&&typeof f.name==="string")described.push({at:i,file:f});else problems.push("export() returned files["+i+"], which is neither a File nor a {name, type, size} description.");});else problems.push("export() returned files that is not an array.");}
V.files.forEach(add);
described.forEach(function(d){var f=d.file;if(!files.some(function(g){return g.name===f.name&&(typeof f.size!=="number"||g.size===f.size);}))problems.push("export() described files["+d.at+"] ("+f.name+"), which the page never attached or downloaded.");});
var ff=v?v.ffmpeg:undefined;
if(typeof ff==="string")cmds=[ff];else if(Array.isArray(ff)&&ff.every(function(c){return typeof c==="string";}))cmds=ff;else if(ff!=null)problems.push("export() returned ffmpeg that is not a string or an array of strings.");
var budget={left:C.maxInputBytes};
return Promise.all(files.map(function(f){return describe(f,cmds,budget);})).then(function(d){out.export={available:true,ok:x.ok,error:x.error,files:d,ffmpeg:cmds,problems:problems};return out;});});};
function placeholder(){var c=document.createElement("canvas");c.width=1600;c.height=1067;var g=c.getContext("2d"),l=g.createLinearGradient(0,0,1600,1067);l.addColorStop(0,"#3b5b7a");l.addColorStop(0.5,"#c9a26b");l.addColorStop(1,"#2d2a26");g.fillStyle=l;g.fillRect(0,0,1600,1067);
return new Promise(function(r){c.toBlob(r,"image/png");}).then(function(b){return{name:"placeholder.png",mimeType:"image/png",source:"attachment",attachmentId:"validation-placeholder",file:new File([b],"placeholder.png",{type:"image/png"})};});}
function assets(){if(C.assets.length===0)return placeholder().then(function(a){return[a];});
return Promise.all(C.assets.map(function(a){return fetch(a.url).then(function(r){if(!r.ok)throw new Error(a.name+" could not be loaded.");return r.blob();}).then(function(b){return{name:a.name,mimeType:a.mimeType,source:"file",path:a.path,file:new File([b],a.name,{type:a.mimeType})};});}));}
window.postMessage=function(m,o,t){
if(!m||m.jsonrpc!=="2.0"||typeof m.method!=="string"||m.method.indexOf("t3/workspace/")!==0)return post(m,o,t);
if(m.id==null)return;
var p=m.params||{};
if(m.method===C.setChrome){if(!C.chrome)return post({jsonrpc:"2.0",id:m.id,error:{code:-32000,message:C.chromeMissing}},"*");
try{V.chromePatches.push({patch:JSON.parse(JSON.stringify(p.patch===undefined?null:p.patch))});}catch(e){V.chromePatches.push({error:"setChrome was passed a patch that is not JSON: "+message(e)});}}
if(m.method===C.attach&&Array.isArray(p.files))p.files.forEach(function(f){V.files.push(f);});
if(m.method===C.download&&p.file)V.files.push(p.file);
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

/** Asks the stand-in what the page did; at level `full` it runs the export first. */
export const validationReportExpression = (level: WorkspaceValidationLevel) =>
  `window.__t3WorkspaceValidation.report(${JSON.stringify({ export: level === "full" })})`;

const ExportFileReport = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  size: Schema.Number,
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  decodeError: Schema.optional(Schema.String),
  /** The bytes, for a file a returned ffmpeg command names. */
  base64: Schema.optional(Schema.String),
});

/** What `validationReportExpression` resolves to. */
export const PageReport = Schema.Struct({
  chromePatches: Schema.Array(
    Schema.Union([
      Schema.Struct({ patch: Schema.Unknown }),
      Schema.Struct({ error: Schema.String }),
    ]),
  ),
  export: Schema.optional(
    Schema.Union([
      Schema.Struct({ available: Schema.Literal(false) }),
      Schema.Struct({
        available: Schema.Literal(true),
        ok: Schema.Boolean,
        error: Schema.optional(Schema.String),
        files: Schema.Array(ExportFileReport),
        ffmpeg: Schema.Array(Schema.String),
        problems: Schema.Array(Schema.String),
      }),
    ]),
  ),
});
export type PageReport = typeof PageReport.Type;

/** The export's ffmpeg commands and the files they may read, from a report. */
export function exportFfmpegInputs(report: PageReport) {
  const exported = report.export;
  if (exported === undefined || !exported.available) return { commands: [], files: [] };
  return {
    commands: exported.ffmpeg,
    files: exported.files.flatMap((file) =>
      file.base64 === undefined
        ? []
        : [{ name: file.name, bytes: new Uint8Array(Buffer.from(file.base64, "base64")) }],
    ),
  };
}

const toError = (
  problem: PageObservation["problems"][number],
  duringExport: boolean,
): WorkspaceValidationError => {
  const at = problem.text.indexOf(TEMPLATE_CUSTOM_SCRIPT_ERROR_MARKER);
  if (at !== -1) {
    return {
      source: "customScript",
      message:
        problem.text.slice(at + TEMPLATE_CUSTOM_SCRIPT_ERROR_MARKER.length).trim() ||
        "customScript failed.",
    };
  }
  return { source: duringExport ? "export" : problem.source, message: problem.text };
};

/** Errors from replaying the page's `setChrome` patches over the workspace's chrome. */
function chromePatchErrors(
  chrome: WorkspaceChrome,
  patches: PageReport["chromePatches"],
): ReadonlyArray<WorkspaceValidationError> {
  const errors: Array<WorkspaceValidationError> = [];
  let state = { chrome, values: resolveWorkspaceChromeValues(chrome) };
  for (const entry of patches) {
    if ("error" in entry) {
      errors.push({ source: "chrome", message: entry.error });
      continue;
    }
    const result = applyWorkspaceChromePatch(state.chrome, state.values, entry.patch);
    if ("error" in result) errors.push({ source: "chrome", message: result.error });
    else state = result;
  }
  return errors;
}

/** What validation observed, for `shapeValidation`. */
export interface ValidationObservation {
  readonly level: WorkspaceValidationLevel;
  /** None means the preview browser is not installed. */
  readonly observation: Option.Option<PageObservation>;
  /** The page's report; undefined when it never settled or its probe ran out of time. */
  readonly report?: PageReport | undefined;
  /** The export's ffmpeg dry runs: None when ffmpeg is not installed, undefined when not run. */
  readonly ffmpeg?: Option.Option<ReadonlyArray<FfmpegCommandCheck>> | undefined;
  /** The workspace's chrome, which the page's `setChrome` patches apply to. */
  readonly chrome?: WorkspaceChrome | undefined;
  readonly omittedAssets?: ReadonlyArray<string>;
  /** For messages: how long the page had to boot, and the export to run. */
  readonly pageBudget: string;
  readonly exportBudget: string;
}

function exportCheck(
  input: ValidationObservation,
  observation: PageObservation,
  errors: Array<WorkspaceValidationError>,
): WorkspaceExportCheck {
  if (!observation.settled) {
    return { skipped: `the page did not finish booting within ${input.pageBudget}`, files: [] };
  }
  const exported = input.report?.export;
  if (exported === undefined) {
    return { skipped: `export() did not finish within ${input.exportBudget}`, files: [] };
  }
  if (!exported.available) {
    return { skipped: "the page has no window.t3template.export()", files: [] };
  }
  if (!exported.ok) {
    errors.push({ source: "export", message: `export() failed: ${exported.error ?? "unknown"}` });
  }
  for (const problem of exported.problems) errors.push({ source: "export", message: problem });
  const files = exported.files.map(({ name, type, size, width, height, decodeError }) => {
    if (decodeError !== undefined) {
      errors.push({
        source: "export",
        message: `export() produced ${name}, which does not decode as ${type}: ${decodeError}`,
      });
    }
    return {
      name,
      type,
      size,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    };
  });
  if (exported.ffmpeg.length === 0) return { files };
  const checks = input.ffmpeg;
  if (checks === undefined) {
    return { files, ffmpegSkipped: "the validation budget ran out before the dry run" };
  }
  if (Option.isNone(checks)) {
    return { files, ffmpegSkipped: "ffmpeg is not on this machine's PATH" };
  }
  const ffmpeg = checks.value.map((check) => {
    if (check.status === "failed") {
      errors.push({
        source: "ffmpeg",
        message: `ffmpeg command ${check.command} failed its dry run:\n${check.stderr}`,
      });
      return { command: check.command, status: check.status };
    }
    return check;
  });
  return { files, ffmpeg };
}

/**
 * The agent-facing result of one validation: each distinct error once, in
 * the order the page reported them (boot first, then the export, its ffmpeg
 * dry runs, and the page's `setChrome` patches), the first few listed.
 */
export function shapeValidation(input: ValidationObservation): WorkspaceValidation {
  const omittedAssets = input.omittedAssets ?? [];
  const assetNote = omittedAssets.length === 0 ? {} : { omittedAssets };
  if (Option.isNone(input.observation)) {
    return {
      level: input.level,
      ok: true,
      errors: [],
      skipped: "T3's preview browser is not installed on this machine.",
      ...assetNote,
    };
  }
  const observation = input.observation.value;
  const exportStart = observation.probe?.problemsBefore ?? observation.problems.length;
  const all: Array<WorkspaceValidationError> = observation.problems.map((problem, index) =>
    toError(problem, input.level === "full" && index >= exportStart),
  );
  const exported = input.level === "full" ? exportCheck(input, observation, all) : undefined;
  if (input.chrome !== undefined && input.report !== undefined) {
    all.push(...chromePatchErrors(input.chrome, input.report.chromePatches));
  }
  const seen = new Set<string>();
  const errors: Array<WorkspaceValidationError> = [];
  for (const error of all) {
    const key = `${error.source}\0${error.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push(error);
  }
  const moreErrors = Math.max(0, errors.length - MAX_LISTED_ERRORS) + observation.omitted;
  return {
    level: input.level,
    ok: errors.length === 0 && observation.omitted === 0,
    errors: errors.slice(0, MAX_LISTED_ERRORS),
    ...(moreErrors === 0 ? {} : { moreErrors }),
    ...assetNote,
    ...(exported === undefined ? {} : { export: exported }),
  };
}

/** A validation that could not run, and why. */
export const skippedValidation = (
  level: WorkspaceValidationLevel,
  reason: string,
): WorkspaceValidation => ({ level, ok: true, errors: [], skipped: reason });

/** What the `workspace_mutate` result tells the agent to do next. */
export function workspaceMutateAdvice(validation: WorkspaceValidation): string {
  const shown =
    "The thread now shows this workspace in place of chat, with the composer inside it.";
  if (!validation.ok) {
    return `${shown} It reported errors (see validation.errors): fix them with another ${WORKSPACE_MUTATE_TOOL_NAME} call before replying, without asking the user.`;
  }
  const reply = "Reply in a sentence or two; the user is already looking at it.";
  if (validation.skipped !== undefined) {
    return `${shown} It was not checked for errors (${validation.skipped}). ${reply}`;
  }
  const exported =
    validation.export !== undefined && validation.export.skipped === undefined
      ? " and exported"
      : "";
  return `${shown} It loaded${exported} without errors. ${reply}`;
}
