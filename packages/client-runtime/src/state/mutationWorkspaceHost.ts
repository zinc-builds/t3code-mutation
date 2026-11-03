/**
 * What every mutation workspace host answers the same way, whatever carries
 * the bridge (an iframe on web and desktop, a WebView on mobile): which files
 * the page receives at initialize, the stored state it starts from, the
 * notifications the host sends, and how failures read to the user.
 */
import type { AssetResource, ThreadId } from "@t3tools/contracts";
import {
  WORKSPACE_BRIDGE_METHODS,
  workspaceBridgeNotification,
  type WorkspaceBridgeRequest,
  type WorkspaceReference,
} from "@t3tools/shared/mutationWorkspace";
import {
  readWorkspaceStateEnvelope,
  resolveWorkspaceChromeValues,
  workspacePageState,
  workspaceStateEnvelope,
} from "@t3tools/shared/mutationWorkspaceChrome";

import type { ThreadImage } from "./mutationWorkspaceActive.ts";

export type WorkspaceAssetResource = Extract<
  AssetResource,
  { readonly _tag: "attachment" | "workspace-asset" }
>;

/**
 * A file the page receives at initialize, the resource its bytes come from,
 * and what the agent knows it by, so the page can name it in what it sends back.
 */
export type WorkspaceAssetSource = {
  readonly resource: WorkspaceAssetResource;
  readonly name: string;
  /** Known up front for an attachment; a host file's type comes from its response. */
  readonly mimeType: string | null;
} & (
  | { readonly source: "attachment"; readonly attachmentId: string }
  | { readonly source: "file"; readonly path: string }
);

/** The last segment of a host path, for a file the agent named only by path. */
export function workspaceFileName(path: string): string {
  return path.slice(path.search(/[^\\/]*$/));
}

export function workspaceAttachmentResource(image: ThreadImage): WorkspaceAssetResource {
  return {
    _tag: "attachment",
    attachmentId: image.attachmentId,
    fileName: image.name,
    mimeType: image.mimeType,
  };
}

/**
 * A file the agent handed the workspace. The server serves it whatever its
 * type (a CSV, a JSON table), but only by a path a `workspace_mutate` call in
 * the thread declared.
 */
export function workspaceFileResource(threadId: ThreadId, path: string): WorkspaceAssetResource {
  return { _tag: "workspace-asset", threadId, path };
}

/** The thread's images, then the files the agent passed, in the order the page receives them. */
export function workspaceAssetSources(
  threadId: ThreadId,
  workspace: WorkspaceReference,
  threadImages: ReadonlyArray<ThreadImage>,
): WorkspaceAssetSource[] {
  return [
    ...threadImages.map((image): WorkspaceAssetSource => ({
      resource: workspaceAttachmentResource(image),
      name: image.name,
      mimeType: image.mimeType,
      source: "attachment",
      attachmentId: image.attachmentId,
    })),
    ...workspace.assets.map((asset): WorkspaceAssetSource => ({
      resource: workspaceFileResource(threadId, asset.path),
      name: asset.name,
      mimeType: null,
      source: "file",
      path: asset.path,
    })),
  ];
}

/**
 * What `initialState()` resolves to from the thread's stored state: the page's
 * own part (a workspace with chrome stores `{ controls, page }`), and
 * undefined before the page stored anything (the server answers null).
 */
export function workspaceInitialPageState(stored: unknown): unknown {
  return workspacePageState(stored ?? undefined) ?? undefined;
}

/**
 * The state to store when the page replaces its own, for a host that does not
 * render the workspace's chrome: the control values already stored (or the
 * manifest's defaults) stay beside the page's state, so another client that
 * renders the chrome finds them as they were.
 */
export function workspaceStateWithPage(
  workspace: WorkspaceReference,
  stored: unknown,
  page: unknown,
): unknown {
  if (workspace.chrome === undefined) return page ?? null;
  const { controls } = readWorkspaceStateEnvelope(stored);
  return workspaceStateEnvelope(resolveWorkspaceChromeValues(workspace.chrome, controls), page);
}

/**
 * The control values a page with chrome renders from, for a host that does not
 * render the chrome itself; null for a workspace without chrome.
 */
export function workspaceControlsNotification(workspace: WorkspaceReference, stored: unknown) {
  if (workspace.chrome === undefined) return null;
  const { controls } = readWorkspaceStateEnvelope(stored);
  return workspaceBridgeNotification(WORKSPACE_BRIDGE_METHODS.controls, {
    values: resolveWorkspaceChromeValues(workspace.chrome, controls),
  });
}

export function workspaceAgentStatusNotification(working: boolean) {
  return workspaceBridgeNotification(WORKSPACE_BRIDGE_METHODS.agentStatus, {
    status: working ? "working" : "idle",
  });
}

export function workspaceComposerSizeNotification(height: number) {
  return workspaceBridgeNotification(WORKSPACE_BRIDGE_METHODS.composerSize, { height });
}

export function workspaceStateErrorNotification(message: string) {
  return workspaceBridgeNotification(WORKSPACE_BRIDGE_METHODS.stateError, { message });
}

/**
 * The title the user sees when the host's own work for a request fails, or
 * null when the request reports its failure elsewhere: sending and attaching
 * go through the composer, which shows its own, and the page shows a
 * preview's.
 */
export function workspaceBridgeFailureTitle(
  method: WorkspaceBridgeRequest<unknown>["method"],
): string | null {
  switch (method) {
    case WORKSPACE_BRIDGE_METHODS.initialize:
      return "Couldn't load the workspace";
    case WORKSPACE_BRIDGE_METHODS.download:
      return "Couldn't save the file";
    case WORKSPACE_BRIDGE_METHODS.send:
    case WORKSPACE_BRIDGE_METHODS.attach:
      return null;
    // A page shows its own preview's failures, such as a dev server that is down.
    case WORKSPACE_BRIDGE_METHODS.previewOpen:
    case WORKSPACE_BRIDGE_METHODS.preview:
      return null;
  }
}

export function workspaceErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}
