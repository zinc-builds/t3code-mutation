import {
  workspaceBridgeAssetIdentity,
  type PlannedWorkspaceAsset,
} from "@t3tools/client-runtime/state/mutation-workspace-assets";
import type { WorkspaceBridgeAsset } from "@t3tools/shared/mutationWorkspace";

/**
 * The assets `initialize` answers with, from a plan: a streamed asset as its
 * URL and size, without reading a byte of it, and every other asset as a
 * File from `loadBytes`. Files clone into the page's opaque origin as they are.
 */
export function loadWorkspaceBridgeAssets(
  planned: ReadonlyArray<PlannedWorkspaceAsset>,
  loadBytes: (asset: PlannedWorkspaceAsset) => Promise<Blob>,
): Promise<WorkspaceBridgeAsset[]> {
  return Promise.all(
    planned.map(async (asset): Promise<WorkspaceBridgeAsset> => {
      const identity = workspaceBridgeAssetIdentity(asset);
      if (asset.streams) return { ...identity, url: asset.url, size: asset.size };
      const blob = await loadBytes(asset);
      return {
        ...identity,
        file: new File([blob], asset.source.name, { type: asset.mimeType }),
      };
    }),
  );
}
