import {
  type AssetResource,
  AssetWorkspaceAssetUndeclaredError,
  AssetWorkspaceContextResolutionError,
  type ThreadId,
} from "@t3tools/contracts";
import { workspacePreviewOrigin } from "@t3tools/shared/mutationWorkspace";
import {
  workspaceToolItemAssetPaths,
  workspaceToolItemPreviewUrl,
} from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export type WorkspaceAssetResource = Extract<AssetResource, { readonly _tag: "workspace-asset" }>;

type WorkspaceToolItem = ProjectionStore.ProjectionRecords<"turnItems">["turnItems"][number];

/**
 * What a thread's workspaces may reach on the host. A `workspace-asset` URL is
 * minted only for a path a `workspace_mutate` call declared, so the type-blind
 * route that serves it cannot reach any other file; a live preview opens only
 * on an origin such a call declared.
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
    /**
     * Whether such a call, found the same way, declared a preview URL on this
     * origin (as `workspacePreviewOrigin` reads it).
     */
    readonly declaresPreviewOrigin: (
      threadId: ThreadId,
      origin: string,
    ) => Effect.Effect<boolean, ProjectionStore.ProjectionStoreV2Error>;
  }
>()("t3/mutationWorkspace/WorkspaceAssets") {}

const make = Effect.gen(function* () {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

  /** Whether any `workspace_mutate` item of the thread or its fork sources matches. */
  const declared = Effect.fn("WorkspaceAssets.declared")(function* (
    start: ThreadId,
    matches: (item: WorkspaceToolItem) => boolean,
  ) {
    const seen = new Set<ThreadId>();
    let threadId: ThreadId | null = start;
    while (threadId !== null && !seen.has(threadId)) {
      seen.add(threadId);
      const records: ProjectionStore.ProjectionRecords<"turnItems"> =
        yield* projectionStore.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["dynamic_tool"],
          turnItemStatuses: ["completed", "pending", "running"],
        });
      if (records.turnItems.some(matches)) return true;
      const forkedFrom = records.thread.forkedFrom;
      threadId = forkedFrom?.type === "run" ? forkedFrom.threadId : null;
    }
    return false;
  });

  const authorize = Effect.fn("WorkspaceAssets.authorize")(function* (
    resource: WorkspaceAssetResource,
  ) {
    const found = yield* declared(resource.threadId, (item) =>
      workspaceToolItemAssetPaths(item).includes(resource.path),
    ).pipe(
      Effect.mapError((cause) => new AssetWorkspaceContextResolutionError({ resource, cause })),
    );
    if (!found) return yield* new AssetWorkspaceAssetUndeclaredError({ resource });
  });

  const declaresPreviewOrigin = (threadId: ThreadId, origin: string) =>
    declared(threadId, (item) => {
      const url = workspaceToolItemPreviewUrl(item);
      return url !== undefined && workspacePreviewOrigin(url) === origin;
    });

  return WorkspaceAssets.of({ authorize, declaresPreviewOrigin });
});

export const layer = Layer.effect(WorkspaceAssets, make);
