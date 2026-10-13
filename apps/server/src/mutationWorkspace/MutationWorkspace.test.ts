import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { makeWorkspaceKit, workspaceKit } from "@t3tools/workspace-kit";
import { assert, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as HeadlessChrome from "../htmlRender/headlessChrome.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as MutationWorkspace from "./MutationWorkspace.ts";
import { workspaceMutateAdvice } from "./workspaceValidation.ts";

// Publishing needs `prepare`, where the page passes through untouched, and
// `observe`, which here finds no preview browser unless a test gives one.
const htmlRenderWith = (overrides: Partial<HtmlRender.HtmlRender["Service"]> = {}) =>
  Layer.succeed(HtmlRender.HtmlRender, {
    prepare: (html: string) => Effect.succeed(html),
    observe: () => Effect.succeed(Option.none()),
    ...overrides,
  } as unknown as HtmlRender.HtmlRender["Service"]);
const htmlRenderStub = htmlRenderWith();

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
      boltOn: {
        summary: "options.customScript runs once.",
        api: ["addPanel(title) -> body."],
        reservedShortcuts: [],
        example: "t3template.addPanel('Extra');",
      },
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
      const { reference } = yield* workspace.publish({
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
      const { reference } = yield* workspace.publish({
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

const layerKitWorkspace = (htmlRender = htmlRenderStub) =>
  Layer.provideMerge(
    MutationWorkspace.layerWithKit(fixtureKit).pipe(Layer.provide(htmlRender)),
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-mutation-kit-test-" })),
  );

it.layer(NodeServices.layer)("MutationWorkspace kit", (it) => {
  it.effect("stores the bridge, then the requested primitives, then the page", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const { reference } = yield* workspace.publish({
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
      const { reference } = yield* workspace.publish({
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
          const { reference, validation } = yield* workspace.publish({
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
          assert.deepEqual(validation, {
            ok: true,
            errors: [],
            skipped: "T3's preview browser is not installed on this machine.",
          });
        }
      }
    }).pipe(Effect.provide(layerShippedKitWorkspace())),
  );
});

it.layer(NodeServices.layer)("MutationWorkspace template memo", (it) => {
  it.effect("assembles a template page once per template and kit, whatever its options", () => {
    let prepared = 0;
    const htmlRender = htmlRenderWith({
      prepare: (html: string) =>
        Effect.sync(() => {
          prepared += 1;
          return html;
        }),
    });
    return Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const publishTemplate = (options: Record<string, unknown>, kit?: ReadonlyArray<string>) =>
        workspace
          .publish({
            threadId: thread,
            template: { id: "photo-develop", options },
            kit,
            title: "Develop",
            assetPaths: [],
          })
          .pipe(Effect.flatMap(({ reference }) => readStored(reference.attachmentId)));
      const moody = yield* publishTemplate({ look: "moody" });
      const bolted = yield* publishTemplate({ look: "neutral", customScript: "x('</script>')" });
      assert.strictEqual(prepared, 1);
      assert.strictEqual(
        bolted,
        moody.replace(
          '{"look":"moody"}',
          '{"look":"neutral","customScript":"x(\'\\u003c/script>\')"}',
        ),
      );
      const withViewer = yield* publishTemplate({}, ["viewer"]);
      assert.strictEqual(prepared, 2);
      assert.include(withViewer, "window.t3kit_viewer=1;");
      yield* workspace.publish({
        threadId: thread,
        html: "<p>own page</p>",
        title: "Page",
        assetPaths: [],
      });
      assert.strictEqual(prepared, 3);
    }).pipe(Effect.provide(layerKitWorkspace(htmlRender)));
  });
});

const observing = (
  observe: HtmlRender.HtmlRender["Service"]["observe"],
): Layer.Layer<HtmlRender.HtmlRender> => htmlRenderWith({ observe });

it.layer(NodeServices.layer)("MutationWorkspace validation", (it) => {
  it.effect(
    "boots the stored page with a stand-in host and its assets, and reports each error once",
    () => {
      const seen: Array<HtmlRender.ObservePageInput> = [];
      const htmlRender = observing((input) =>
        Effect.sync(() => {
          seen.push(input);
          return Option.some({
            problems: [
              {
                source: "console",
                text: "[t3template] customScript error: addPanel(title) needs a non-empty string",
              },
              {
                source: "exception",
                text: "TypeError: grade is not a function\n    at page.html:1:9",
              },
              {
                source: "exception",
                text: "TypeError: grade is not a function\n    at page.html:1:9",
              },
              { source: "console", text: "boom" },
            ],
            omitted: 0,
            settled: true,
          });
        }),
      );
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-validate-" });
        const photo = path.join(directory, "photo.jpg");
        yield* fileSystem.writeFileString(photo, "jpeg bytes");
        const workspace = yield* MutationWorkspace.MutationWorkspace;
        const { reference, validation } = yield* workspace.publish({
          threadId: thread,
          html: "<html><head></head><body><script>grade()</script></body></html>",
          title: "Grade",
          assetPaths: [photo],
          chrome: {
            inspector: [
              {
                title: "Light",
                controls: [{ type: "slider", id: "exposure", label: "Exposure", min: -4, max: 4 }],
              },
            ],
          },
        });

        assert.deepEqual(validation, {
          ok: false,
          errors: [
            { source: "customScript", message: "addPanel(title) needs a non-empty string" },
            {
              source: "exception",
              message: "TypeError: grade is not a function\n    at page.html:1:9",
            },
            { source: "console", message: "boom" },
          ],
        });
        assert.include(
          workspaceMutateAdvice(validation),
          "fix them with another workspace_mutate call",
        );

        // The browser loads the stored page, with the host stand-in ahead of the bridge.
        const stored = yield* readStored(reference.attachmentId);
        const input = seen[0]!;
        const host = input.html.indexOf("window.__t3WorkspaceValidation=");
        assert.isTrue(host > 0 && host < input.html.indexOf("window.t3.workspace="));
        assert.strictEqual(
          input.html.replace(/<script>\(function\(\)\{\nvar C=.*?<\/script>/s, ""),
          stored,
        );
        assert.include(input.html, `"path":${JSON.stringify(photo)}`);
        assert.include(input.html, '"controls":{"exposure":-4}');
        const asset = input.resources.get("/t3-validation/asset/0");
        assert.strictEqual(asset?.contentType, "image/jpeg");
        assert.strictEqual(
          Buffer.from(Buffer.from(asset!.body).toString("latin1"), "base64").toString(),
          "jpeg bytes",
        );
      }).pipe(Effect.scoped, Effect.provide(layerKitWorkspace(htmlRender)));
    },
  );

  it.effect("lists the first errors and counts the rest", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const { validation } = yield* workspace.publish({
        threadId: thread,
        html: "<p>noisy</p>",
        title: "Noisy",
        assetPaths: [],
      });
      assert.isFalse(validation.ok);
      assert.strictEqual(validation.errors.length, 10);
      assert.strictEqual(validation.moreErrors, 5);
    }).pipe(
      Effect.provide(
        layerKitWorkspace(
          observing(() =>
            Effect.succeed(
              Option.some({
                problems: Array.from({ length: 12 }, (_, index) => ({
                  source: "console" as const,
                  text: `error ${index}`,
                })),
                omitted: 3,
                settled: false,
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("stores the page unchecked when the browser fails, and says why", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const { reference, validation } = yield* workspace.publish({
        threadId: thread,
        html: "<p>page</p>",
        title: "Page",
        assetPaths: [],
      });
      assert.deepEqual(validation, {
        ok: true,
        errors: [],
        skipped: "Headless Chrome could not render the page: the browser exited unexpectedly.",
      });
      assert.include(workspaceMutateAdvice(validation), "It was not checked for errors");
      assert.include(yield* readStored(reference.attachmentId), "<p>page</p>");
    }).pipe(
      Effect.provide(
        layerKitWorkspace(
          observing(() =>
            Effect.fail(
              new HeadlessChrome.HtmlRenderBrowserError({
                reason: "the browser exited unexpectedly",
              }),
            ),
          ),
        ),
      ),
    ),
  );
});

// Real-browser test; runs only when this names a chrome-headless-shell (or Chrome).
const TEST_BROWSER_ENV = "T3CODE_TEST_HEADLESS_SHELL";

const layerBrowserWorkspace = (executable: string) =>
  MutationWorkspace.layer.pipe(
    Layer.provide(HtmlRender.layer),
    Layer.provide(
      Layer.succeed(
        PreviewBrowser.PreviewBrowser,
        PreviewBrowser.PreviewBrowser.of({
          executable: Effect.die("Validation never installs the preview browser."),
          installed: Effect.succeed(Option.some(executable)),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-mutation-browser-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

describe("MutationWorkspace validation in a browser", () => {
  it.live(
    "hands the page its assets and controls, and reports what broke",
    (ctx) =>
      Effect.gen(function* () {
        const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
        if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
        yield* Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-validate-" });
          const clip = path.join(directory, "clip.mp4");
          yield* fileSystem.writeFileString(clip, "0123456789");
          const workspace = yield* MutationWorkspace.MutationWorkspace;
          const publish = (body: string, assetPaths: ReadonlyArray<string>) =>
            workspace.publish({
              threadId: thread,
              html: `<!doctype html><html><head></head><body><script>${body}</script></body></html>`,
              title: "Check",
              assetPaths,
              chrome: {
                inspector: [
                  {
                    title: "Light",
                    controls: [
                      { type: "slider", id: "exposure", label: "Exposure", min: -4, max: 4 },
                    ],
                  },
                ],
              },
            });

          const healthy = yield* publish(
            [
              "Promise.all([t3.workspace.ready(), t3.workspace.controls()]).then(([{ assets }, controls]) => {",
              "  const [a] = assets;",
              '  if (a.name !== "clip.mp4" || a.source !== "file" || a.file.size !== 10 || a.mimeType !== "video/mp4") throw new Error("asset " + JSON.stringify(a));',
              '  if (controls.exposure !== -4) throw new Error("controls " + JSON.stringify(controls));',
              "  console.log('booted');",
              "});",
            ].join("\n"),
            [clip],
          );
          expect(healthy.validation).toEqual({ ok: true, errors: [] });

          const placeholder = yield* publish(
            [
              "t3.workspace.ready().then(({ assets }) => {",
              '  if (assets.length !== 1 || assets[0].mimeType !== "image/png" || assets[0].file.size === 0) throw new Error("placeholder");',
              "});",
            ].join("\n"),
            [],
          );
          expect(placeholder.validation).toEqual({ ok: true, errors: [] });

          const started = yield* Clock.currentTimeMillis;
          const broken = yield* publish(
            [
              "t3.workspace.ready().then(() => {",
              '  console.error("[t3template] customScript error:", "addPanel(title) needs a non-empty string");',
              "  setTimeout(() => null.x, 10);",
              "});",
            ].join("\n"),
            [clip],
          );
          expect(broken.validation).toEqual({
            ok: false,
            errors: [
              { source: "customScript", message: "addPanel(title) needs a non-empty string" },
              {
                source: "exception",
                message: expect.stringMatching(/^TypeError: Cannot read properties of null/),
              },
            ],
          });
          // Settles a quiet second after boot, well inside the page budget.
          expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(4_000);

          // An image template runs customScript only once its photo is developed, well
          // after the bridge's first quiet second; validation waits for it.
          const boltOn = yield* workspace.publish({
            threadId: thread,
            title: "Develop",
            assetPaths: [],
            template: { id: "photo-develop", options: { customScript: "t3template.nope()" } },
          });
          expect(boltOn.validation).toEqual({
            ok: false,
            errors: [{ source: "customScript", message: "t3template.nope is not a function" }],
          });
        }).pipe(Effect.scoped, Effect.provide(layerBrowserWorkspace(executable)));
      }),
    30_000,
  );
});
