import {
  type AssetResource,
  AssetWorkspaceAssetUndeclaredError,
  AssetWorkspaceContextResolutionError,
  type ThreadId,
} from "@t3tools/contracts";
import { workspaceToolItemAssetPaths } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export type WorkspaceAssetResource = Extract<AssetResource, { readonly _tag: "workspace-asset" }>;

/**
 * Which host files a thread's workspaces may read. A `workspace-asset` URL is
 * minted only for a path a `workspace_mutate` call declared, so the type-blind
 * route that serves it cannot reach any other file.
 */
export class WorkspaceAssets extends Context.Service<
  WorkspaceAssets,
  {
    /**
     * Succeeds when a `workspace_mutate` call in the thread, or in a thread it
     * was forked from (whose items the fork shows), names exactly this path:
     * among a completed call's published assets, or in the input of one still
     * running, which clients load before it finishes.
     */
    readonly authorize: (
      resource: WorkspaceAssetResource,
    ) => Effect.Effect<
      void,
      AssetWorkspaceAssetUndeclaredError | AssetWorkspaceContextResolutionError
    >;
  }
>()("t3/mutationWorkspace/WorkspaceAssets") {}

const make = Effect.gen(function* () {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

  const authorize = Effect.fn("WorkspaceAssets.authorize")(function* (
    resource: WorkspaceAssetResource,
  ) {
    const seen = new Set<ThreadId>();
    let threadId: ThreadId | null = resource.threadId;
    while (threadId !== null && !seen.has(threadId)) {
      seen.add(threadId);
      const records: ProjectionStore.ProjectionRecords<"turnItems"> = yield* projectionStore
        .getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["dynamic_tool"],
          turnItemStatuses: ["completed", "pending", "running"],
        })
        .pipe(
          Effect.mapError((cause) => new AssetWorkspaceContextResolutionError({ resource, cause })),
        );
      if (
        records.turnItems.some((item) => workspaceToolItemAssetPaths(item).includes(resource.path))
      ) {
        return;
      }
      const forkedFrom = records.thread.forkedFrom;
      threadId = forkedFrom?.type === "run" ? forkedFrom.threadId : null;
    }
    return yield* new AssetWorkspaceAssetUndeclaredError({ resource });
  });

  return WorkspaceAssets.of({ authorize });
});

export const layer = Layer.effect(WorkspaceAssets, make);
