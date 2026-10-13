import type { AssetResource, EnvironmentId } from "@t3tools/contracts";

/**
 * Workspace media fetched before the page asks for it. While an agent's
 * `workspace_mutate` call runs, the thread's images and the paths it passed
 * start loading here, so the page's `initialize` can answer from memory.
 *
 * Attachments never change, so a loaded one is shared by every page that asks.
 * A file on disk can, so a prefetched file is handed to the first page that
 * asks and then forgotten, and only while it is fresh. The cache holds one
 * thread's media at a time and a bounded number of entries.
 */

const MAX_ENTRIES = 12;
/** A prefetched file older than this is fetched again: the agent may have rewritten it. */
const MAX_FILE_AGE_MS = 60_000;

interface Entry {
  readonly blob: Promise<Blob>;
  /** Whether later pages may reuse it; files are handed out once. */
  readonly shared: boolean;
  readonly startedAt: number;
}

const entries = new Map<string, Entry>();
let scope: string | null = null;

/** The cache key of a workspace asset; only attachments and workspace files are cached. */
export function workspaceAssetKey(
  environmentId: EnvironmentId,
  resource: Extract<AssetResource, { readonly _tag: "attachment" | "workspace-asset" }>,
): string {
  return resource._tag === "attachment"
    ? `${environmentId}\0attachment\0${resource.attachmentId}`
    : `${environmentId}\0workspace-asset\0${resource.threadId}\0${resource.path}`;
}

/** Forgets everything when the shown thread changes; `key` identifies the thread. */
export function setWorkspaceAssetScope(key: string | null): void {
  if (key === scope) return;
  scope = key;
  entries.clear();
}

/** Makes `entry` the newest, evicting the oldest past the bound. */
function touch(key: string, entry: Entry): void {
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

function remember(key: string, entry: Entry): void {
  touch(key, entry);
  // A failed load is forgotten, so the page's own request tries again.
  entry.blob.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
}

const fresh = (entry: Entry, now: number) =>
  entry.shared || now - entry.startedAt <= MAX_FILE_AGE_MS;

/** Starts loading an asset a page is about to ask for, unless it is already loading. */
export function prefetchWorkspaceAsset(
  key: string,
  shared: boolean,
  load: () => Promise<Blob>,
  now = Date.now(),
): void {
  const entry = entries.get(key);
  if (entry !== undefined && fresh(entry, now)) return;
  remember(key, { blob: load(), shared, startedAt: now });
}

/**
 * The asset for a page: a prefetched or shared load when there is one,
 * otherwise a new load (kept for later pages when `shared`). `prefetched`
 * says which, for timing.
 */
export function loadWorkspaceAsset(
  key: string,
  shared: boolean,
  load: () => Promise<Blob>,
  now = Date.now(),
): { readonly blob: Promise<Blob>; readonly prefetched: boolean } {
  const entry = entries.get(key);
  if (entry !== undefined && fresh(entry, now)) {
    if (entry.shared) touch(key, entry);
    else entries.delete(key);
    return { blob: entry.blob, prefetched: true };
  }
  if (entry !== undefined) entries.delete(key);
  const blob = load();
  if (shared) remember(key, { blob, shared, startedAt: now });
  return { blob, prefetched: false };
}
