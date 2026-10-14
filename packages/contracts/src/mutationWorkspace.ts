import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/** Largest control state a thread's workspace may store, as UTF-8 JSON. */
export const WORKSPACE_MAX_STATE_BYTES = 64 * 1024;

/**
 * The control state a mutation workspace page keeps for its thread. Clients
 * read it when the page starts and replace it as the user works the controls;
 * the agent reads the same state through `workspace_state`.
 */
export const WorkspaceReadStateInput = Schema.Struct({ threadId: ThreadId });
export type WorkspaceReadStateInput = typeof WorkspaceReadStateInput.Type;

export const WorkspaceReadStateResult = Schema.Struct({
  /** The page's last stored state, or null before it stored any. */
  state: Schema.Unknown,
});
export type WorkspaceReadStateResult = typeof WorkspaceReadStateResult.Type;

export const WorkspaceUpdateStateInput = Schema.Struct({
  threadId: ThreadId,
  state: Schema.Unknown,
});
export type WorkspaceUpdateStateInput = typeof WorkspaceUpdateStateInput.Type;

export class WorkspaceStateError extends Schema.TaggedError<WorkspaceStateError>()(
  "WorkspaceStateError",
  {
    reason: Schema.Literals(["too-large", "invalid-thread", "store-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "too-large":
        return `Workspace state must be at most ${WORKSPACE_MAX_STATE_BYTES} bytes of JSON.`;
      case "invalid-thread":
        return "This thread cannot store workspace state.";
      case "store-failed":
        return "The workspace state could not be read or saved.";
    }
  }
}

/**
 * Live previews a workspace page drives, such as a design review of the
 * user's dev server. The page cannot reach the site from its sandbox, so the
 * environment loads it in a review page of its own browser and the page works
 * on screenshots and element reads. Coordinates are CSS pixels from the top
 * left of the document, not the viewport.
 */
export const WORKSPACE_PREVIEW_MAX_URL_LENGTH = 2048;
export const WORKSPACE_PREVIEW_MAX_SELECTOR_LENGTH = 1024;

const WorkspacePreviewSessionId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
);
export const WORKSPACE_PREVIEW_MAX_STYLES_LENGTH = 65_536;
const WorkspacePreviewSelector = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(WORKSPACE_PREVIEW_MAX_SELECTOR_LENGTH),
);

export const WorkspacePreviewViewport = Schema.Struct({
  width: Schema.Int.check(Schema.isBetween({ minimum: 240, maximum: 3840 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 240, maximum: 4320 })),
});
export type WorkspacePreviewViewport = typeof WorkspacePreviewViewport.Type;

export const WorkspacePreviewOpenInput = Schema.Struct({
  threadId: ThreadId,
  url: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(WORKSPACE_PREVIEW_MAX_URL_LENGTH),
  ),
  viewport: Schema.optional(WorkspacePreviewViewport),
});
export type WorkspacePreviewOpenInput = typeof WorkspacePreviewOpenInput.Type;

export const WorkspacePreviewSession = Schema.Struct({
  sessionId: WorkspacePreviewSessionId,
  url: Schema.String,
  title: Schema.String,
  viewport: WorkspacePreviewViewport,
});
export type WorkspacePreviewSession = typeof WorkspacePreviewSession.Type;

export const WorkspacePreviewBox = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});
export type WorkspacePreviewBox = typeof WorkspacePreviewBox.Type;

/** One element of the reviewed page, as the agent needs it to find and change it. */
export const WorkspacePreviewElement = Schema.Struct({
  /** A CSS selector unique in the page when it was read. */
  selector: Schema.String,
  tag: Schema.String,
  box: WorkspacePreviewBox,
  /** Its visible text, shortened. */
  text: Schema.String,
  /** The start of its outerHTML. */
  html: Schema.String,
  /** Layout, typography, and color properties, as computed. */
  styles: Schema.Record(Schema.String, Schema.String),
});
export type WorkspacePreviewElement = typeof WorkspacePreviewElement.Type;

