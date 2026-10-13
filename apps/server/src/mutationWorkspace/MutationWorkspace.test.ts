import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { makeWorkspaceKit, workspaceKit } from "@t3tools/workspace-kit";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as MutationWorkspace from "./MutationWorkspace.ts";

// Publishing only needs `prepare`; the page passes through untouched.
const htmlRenderStub = Layer.succeed(HtmlRender.HtmlRender, {
  prepare: (html: string) => Effect.succeed(html),
} as unknown as HtmlRender.HtmlRender["Service"]);

const fixtureKit = makeWorkspaceKit({
  core: null,
  primitives: [
    { name: "develop", summary: "", docs: "develop docs", source: "window.t3kit_develop=1;" },
    { name: "viewer", summary: "", docs: "viewer docs", source: "window.t3kit_viewer=1;" },
  ],
  templates: [
    {
      id: "photo-develop",
      title: "Photo Develop",
      summary: "Grade one photo.",
      kit: ["develop"],
      options: { look: { type: "string", enum: ["neutral", "moody"], default: "neutral" } },
      examples: [],
      html: "<!doctype html><html><head></head><body><script>app()</script></body></html>",
    },
  ],
});

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

const readStored = Effect.fn("readStored")(function* (attachmentId: string) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(config.attachmentsDir, `${attachmentId}.html`));
});

const layerKitWorkspace = () =>
  Layer.provideMerge(
    MutationWorkspace.layerWithKit(fixtureKit).pipe(Layer.provide(htmlRenderStub)),
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-mutation-kit-test-" })),
  );

it.layer(NodeServices.layer)("MutationWorkspace kit", (it) => {
  it.effect("stores the bridge, then the requested primitives, then the page", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const reference = yield* workspace.publish({
        threadId: thread,
        html: "<html><head><script>glue()</script></head></html>",
        kit: ["viewer"],
        title: "Viewer",
        assetPaths: [],
      });
      const html = yield* readStored(reference.attachmentId);
      const bridge = html.indexOf("window.t3.workspace=");
      const viewer = html.indexOf('<script data-t3kit="viewer">');
      assert.isTrue(bridge > 0 && viewer > bridge && html.indexOf("glue()") > viewer);
      assert.notInclude(html, "t3kit_develop");
    }).pipe(Effect.provide(layerKitWorkspace())),
  );

  it.effect("builds a template page with its kit and options", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const reference = yield* workspace.publish({
        threadId: thread,
        template: { id: "photo-develop", options: { look: "moody" } },
        title: "Develop",
        assetPaths: [],
      });
      const html = yield* readStored(reference.attachmentId);
      assert.include(html, "window.t3kit_develop=1;");
      assert.include(
        html,
        '<script id="t3-template-options" type="application/json">{"look":"moody"}</script>',
      );
      assert.isTrue(html.indexOf("t3-template-options") < html.indexOf("app()"));
    }).pipe(Effect.provide(layerKitWorkspace())),
  );

  it.effect("rejects unknown primitives and bad template options as invalid requests", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const unknown = yield* workspace
        .publish({ threadId: thread, html: "<p></p>", kit: ["warp"], title: "x", assetPaths: [] })
        .pipe(Effect.flip);
      assert.strictEqual(unknown._tag, "WorkspaceKitInvalidError");
      assert.include(
        unknown.message,
        "Unknown kit primitives: warp. Known primitives: develop, viewer.",
      );
      const options = yield* workspace
        .publish({
          threadId: thread,
          template: { id: "photo-develop", options: { look: "dark" } },
          title: "x",
          assetPaths: [],
        })
        .pipe(Effect.flip);
      assert.include(options.message, 'template.options.look: expected one of "neutral", "moody"');
    }).pipe(Effect.provide(layerKitWorkspace())),
  );

  it.effect("documents the names asked for", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const docs = yield* workspace.kitDocs(["viewer", "photo-develop"]);
      assert.deepEqual(docs.primitives, [{ name: "viewer", docs: "viewer docs" }]);
      assert.strictEqual(docs.templates[0]?.summary, "Grade one photo.");
      const error = yield* workspace.kitDocs(["nope"]).pipe(Effect.flip);
      assert.include(error.message, "Unknown kit names: nope.");
    }).pipe(Effect.provide(layerKitWorkspace())),
  );
});

// The shipped kit through the real prepare step (image inlining and its
// limits); only the preview browser is absent, which publishing never needs.
const layerShippedKitWorkspace = () =>
  MutationWorkspace.layer.pipe(
    Layer.provide(HtmlRender.layer),
    Layer.provide(
      Layer.succeed(
        PreviewBrowser.PreviewBrowser,
        PreviewBrowser.PreviewBrowser.of({
          executable: Effect.die("Publishing a workspace needs no preview browser."),
          installed: Effect.succeed(Option.none()),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-mutation-kit-test-" })),
    ),
  );

it.layer(NodeServices.layer)("MutationWorkspace shipped templates", (it) => {
  it.effect("publishes every shipped template's examples with its kit and options", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const docs = yield* workspace.kitDocs(workspaceKit.templateIds);
      assert.isNotEmpty(docs.templates);
      for (const template of docs.templates) {
        assert.isNotEmpty(template.examples, `${template.id} ships examples`);
        for (const example of template.examples) {
          const options = example as Record<string, unknown>;
          const where = `${template.id} ${JSON.stringify(options)}`;
          const reference = yield* workspace.publish({
            threadId: thread,
            template: { id: template.id, options },
            title: template.title,
            assetPaths: [],
          });
          const html = yield* readStored(reference.attachmentId);
          const bridge = html.indexOf("window.t3.workspace=");
          const optionsTag = html.indexOf('<script id="t3-template-options"');
          assert.isTrue(bridge > 0, where);
          for (const name of template.kit) {
            const at = html.indexOf(`<script data-t3kit="${name}">`);
            assert.isTrue(at > bridge && at < optionsTag, `${where}: ${name} loads in order`);
          }
          const tag =
            /<script id="t3-template-options" type="application\/json">(.*?)<\/script>/s.exec(html);
          assert.deepEqual(JSON.parse(tag?.[1] ?? "null"), options, where);
        }
      }
    }).pipe(Effect.provide(layerShippedKitWorkspace())),
  );
});
