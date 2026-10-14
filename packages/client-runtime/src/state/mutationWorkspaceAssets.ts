// @effect-diagnostics globalTimers:off - The host renews a page's URLs from React, outside an Effect runtime.
/**
 * How every mutation workspace host (web and desktop through an iframe,
 * mobile through a WebView relay) hands a page its assets: each asset's URL
 * is minted first, which also says its type and size; video and audio are
 * then handed over as that URL, playing from where the file is stored, and
 * every other type as its bytes. Streamed URLs are signed for an hour, so the
 * host re-mints them while the page is open and tells the page the new ones.
 */
import { WORKSPACE_BRIDGE_METHODS, workspaceAssetStreams } from "@t3tools/shared/mutationWorkspace";

import type { WorkspaceAssetResource, WorkspaceAssetSource } from "./mutationWorkspaceHost.ts";

/**
 * A new URL for every streamed asset this often. Asset URLs are signed for an
 * hour (`ASSET_TOKEN_TTL_MS` on the server), so a renewal that fails has half
 * that left to retry before the page's URL stops working; the app's other
 * asset URLs refresh on the same cadence. Timed on the client's own clock, so
 * a skewed clock does not shift it.
 */
export const WORKSPACE_ASSET_URL_REFRESH_MS = 30 * 60_000;
/** After a failed renewal, how soon the assets it missed are tried again. */
export const WORKSPACE_ASSET_URL_RETRY_MS = 60_000;

/** What minting an asset's URL returned, resolved against the environment's HTTP origin. */
export interface MintedWorkspaceAsset {
  readonly url: string;
  /** Size and Content-Type, which the server reports for a file the agent passed. */
  readonly file?: { readonly size: number; readonly contentType: string } | undefined;
}

/** An asset as a host hands it over: its source, its type, and its URL. */
export type PlannedWorkspaceAsset = {
  readonly source: WorkspaceAssetSource;
  readonly mimeType: string;
  readonly url: string;
} & (
  | { readonly streams: true; readonly size: number }
  | { readonly streams: false; readonly size: number | null }
);

/**
 * Mints every asset's URL and decides how it reaches the page, by type alone
 * (`workspaceAssetStreams`). A file asset's type and size come from the
 * server; one that reports neither cannot be classified, so it fails rather
 * than guess.
 */
export async function planWorkspaceAssets(
  sources: ReadonlyArray<WorkspaceAssetSource>,
  mint: (resource: WorkspaceAssetResource) => Promise<MintedWorkspaceAsset>,
): Promise<PlannedWorkspaceAsset[]> {
  return Promise.all(
    sources.map(async (source): Promise<PlannedWorkspaceAsset> => {
      const minted = await mint(source.resource);
      const mimeType = source.mimeType ?? minted.file?.contentType;
      if (mimeType === undefined) {
        throw new Error(
          `The environment did not say what kind of file ${source.name} is; update T3 Code on it.`,
        );
      }
      if (!workspaceAssetStreams(mimeType)) {
        return {
          source,
          mimeType,
          url: minted.url,
          streams: false,
          size: minted.file?.size ?? null,
        };
      }
      if (minted.file === undefined) {
        throw new Error(
          `The environment did not report the size of ${source.name}; update T3 Code on it.`,
        );
      }
      return { source, mimeType, url: minted.url, streams: true, size: minted.file.size };
    }),
  );
}

/** The wire fields that say which asset this is, for `initialize`'s answer. */
export function workspaceBridgeAssetIdentity(asset: PlannedWorkspaceAsset) {
  const { source } = asset;
  return source.source === "attachment"
    ? {
        name: source.name,
        mimeType: asset.mimeType,
        source: "attachment" as const,
        attachmentId: source.attachmentId,
      }
    : { name: source.name, mimeType: asset.mimeType, source: "file" as const, path: source.path };
}

/** Tells the page the asset at `index` of `initialize`'s answer now plays from `url`. */
export function workspaceAssetUrlNotification(index: number, name: string, url: string) {
  return {
    jsonrpc: "2.0",
    method: WORKSPACE_BRIDGE_METHODS.assetUrl,
    params: { index, name, url },
  } as const;
}

/** A streamed asset the page holds, by its place in `initialize`'s answer. */
export interface StreamedWorkspaceAsset {
  readonly index: number;
  readonly name: string;
  readonly resource: WorkspaceAssetResource;
}

/** The streamed assets of a plan, by index. */
export function streamedWorkspaceAssets(
  assets: ReadonlyArray<PlannedWorkspaceAsset>,
): StreamedWorkspaceAsset[] {
  return assets.flatMap((asset, index) =>
    asset.streams ? [{ index, name: asset.source.name, resource: asset.source.resource }] : [],
  );
}

export interface WorkspaceAssetUrlRefresherInput {
  readonly assets: ReadonlyArray<StreamedWorkspaceAsset>;
  /** A fresh URL for the resource, resolved against the environment's current HTTP origin. */
  readonly mint: (resource: WorkspaceAssetResource) => Promise<string>;
  /** Delivers `workspaceAssetUrlNotification` to the page. */
  readonly notify: (message: ReturnType<typeof workspaceAssetUrlNotification>) => void;
  /** A renewal failed; the assets it missed are tried again after `retryMs`. */
  readonly onError: (error: unknown) => void;
  readonly refreshMs?: number;
  readonly retryMs?: number;
}

/**
 * Keeps a page's streamed URLs from expiring under it: every `refreshMs` it
 * mints each again and notifies the page, and retries the ones that failed
 * every `retryMs` until they succeed. Re-minting goes through the client's own
 * authenticated connection, so a remote or tunnelled client renews as it
 * minted, a URL follows a changed HTTP origin, and a client whose access was
 * revoked stops getting new ones. `dispose` stops it, and drops renewals
 * still in flight.
 */
export function startWorkspaceAssetUrlRefresher(input: WorkspaceAssetUrlRefresherInput): {
  readonly dispose: () => void;
} {
  const refreshMs = input.refreshMs ?? WORKSPACE_ASSET_URL_REFRESH_MS;
  const retryMs = input.retryMs ?? WORKSPACE_ASSET_URL_RETRY_MS;
  let disposed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  if (input.assets.length === 0) return { dispose: () => undefined };

  const renew = async (assets: ReadonlyArray<StreamedWorkspaceAsset>) => {
    const results = await Promise.allSettled(assets.map((asset) => input.mint(asset.resource)));
    if (disposed) return;
    const missed: StreamedWorkspaceAsset[] = [];
    let firstError: unknown;
    results.forEach((result, position) => {
      const asset = assets[position]!;
      if (result.status === "fulfilled") {
        input.notify(workspaceAssetUrlNotification(asset.index, asset.name, result.value));
        return;
      }
      if (missed.length === 0) firstError = result.reason;
      missed.push(asset);
    });
    if (missed.length === 0) return;
    input.onError(firstError);
    // One retry waits at a time, for what the latest renewal missed; each refresh renews every asset.
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void renew(missed);
    }, retryMs);
  };

  const scheduleRefresh = () => {
    refreshTimer = setTimeout(() => {
      scheduleRefresh();
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      void renew(input.assets);
    }, refreshMs);
  };
  scheduleRefresh();

  return {
    dispose: () => {
      disposed = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
    },
  };
}