export const WorkspacePreviewAction = Schema.Union([
  Schema.TaggedStruct("screenshot", { fullPage: Schema.optional(Schema.Boolean) }),
  /** The elements under a point, innermost first. */
  Schema.TaggedStruct("elementsAt", { x: Schema.Finite, y: Schema.Finite }),
  Schema.TaggedStruct("inspect", { selector: WorkspacePreviewSelector }),
  /** Outlines an element in the page, so screenshots show it; null clears it. */
  Schema.TaggedStruct("highlight", { selector: Schema.NullOr(WorkspacePreviewSelector) }),
  /** Replaces T3's stylesheet in the page, kept across reloads; "" removes it. The site's files are untouched. */
  Schema.TaggedStruct("setStyles", {
    css: Schema.String.check(Schema.isMaxLength(WORKSPACE_PREVIEW_MAX_STYLES_LENGTH)),
  }),
  Schema.TaggedStruct("scroll", { y: Schema.Finite }),
  Schema.TaggedStruct("setViewport", { viewport: WorkspacePreviewViewport }),
  Schema.TaggedStruct("reload", {}),
  Schema.TaggedStruct("close", {}),
]);
export type WorkspacePreviewAction = typeof WorkspacePreviewAction.Type;

export const WorkspacePreviewActInput = Schema.Struct({
  threadId: ThreadId,
  sessionId: WorkspacePreviewSessionId,
  action: WorkspacePreviewAction,
});
export type WorkspacePreviewActInput = typeof WorkspacePreviewActInput.Type;

export const WorkspacePreviewActResult = Schema.Union([
  Schema.TaggedStruct("screenshot", {
    mimeType: Schema.Literal("image/png"),
    /** Base64 PNG, at the device's pixel ratio for a viewport capture and at 1 for a full page. */
    data: Schema.String,
    /** The size the image covers, in CSS pixels. */
    width: Schema.Int,
    height: Schema.Int,
    /** Where the image's top sits in the document. */
    scrollY: Schema.Finite,
    fullPage: Schema.Boolean,
  }),
  Schema.TaggedStruct("elements", { elements: Schema.Array(WorkspacePreviewElement) }),
  Schema.TaggedStruct("element", { element: Schema.NullOr(WorkspacePreviewElement) }),
  Schema.TaggedStruct("scrolled", { scrollY: Schema.Finite }),
  Schema.TaggedStruct("viewport", { viewport: WorkspacePreviewViewport }),
  Schema.TaggedStruct("done", {}),
]);
export type WorkspacePreviewActResult = typeof WorkspacePreviewActResult.Type;

export const WorkspacePreviewSubscribeInput = Schema.Struct({
  threadId: ThreadId,
  sessionId: WorkspacePreviewSessionId,
});
export type WorkspacePreviewSubscribeInput = typeof WorkspacePreviewSubscribeInput.Type;

/**
 * What happened to a review page on its own: it loaded, navigated, or its
 * document changed (a dev server's hot reload). The stream ends after `closed`.
 */
export const WorkspacePreviewEvent = Schema.Union([
  Schema.TaggedStruct("changed", {
    sessionId: WorkspacePreviewSessionId,
    reason: Schema.Literals(["loaded", "navigated", "mutated"]),
    url: Schema.String,
    title: Schema.String,
  }),
  Schema.TaggedStruct("closed", {
    sessionId: WorkspacePreviewSessionId,
    reason: Schema.Literals(["closed", "expired", "crashed", "unknown"]),
  }),
]);
export type WorkspacePreviewEvent = typeof WorkspacePreviewEvent.Type;

export class WorkspacePreviewError extends Schema.TaggedError<WorkspacePreviewError>()(
  "WorkspacePreviewError",
  {
    reason: Schema.Literals([
      "invalid-url",
      "undeclared-url",
      "not-found",
      "busy",
      "unavailable",
      "unreachable",
      "invalid-selector",
      "failed",
    ]),
    /** Shown to the page as is; never the page's own content. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = this.detail === undefined ? "" : ` ${this.detail}`;
    switch (this.reason) {
      case "invalid-url":
        return `Previews open only http(s) URLs.${detail}`;
      case "undeclared-url":
        return `This workspace may only preview the URLs the agent passed in workspace_mutate's preview, or the origin of a preview tab open in this thread.${detail}`;
      case "not-found":
        return "This preview is closed. Open it again.";
      case "busy":
        return `Too many previews are open on this environment. Close one and try again.${detail}`;
      case "unavailable":
        return `The environment's browser is not available.${detail}`;
      case "unreachable":
        return `The page did not load.${detail}`;
      case "invalid-selector":
        return `That selector does not match a valid element.${detail}`;
      case "failed":
        return `The preview could not do that.${detail}`;
    }
  }
}
