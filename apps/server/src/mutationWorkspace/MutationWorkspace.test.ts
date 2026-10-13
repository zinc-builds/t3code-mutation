import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as MutationWorkspace from "./MutationWorkspace.ts";

// Publishing only needs `prepare`; the page passes through untouched.
const htmlRenderStub = Layer.succeed(HtmlRender.HtmlRender, {
  prepare: (html: string) => Effect.succeed(html),
} as unknown as HtmlRender.HtmlRender["Service"]);

const layerMutationWorkspace = () =>
  MutationWorkspace.layer.pipe(
    Layer.provide(htmlRenderStub),
    Layer.provide(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-mutation-test-" })),
    ),
  );

const thread = ThreadId.make("thread-editor");

it.layer(NodeServices.layer)("MutationWorkspace chrome", (it) => {
  it.effect("publishes the normalized manifest with the page", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const reference = yield* workspace.publish({
        threadId: thread,
        html: "<p>canvas</p>",
        title: "Photo editor",
        assetPaths: [],
        chrome: {
          inspector: [
            {
              title: "Light",
              controls: [{ type: "slider", id: "exposure", label: "Exposure", min: -4, max: 4 }],
            },
          ],
        },
      });
      assert.deepEqual(reference.chrome?.inspector?.[0]?.controls[0], {
        type: "slider",
        id: "exposure",
        label: "Exposure",
        min: -4,
        max: 4,
        step: 0.08,
        value: -4,
      });
    }).pipe(Effect.provide(layerMutationWorkspace())),
  );

  it.effect("rejects an invalid manifest with the path to fix, and stores nothing", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const error = yield* workspace
        .publish({
          threadId: thread,
          html: "<p>canvas</p>",
          title: "Photo editor",
          assetPaths: [],
          chrome: { toolbar: [{ type: "button", id: "export" }] },
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkspaceChromeInvalidError");
      assert.include(error.message, "chrome.toolbar[0].label");
    }).pipe(Effect.provide(layerMutationWorkspace())),
  );

  it.effect("leaves a workspace without chrome as it was", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const reference = yield* workspace.publish({
        threadId: thread,
        html: "<p>page</p>",
        title: "Page",
        assetPaths: [],
      });
      assert.isFalse("chrome" in reference);
    }).pipe(Effect.provide(layerMutationWorkspace())),
  );
});
