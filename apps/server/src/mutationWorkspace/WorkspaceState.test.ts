import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, WORKSPACE_MAX_STATE_BYTES } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as WorkspaceState from "./WorkspaceState.ts";

const layerWorkspaceState = () =>
  WorkspaceState.layer.pipe(
    Layer.provide(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-workspace-state-test-" }),
      ),
    ),
  );

it.layer(NodeServices.layer)("WorkspaceState", (it) => {
  it.effect("keeps the last state per thread, and nothing before the first write", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceState.WorkspaceState;
      const thread = ThreadId.make("thread-editor");
      const other = ThreadId.make("thread-other");
      assert.strictEqual(yield* store.read(thread), undefined);

      yield* store.write(thread, { exposure: 0.4, crop: [0, 0, 1, 1] });
      yield* store.write(thread, { exposure: 1.2 });
      yield* store.write(other, { tracks: 3 });
      assert.deepEqual(yield* store.read(thread), { exposure: 1.2 });
      assert.deepEqual(yield* store.read(other), { tracks: 3 });
    }).pipe(Effect.provide(layerWorkspaceState())),
  );

  it.effect("refuses state over the limit and keeps the previous state", () =>
    Effect.gen(function* () {
      const store = yield* WorkspaceState.WorkspaceState;
      const thread = ThreadId.make("thread-big");
      yield* store.write(thread, { ok: true });
      const error = yield* store
        .write(thread, { blob: "x".repeat(WORKSPACE_MAX_STATE_BYTES) })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkspaceStateError");
      assert.strictEqual(error.reason, "too-large");
      assert.deepEqual(yield* store.read(thread), { ok: true });
    }).pipe(Effect.provide(layerWorkspaceState())),
  );
});
