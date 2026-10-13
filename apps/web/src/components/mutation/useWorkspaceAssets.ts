import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  workspaceAttachmentResource,
  workspaceErrorMessage,
  workspaceFileName,
  workspaceFileResource,
  type WorkspaceAssetResource,
} from "@t3tools/client-runtime/state/mutation-workspace-host";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

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

/** Fetches a workspace asset's bytes from its environment: mint a URL, then download it. */
export function useWorkspaceAssetFetcher() {
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return async (
    environmentId: EnvironmentId,
    resource: WorkspaceAssetResource,
    name: string,
  ): Promise<Blob> => {
    const connection = readPreparedConnection(environmentId);
    if (connection === null)
      throw new Error("Reconnect to this environment to load the workspace.");
    const minted = await createAssetUrl({ environmentId, input: { resource } });
    if (minted._tag !== "Success")
      throw new Error(workspaceErrorMessage(squashAtomCommandFailure(minted)));
    const url = resolveAssetUrl(connection.httpBaseUrl, minted.value.relativeUrl);
    if (url === null) throw new Error(`The environment returned an invalid URL for ${name}.`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${name} could not be loaded (HTTP ${response.status}).`);
    return response.blob();
  };
}

/**
 * Starts loading a workspace's media while the agent's `workspace_mutate` call
 * still runs: the thread's images and the paths the call passed, when its input
 * is visible. The page's `initialize` then answers from the cache. The cache
 * follows the shown thread.
 */
export function useWorkspaceAssetPrewarm(
  threadRef: ScopedThreadRef | null,
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
) {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  // Each call prefetches once; a file the page already took is not fetched again.
  const prefetched = useRef(new Set<string>());
  useEffect(() => {
    setWorkspaceAssetScope(threadKey);
    prefetched.current.clear();
  }, [threadKey]);

  const running = useMemo(() => runningWorkspaceMutations(visibleTurnItems), [visibleTurnItems]);
  const fetchAsset = useWorkspaceAssetFetcher();
  const latest = useRef({ fetchAsset, visibleTurnItems });
  useEffect(() => {
    latest.current = { fetchAsset, visibleTurnItems };
  });

  useEffect(() => {
    if (environmentId === null || threadId === null) return;
    const fresh = running.filter(({ itemId }) => !prefetched.current.has(itemId));
    if (fresh.length === 0) return;
    const { fetchAsset: fetchNow, visibleTurnItems: items } = latest.current;
    const resources: Array<{ resource: WorkspaceAssetResource; name: string }> = [
      ...threadImagesFromTurnItems(items).map((image) => ({
        resource: workspaceAttachmentResource(image),
        name: image.name,
      })),
      ...fresh.flatMap(({ assetPaths }) =>
        assetPaths.map((path) => ({
          resource: workspaceFileResource(threadId, path),
          name: workspaceFileName(path),
        })),
      ),
    ];
    for (const { itemId } of fresh) prefetched.current.add(itemId);
    for (const { resource, name } of resources) {
      prefetchWorkspaceAsset(
        workspaceAssetKey(environmentId, resource),
        resource._tag === "attachment",
        () => fetchNow(environmentId, resource, name),
      );
    }
  }, [running, environmentId, threadId]);
}
