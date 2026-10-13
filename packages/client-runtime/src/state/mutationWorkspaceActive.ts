/**
 * Which mutation workspace a thread shows, derived from its turn items: the
 * agent's newest `workspace_mutate` or `workspace_restore` call, overridden by
 * the user's own choice (back to chat, or reopening an older workspace) until
 * the agent acts again. Shared by every client that hosts workspaces.
 */
import type { ChatAttachment } from "@t3tools/contracts";
import { imageMimeType } from "@t3tools/shared/image";
import {
  WORKSPACE_MUTATE_TOOL_NAME,
  workspaceMutateInputAssetPaths,
  workspaceReferencesEqual,
  type WorkspaceReference,
} from "@t3tools/shared/mutationWorkspace";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import { isWorkspaceRestoreToolItem, workspaceFromToolItem } from "@t3tools/shared/toolOutput";

/** The fields of a turn item that mutation workspaces read. */
export interface WorkspaceTurnItem {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly toolName?: string | null;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
}

/** A workspace and the `workspace_mutate` item that published it. */
export interface ItemWorkspace {
  readonly itemId: string;
  readonly workspace: WorkspaceReference;
}

/** The newest completed `workspace_mutate` or `workspace_restore` call in a thread. */
export type WorkspaceEvent =
  | ({ readonly kind: "mutate" } & ItemWorkspace)
  | { readonly kind: "restore"; readonly itemId: string };

/**
 * What the user chose locally, against the agent event that was newest when
 * they chose it: `open: null` means they went back to chat, otherwise they
 * reopened that workspace from history. A newer agent event supersedes it.
 */
export interface WorkspaceOverride {
  readonly eventId: string | null;
  readonly open: ItemWorkspace | null;
}

export interface ThreadImage {
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
}

/** The workspace a completed tool item published, if it is a `workspace_mutate` call. */
export function workspaceFromTurnItem(item: WorkspaceTurnItem): WorkspaceReference | undefined {
  return item.type === "dynamic_tool" && item.status === "completed"
    ? workspaceFromToolItem({ toolName: item.toolName, output: item.output })
    : undefined;
}

/** A `workspace_mutate` call still running, and the asset paths its input names. */
export interface RunningWorkspaceMutation {
  readonly itemId: string;
  readonly assetPaths: ReadonlyArray<string>;
}

const isRunning = (status: string) => status === "pending" || status === "running";

/**
 * The `workspace_mutate` calls running in the current turn, newest first, so
 * their media can load before the page asks. Tool calls run after the turn's
 * user message, so the scan stops there.
 */
export function runningWorkspaceMutations(
  items: ReadonlyArray<{ readonly item: WorkspaceTurnItem }>,
): RunningWorkspaceMutation[] {
  const running: RunningWorkspaceMutation[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const { item } = items[index]!;
    if (item.type === "user_message") break;
    if (
      item.type !== "dynamic_tool" ||
      !isRunning(item.status) ||
      resolveT3McpToolId(item.toolName) !== WORKSPACE_MUTATE_TOOL_NAME
    ) {
      continue;
    }
    running.push({ itemId: item.id, assetPaths: workspaceMutateInputAssetPaths(item.input) });
  }
  return running;
}

/** Scans newest-first, so a long thread pays only for the items after its last workspace call. */
export function latestWorkspaceEvent(
  items: ReadonlyArray<{ readonly item: WorkspaceTurnItem }>,
): WorkspaceEvent | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const { item } = items[index]!;
    if (item.type !== "dynamic_tool" || item.status !== "completed") continue;
    const workspace = workspaceFromTurnItem(item);
    if (workspace !== undefined) return { kind: "mutate", itemId: item.id, workspace };
    if (isWorkspaceRestoreToolItem({ toolName: item.toolName, output: item.output })) {
      return { kind: "restore", itemId: item.id };
    }
  }
  return null;
}

/** The override that records the user's choice against the thread's newest workspace call. */
export function workspaceOverride(
  items: ReadonlyArray<{ readonly item: WorkspaceTurnItem }>,
  open: ItemWorkspace | null,
): WorkspaceOverride {
  return { eventId: latestWorkspaceEvent(items)?.itemId ?? null, open };
}

/** The workspace the thread shows: the user's choice until the agent acts again. */
export function resolveActiveWorkspace(
  latest: WorkspaceEvent | null,
  override: WorkspaceOverride | undefined,
): ItemWorkspace | null {
  if (override !== undefined && override.eventId === (latest?.itemId ?? null)) {
    return override.open;
  }
  return latest?.kind === "mutate" ? { itemId: latest.itemId, workspace: latest.workspace } : null;
}

/** The agent's current workspace after the user went back to chat from it, so it can be resumed. */
export function resumableWorkspace(
  latest: WorkspaceEvent | null,
  active: ItemWorkspace | null,
): ItemWorkspace | null {
  return active === null && latest?.kind === "mutate"
    ? { itemId: latest.itemId, workspace: latest.workspace }
    : null;
}

export function itemWorkspacesEqual(left: ItemWorkspace | null, right: ItemWorkspace | null) {
  if (left === null || right === null) return left === right;
  return left.itemId === right.itemId && workspaceReferencesEqual(left.workspace, right.workspace);
}

// A legacy `file` carrying a picture is still a picture; an unknown type is not.
const isImageAttachment = (attachment: ChatAttachment) =>
  attachment.type === "image" || (attachment.type === "file" && imageMimeType(attachment) !== null);

/** Images the user attached in the thread, oldest first. */
export function threadImagesFromTurnItems(
  items: ReadonlyArray<{ readonly item: WorkspaceTurnItem }>,
): ThreadImage[] {
  const images: ThreadImage[] = [];
  const seen = new Set<string>();
  for (const { item } of items) {
    if (item.type !== "user_message") continue;
    for (const attachment of item.attachments ?? []) {
      if (!isImageAttachment(attachment) || seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      images.push({
        attachmentId: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
      });
    }
  }
  return images;
}

export function threadImagesEqual(
  left: ReadonlyArray<ThreadImage>,
  right: ReadonlyArray<ThreadImage>,
) {
  return (
    left.length === right.length &&
    left.every(
      (image, index) =>
        image.attachmentId === right[index]?.attachmentId &&
        image.name === right[index]?.name &&
        image.mimeType === right[index]?.mimeType,
    )
  );
}
