import * as NodeServices from "@effect/platform-node/NodeServices";
import { type OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as WorkspaceState from "./WorkspaceState.ts";
import * as WorkspaceTurnContext from "./WorkspaceTurnContext.ts";

const thread = ThreadId.make("thread-workspace-context");

const toolItem = (id: string, toolName: string, output: unknown) =>
  ({ id, type: "dynamic_tool", status: "completed", toolName, output }) as OrchestrationV2TurnItem;
const mutate = (id: string, title: string) =>
  toolItem(id, "mcp__t3-code__workspace_mutate", {
    mutationWorkspace: { attachmentId: `${id}-html`, title, assets: [] },
    message: "The thread now shows this workspace.",
  });
const restore = (id: string) =>
  toolItem(id, "mcp__t3-code__workspace_restore", {
    restored: true,
    message: "The thread is back in its chat interface.",
  });

/** The service over real state files and a thread whose completed tool items are `items`. */
const layerContext = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  WorkspaceTurnContext.layer.pipe(
    Layer.provideMerge(WorkspaceState.layer),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadRecords: () => Effect.succeed({ turnItems: items } as never),
      }),
    ),
    Layer.provide(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-workspace-context-test-" }),
      ),
    ),
  );

const contextFor = (items: ReadonlyArray<OrchestrationV2TurnItem>, state?: unknown) =>
  Effect.gen(function* () {
    if (state !== undefined) yield* (yield* WorkspaceState.WorkspaceState).write(thread, state);
    return yield* (yield* WorkspaceTurnContext.WorkspaceTurnContext).forUserMessage(thread);
  }).pipe(Effect.provide(layerContext(items)));

it.layer(NodeServices.layer)("WorkspaceTurnContext", (it) => {
  it.effect("carries the stored controls while the agent's workspace is open", () =>
    Effect.gen(function* () {
      const context = yield* contextFor([mutate("t1", "Photo editor")], {
        v: 1,
        exposure: 0.6,
      });
      assert.isTrue(context.startsWith("<workspace_context>\n"));
      assert.isTrue(context.endsWith("\n</workspace_context>"));
      assert.include(context, '"Photo editor"');
      assert.include(context, '{"v":1,"exposure":0.6}');
    }),
  );

  it.effect("adds nothing once the agent restored chat, or before any state or workspace", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* contextFor([mutate("t1", "Photo editor"), restore("t2")], { v: 1 }),
        "",
      );
      assert.strictEqual(yield* contextFor([mutate("t1", "Photo editor")]), "");
      assert.strictEqual(yield* contextFor([], { v: 1 }), "");
    }),
  );

  it.effect("follows the newest workspace call, skipping failed ones", () =>
    Effect.gen(function* () {
      const reopened = yield* contextFor(
        [mutate("t1", "Photo editor"), restore("t2"), mutate("t3", "Video editor")],
        { v: 1 },
      );
      assert.include(reopened, '"Video editor"');
      const failedRestore = toolItem("t2", "mcp__t3-code__workspace_restore", {
        isError: true,
        content: "No thread scope.",
      });
      assert.include(
        yield* contextFor([mutate("t1", "Photo editor"), failedRestore], { v: 1 }),
        '"Photo editor"',
      );
    }),
  );

  it.effect("cuts a large state short within the byte budget and says so", () =>
    Effect.gen(function* () {
      const context = yield* contextFor([mutate("t1", "Data lab")], {
        v: 1,
        notes: "é".repeat(10_000),
      });
      assert.isAtMost(
        new TextEncoder().encode(context).length,
        WorkspaceTurnContext.WORKSPACE_CONTEXT_MAX_BYTES,
      );
      assert.notInclude(context, "\uFFFD");
      assert.include(context, "call workspace_state for the full state");
      assert.isTrue(context.endsWith("\n</workspace_context>"));
    }),
  );
});
