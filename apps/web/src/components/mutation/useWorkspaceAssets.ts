import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { MintedWorkspaceAsset } from "@t3tools/client-runtime/state/mutation-workspace-assets";
import {
  workspaceAttachmentResource,
  workspaceErrorMessage,
  workspaceFileName,
  workspaceFileResource,
  type WorkspaceAssetResource,
} from "@t3tools/client-runtime/state/mutation-workspace-host";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/models";
import { workspaceAssetStreams } from "@t3tools/shared/mutationWorkspace";
import { useEffect, useRef } from "react";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import {
  runningWorkspaceMutations,
  threadImagesFromTurnItems,
} from "@t3tools/client-runtime/state/mutation-workspace-active";
import {
  prefetchWorkspaceAsset,
  setWorkspaceAssetScope,
  workspaceAssetKey,
} from "./workspaceAssetCache";

/**
 * Mints a workspace asset's URL on its environment, resolved against the
 * environment's current HTTP origin, with the type and size the server reports.
 */
export function useWorkspaceAssetMinter() {
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return async (
    environmentId: EnvironmentId,
    resource: WorkspaceAssetResource,
  ): Promise<MintedWorkspaceAsset> => {
    const connection = readPreparedConnection(environmentId);
    if (connection === null)
      throw new Error("Reconnect to this environment to load the workspace.");
    const minted = await createAssetUrl({ environmentId, input: { resource } });
    if (minted._tag !== "Success")
      throw new Error(workspaceErrorMessage(squashAtomCommandFailure(minted)));
    const url = resolveAssetUrl(connection.httpBaseUrl, minted.value.relativeUrl);
    if (url === null) throw new Error("The environment returned an invalid asset URL.");
    return { url, file: minted.value.file };
  };
}

/** Downloads a workspace asset's bytes from a minted URL. */
export async function fetchWorkspaceAssetBytes(url: string, name: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name} could not be loaded (HTTP ${response.status}).`);
  return response.blob();
}

/**
 * Starts loading a workspace's files while the agent's `workspace_mutate` call still runs, so the
 * page's `initialize` can answer from the cache: the thread's images, and the call's paths once
 * its input is visible. Video and audio never load, since the page plays them from their URL. The
 * cache follows the shown thread.
 */
export function useWorkspaceAssetPrewarm(
  threadRef: ScopedThreadRef | null,
  visibleTurnItems: ReadonlyArray<ThreadStructureVisibleTurnItem>,
) {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  // Each call prefetches once; a file the page already took is not fetched again.
  const prefetched = useRef(new Set<string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- points the module-level asset cache at the shown thread, dropping the previous thread's media
  useEffect(() => {
    setWorkspaceAssetScope(threadKey);
    prefetched.current.clear();
  }, [threadKey]);

  const running = runningWorkspaceMutations(visibleTurnItems);
  const mint = useWorkspaceAssetMinter();
  const latest = useRef({ mint, visibleTurnItems });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the minter and turn items into a ref so new turn items alone do not restart prefetching
  useEffect(() => {
    latest.current = { mint, visibleTurnItems };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts network prefetches into the module-level asset cache when a workspace_mutate call starts
  useEffect(() => {
    if (environmentId === null || threadId === null) return;
    const fresh = running.filter(({ itemId }) => !prefetched.current.has(itemId));
    if (fresh.length === 0) return;
    const { mint: mintNow, visibleTurnItems: items } = latest.current;
    const resources: Array<{
      resource: WorkspaceAssetResource;
      name: string;
      mimeType: string | null;
    }> = [
      ...threadImagesFromTurnItems(items).map((image) => ({
        resource: workspaceAttachmentResource(image),
        name: image.name,
        mimeType: image.mimeType,
      })),
      ...fresh.flatMap(({ assetPaths }) =>
        assetPaths.map((path) => ({
          resource: workspaceFileResource(threadId, path),
          name: workspaceFileName(path),
          mimeType: null,
        })),
      ),
    ];
    for (const { itemId } of fresh) prefetched.current.add(itemId);
    for (const { resource, name, mimeType } of resources) {
      // Minted first: its type says whether there is anything to fetch.
      void mintNow(environmentId, resource).then(
        (minted) => {
          const type = mimeType ?? minted.file?.contentType;
          if (type === undefined || workspaceAssetStreams(type)) return;
          prefetchWorkspaceAsset(
            workspaceAssetKey(environmentId, resource),
            resource._tag === "attachment",
            () => fetchWorkspaceAssetBytes(minted.url, name),
          );
        },
        // A head start only: the page's own `initialize` mints again and reports a failure.
        (error: unknown) => console.warn(`[workspace] could not prefetch ${name}`, error),
      );
    }
  }, [running, environmentId, threadId]);
}
