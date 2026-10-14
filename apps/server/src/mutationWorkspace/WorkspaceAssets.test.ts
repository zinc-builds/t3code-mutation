import { type OrchestrationV2TurnItem, RunId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as WorkspaceAssets from "./WorkspaceAssets.ts";

const thread = ThreadId.make("thread-data");
const fork = ThreadId.make("thread-data-fork");
const other = ThreadId.make("thread-other");

const mutateItem = (
  id: string,
  status: string,
  fields: { readonly input?: unknown; readonly output?: unknown },
) =>
  ({
    id,
    type: "dynamic_tool",
    status,
    toolName: "mcp__t3-code__workspace_mutate",
    ...fields,
  }) as unknown as OrchestrationV2TurnItem;

const published = (id: string, paths: ReadonlyArray<string>) =>
  mutateItem(id, "completed", {
    output: {
      mutationWorkspace: {
        attachmentId: `${id}-html`,
        title: "Data",
        assets: paths.map((path) => ({ path, name: path.split("/").at(-1) })),
      },
      message: "The thread now shows this workspace.",
    },
  });

/** Threads by id: their turn items and the thread a run fork came from. */
const layerThreads = (
  threads: Record<
    string,
    {
      readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
      readonly forkedFrom?: ThreadId;
    }
  >,
) =>
  WorkspaceAssets.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadRecords: (threadId, _fields, filter) => {
          const record = threads[threadId];
          if (record === undefined) {
            return Effect.fail(
              new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
            );
          }
          const turnItems = record.items.filter(
            (item) =>
              (filter?.turnItemTypes?.includes(item.type) ?? true) &&
              (filter?.turnItemStatuses?.includes(item.status) ?? true),
          );
          const forkedFrom =
            record.forkedFrom === undefined
              ? null
              : { type: "run", threadId: record.forkedFrom, runId: RunId.make("run-1") };
          return Effect.succeed({ thread: { forkedFrom }, turnItems } as never);
        },
      }),
    ),
  );

const authorize = (threadId: ThreadId, path: string) =>
  Effect.gen(function* () {
    const assets = yield* WorkspaceAssets.WorkspaceAssets;
    return yield* assets.authorize({ _tag: "workspace-asset", threadId, path }).pipe(
      Effect.as("allowed" as const),
      Effect.catchTags({
        AssetWorkspaceAssetUndeclaredError: () => Effect.succeed("undeclared" as const),
      }),
    );
  });

it.effect("allows only the paths a workspace_mutate call in the thread declared", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* authorize(thread, "/data/sales.csv"), "allowed");
    // A running call's input, which clients load before it finishes.
    assert.strictEqual(yield* authorize(thread, "/data/next.csv"), "allowed");
    // Undeclared, only a prefix of a declared path, or named by a call that failed.
    assert.strictEqual(yield* authorize(thread, "/data/secrets.txt"), "undeclared");
    assert.strictEqual(yield* authorize(thread, "/data/sales"), "undeclared");
    assert.strictEqual(yield* authorize(thread, "/data/broken.csv"), "undeclared");
    // Another thread's workspace does not reach this thread's files.
    assert.strictEqual(yield* authorize(other, "/data/sales.csv"), "undeclared");
    assert.strictEqual(yield* authorize(other, "/other/own.csv"), "allowed");
  }).pipe(
    Effect.provide(
      layerThreads({
        [thread]: {
          items: [
            published("t1", ["/data/sales.csv"]),
            mutateItem("t2", "failed", { input: { assets: ["/data/broken.csv"] } }),
            mutateItem("t3", "running", { input: { assets: ["/data/next.csv"] } }),
          ],
        },
        [other]: { items: [published("o1", ["/other/own.csv"])] },
      }),
    ),
  ),
);

it.effect("follows a fork to the thread whose workspace it shows", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* authorize(fork, "/data/sales.csv"), "allowed");
    assert.strictEqual(yield* authorize(fork, "/data/forked.csv"), "allowed");
    assert.strictEqual(yield* authorize(thread, "/data/forked.csv"), "undeclared");
  }).pipe(
    Effect.provide(
      layerThreads({
        [thread]: { items: [published("t1", ["/data/sales.csv"])] },
        [fork]: { items: [published("f1", ["/data/forked.csv"])], forkedFrom: thread },
      }),
    ),
  ),
);

it.effect("fails with a resolution error for a thread that does not exist", () =>
  Effect.gen(function* () {
    const error = yield* authorize(ThreadId.make("thread-missing"), "/data/sales.csv").pipe(
      Effect.flip,
    );
    assert.strictEqual(error._tag, "AssetWorkspaceContextResolutionError");
  }).pipe(Effect.provide(layerThreads({}))),
);

it.effect(
  "finds a preview origin declared by a published or running call, or a fork's source",
  () =>
    Effect.gen(function* () {
      const assets = yield* WorkspaceAssets.WorkspaceAssets;
      // A published reference, and a running call's input; any path on the origin.
      assert.isTrue(yield* assets.declaresPreviewOrigin(thread, "http://localhost:5173"));
      assert.isTrue(yield* assets.declaresPreviewOrigin(thread, "http://localhost:3000"));
      assert.isTrue(yield* assets.declaresPreviewOrigin(fork, "http://localhost:5173"));
      // Another port is another origin, and a failed call declares nothing.
      assert.isFalse(yield* assets.declaresPreviewOrigin(thread, "http://localhost:8080"));
      assert.isFalse(yield* assets.declaresPreviewOrigin(thread, "http://intranet.local"));
    }).pipe(
      Effect.provide(
        layerThreads({
          [thread]: {
            items: [
              mutateItem("t1", "completed", {
                output: {
                  mutationWorkspace: {
                    attachmentId: "t1-html",
                    title: "Review",
                    assets: [],
                    preview: { url: "http://localhost:5173/settings" },
                  },
                  message: "The thread now shows this workspace.",
                },
              }),
              mutateItem("t2", "running", {
                input: { preview: { url: "http://localhost:3000/" } },
              }),
              mutateItem("t3", "failed", { input: { preview: { url: "http://localhost:8080/" } } }),
            ],
          },
          [fork]: { items: [], forkedFrom: thread },
        }),
      ),
    ),
);
