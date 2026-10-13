/**
 * The host's side of a workspace page's live preview, whatever carries the
 * bridge: one review page at a time per workspace page, followed for its own
 * changes while it is open, with each result shaped as the page receives it.
 */
import type {
  WorkspacePreviewAction,
  WorkspacePreviewActResult,
  WorkspacePreviewEvent,
  WorkspacePreviewSession,
  WorkspacePreviewViewport,
} from "@t3tools/contracts";
import {
  WORKSPACE_BRIDGE_METHODS,
  workspaceBridgeNotification,
} from "@t3tools/shared/mutationWorkspace";

/** What `on('preview-changed')` gets. */
export interface WorkspacePreviewChange {
  readonly sessionId: string;
  readonly reason: "loaded" | "navigated" | "mutated" | "closed";
  readonly url: string;
  readonly title: string;
}

export function workspacePreviewChangedNotification(change: WorkspacePreviewChange) {
  return workspaceBridgeNotification(WORKSPACE_BRIDGE_METHODS.previewChanged, change);
}

/** A screenshot as the page receives it: the image as a file, beside where it sits. */
export interface WorkspacePreviewScreenshot<F> {
  readonly file: F;
  readonly width: number;
  readonly height: number;
  readonly scrollY: number;
  readonly fullPage: boolean;
}

/** An action's result as the page receives it; the page's bridge unwraps the field it returns. */
export function workspacePreviewPageResult<F>(
  result: WorkspacePreviewActResult,
  toFile: (base64: string, mimeType: string) => F,
) {
  switch (result._tag) {
    case "screenshot":
      return {
        file: toFile(result.data, result.mimeType),
        width: result.width,
        height: result.height,
        scrollY: result.scrollY,
        fullPage: result.fullPage,
      } satisfies WorkspacePreviewScreenshot<F>;
    case "elements":
      return { elements: result.elements };
    case "element":
      return { element: result.element };
    case "scrolled":
      return { scrollY: result.scrollY };
    case "viewport":
      return { viewport: result.viewport };
    case "done":
      return {};
  }
}

export interface WorkspacePreviewHostOptions<F> {
  /** The URL `open()` without one opens: the workspace's declared preview. */
  readonly declaredUrl: () => string | undefined;
  /** Rejects with an Error the page can show. */
  readonly open: (input: {
    readonly url: string;
    readonly viewport: WorkspacePreviewViewport | undefined;
  }) => Promise<WorkspacePreviewSession>;
  /** Rejects with an Error the page can show. */
  readonly act: (
    sessionId: string,
    action: WorkspacePreviewAction,
  ) => Promise<WorkspacePreviewActResult>;
  /** Closes a page the host let go of, without waiting; the server also closes pages nobody follows. */
  readonly close: (sessionId: string) => void;
  /** Follows a session's events until the returned function is called. */
  readonly follow: (
    sessionId: string,
    onEvent: (event: WorkspacePreviewEvent) => void,
  ) => () => void;
  readonly notify: (change: WorkspacePreviewChange) => void;
  readonly toFile: (base64: string, mimeType: string) => F;
}

export function createWorkspacePreviewHost<F>(options: WorkspacePreviewHostOptions<F>) {
  let current: { readonly sessionId: string; readonly unfollow: () => void } | null = null;
  let disposed = false;

  /** Stops following the open session and returns it. */
  const release = () => {
    const released = current;
    current = null;
    released?.unfollow();
    return released;
  };

  const open = async (
    url: string | undefined,
    viewport: WorkspacePreviewViewport | undefined,
  ): Promise<WorkspacePreviewSession> => {
    const target = url ?? options.declaredUrl();
    if (target === undefined) {
      throw new Error("This workspace has no preview URL. Pass one to preview.open(url).");
    }
    const previous = release();
    if (previous !== null) options.close(previous.sessionId);
    const session = await options.open({ url: target, viewport });
    const { sessionId } = session;
    const unfollow = options.follow(sessionId, (event) => {
      if (current?.sessionId !== sessionId) return;
      if (event._tag === "closed") {
        release();
        options.notify({ sessionId, reason: "closed", url: "", title: "" });
        return;
      }
      options.notify({ sessionId, reason: event.reason, url: event.url, title: event.title });
    });
    // A page that opened another preview meanwhile keeps that one; a page gone keeps none.
    if (current !== null || disposed) {
      unfollow();
      options.close(sessionId);
      throw new Error(disposed ? "The workspace closed." : "Another preview opened first.");
    }
    current = { sessionId, unfollow };
    return session;
  };

  const act = async (action: WorkspacePreviewAction) => {
    if (current === null) throw new Error("No preview is open. Call preview.open() first.");
    const { sessionId } = current;
    if (action._tag === "close") {
      release();
      options.close(sessionId);
      return {};
    }
    return workspacePreviewPageResult(await options.act(sessionId, action), options.toFile);
  };

  /** Lets go of the open session, when the page goes away. */
  const dispose = () => {
    disposed = true;
    const released = release();
    if (released !== null) options.close(released.sessionId);
  };

  return { open, act, dispose };
}
