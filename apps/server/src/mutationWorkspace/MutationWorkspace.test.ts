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
import * as NodeURL from "node:url";

import * as ServerConfig from "../config.ts";
import * as HeadlessChrome from "../htmlRender/headlessChrome.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as FfmpegDryRun from "./FfmpegDryRun.ts";
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

// No export in these tests reaches ffmpeg unless one gives a dry run.
const ffmpegWith = (dryRun: FfmpegDryRun.FfmpegDryRun["Service"]["dryRun"]) =>
  Layer.succeed(FfmpegDryRun.FfmpegDryRun, FfmpegDryRun.FfmpegDryRun.of({ dryRun }));
const ffmpegUnused = ffmpegWith(() => Effect.die("This test runs no ffmpeg."));

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

const layerKitWorkspace = (htmlRender = htmlRenderStub, ffmpeg = ffmpegUnused) =>
  Layer.provideMerge(
    MutationWorkspace.layerWithKit(fixtureKit).pipe(
      Layer.provide(htmlRender),
      Layer.provide(ffmpeg),
    ),
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
            level: "boot",
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
          level: "boot",
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

  it.effect("hands the page each asset typed as the asset route serves it to the client", () => {
    const seen: Array<HtmlRender.ObservePageInput> = [];
    const htmlRender = observing((input) =>
      Effect.sync(() => {
        seen.push(input);
        return Option.some({ problems: [], omitted: 0, settled: true });
      }),
    );
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-validate-" });
      const table = path.join(directory, "sales.csv");
      const page = path.join(directory, "page.html");
      yield* fileSystem.writeFileString(table, "region,total\nwest,4\n");
      yield* fileSystem.writeFileString(page, "<p>hi</p>");
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      yield* workspace.publish({
        threadId: thread,
        html: "<html><head></head><body></body></html>",
        title: "Data",
        assetPaths: [table, page],
      });
      const input = seen[0]!;
      assert.strictEqual(input.resources.get("/t3-validation/asset/0")?.contentType, "text/csv");
      assert.strictEqual(
        input.resources.get("/t3-validation/asset/1")?.contentType,
        "application/octet-stream",
      );
      assert.include(input.html, '"name":"sales.csv","mimeType":"text/csv"');
    }).pipe(Effect.scoped, Effect.provide(layerKitWorkspace(htmlRender)));
  });

  // Windows ignores the mode, and root opens the file regardless.
  it.effect.skipIf(process.getuid === undefined || process.getuid() === 0)(
    "refuses an asset the asset route could not open for the client",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-validate-" });
        const locked = path.join(directory, "locked.csv");
        yield* fileSystem.writeFileString(locked, "region,total\n");
        // stat still finds a regular file; only opening it fails, as it would for the route.
        yield* fileSystem.chmod(locked, 0o000);
        const workspace = yield* MutationWorkspace.MutationWorkspace;
        const error = yield* workspace
          .publish({ threadId: thread, html: "<p></p>", title: "Data", assetPaths: [locked] })
          .pipe(Effect.flip);
        assert.instanceOf(error, MutationWorkspace.WorkspaceAssetNotFoundError);
        assert.deepEqual((error as MutationWorkspace.WorkspaceAssetNotFoundError).paths, [locked]);
        yield* fileSystem.chmod(locked, 0o600);
      }).pipe(Effect.scoped, Effect.provide(layerKitWorkspace())),
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
        level: "boot",
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

// A page that booted cleanly and whose report probe returned `report`.
const reporting = (
  report: unknown,
  extra: Partial<HtmlRender.PageObservation> = {},
  seen: Array<HtmlRender.ObservePageInput> = [],
) =>
  observing((input) =>
    Effect.sync(() => {
      seen.push(input);
      return Option.some({
        problems: [],
        omitted: 0,
        settled: true,
        probe: { problemsBefore: 0, value: Option.some(report) },
        ...extra,
      });
    }),
  );

const boltOnTemplate = {
  id: "photo-develop",
  options: { customScript: "t3template.addPanel('Extra')" },
} as const;

it.layer(NodeServices.layer)("MutationWorkspace export validation", (it) => {
  it.effect("runs the export for a template with a bolt-on, and only boots anything else", () => {
    const seen: Array<HtmlRender.ObservePageInput> = [];
    return Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const publish = (input: Partial<MutationWorkspace.WorkspacePublishInput>) =>
        workspace.publish({ threadId: thread, title: "x", assetPaths: [], ...input });
      const bolted = yield* publish({ template: boltOnTemplate });
      const plain = yield* publish({ template: { id: "photo-develop" } });
      const page = yield* publish({ html: "<p>page</p>" });
      const asked = yield* publish({ html: "<p>page</p>", validation: "full" });
      const skipped = yield* publish({ template: boltOnTemplate, validation: "boot" });
      assert.deepEqual(
        [bolted, plain, page, asked, skipped].map(({ validation }) => validation.level),
        ["full", "boot", "boot", "full", "boot"],
      );
      assert.deepEqual(
        seen.map((input) => input.probe?.expression),
        [
          'window.__t3WorkspaceValidation.report({"export":true})',
          'window.__t3WorkspaceValidation.report({"export":false})',
          'window.__t3WorkspaceValidation.report({"export":false})',
          'window.__t3WorkspaceValidation.report({"export":true})',
          'window.__t3WorkspaceValidation.report({"export":false})',
        ],
      );
      assert.deepEqual(asked.validation.export, {
        skipped: "the page has no window.t3template.export()",
        files: [],
      });
      assert.isUndefined(page.validation.export);
    }).pipe(
      Effect.provide(
        layerKitWorkspace(reporting({ chromePatches: [], export: { available: false } }, {}, seen)),
      ),
    );
  });

  it.effect(
    "reports the export's files and dry-runs its ffmpeg commands on the real assets",
    () => {
      const dryRuns: Array<FfmpegDryRun.FfmpegDryRunInput> = [];
      const report = {
        chromePatches: [],
        export: {
          available: true,
          ok: true,
          files: [
            { name: "cut.edl.json", type: "application/json", size: 120 },
            {
              name: "cut-overlay-title.png",
              type: "image/png",
              size: 4,
              width: 1920,
              height: 1080,
              base64: Buffer.from("png!").toString("base64"),
            },
          ],
          ffmpeg: [
            "ffmpeg -i clip.mp4 -i cut-overlay-title.png -filter_complex '[0:v][1:v]overlay' cut.mp4",
            "ffmpeg -i clip.mp4 -vf 'nope=1' still.png",
          ],
          problems: [],
        },
      };
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-validate-" });
        const clip = path.join(directory, "clip.mp4");
        yield* fileSystem.writeFileString(clip, "mp4");
        const workspace = yield* MutationWorkspace.MutationWorkspace;
        const { validation } = yield* workspace.publish({
          threadId: thread,
          title: "Cut",
          assetPaths: [clip],
          template: boltOnTemplate,
        });
        assert.deepEqual(validation, {
          level: "full",
          ok: false,
          errors: [
            {
              source: "ffmpeg",
              message:
                "ffmpeg command 2 failed its dry run:\n[AVFilterGraph] No such filter: 'nope'",
            },
          ],
          export: {
            files: [
              { name: "cut.edl.json", type: "application/json", size: 120 },
              {
                name: "cut-overlay-title.png",
                type: "image/png",
                size: 4,
                width: 1920,
                height: 1080,
              },
            ],
            ffmpeg: [
              { command: 1, status: "ok" },
              { command: 2, status: "failed" },
            ],
          },
        });
        assert.include(workspaceMutateAdvice(validation), "fix them with another workspace_mutate");
        const [dryRun] = dryRuns;
        assert.deepEqual(dryRun?.commands, report.export.ffmpeg);
        assert.deepEqual(dryRun?.assetPaths, [clip]);
        assert.deepEqual(
          dryRun?.files.map((file) => [file.name, Buffer.from(file.bytes).toString()]),
          [["cut-overlay-title.png", "png!"]],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerKitWorkspace(
            reporting(report),
            ffmpegWith((input) =>
              Effect.sync(() => {
                dryRuns.push(input);
                return Option.some([
                  { command: 1, status: "ok" as const },
                  {
                    command: 2,
                    status: "failed" as const,
                    stderr: "[AVFilterGraph] No such filter: 'nope'",
                  },
                ]);
              }),
            ),
          ),
        ),
      );
    },
  );

  it.effect("says when ffmpeg is not installed, and passes a clean export", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const { validation } = yield* workspace.publish({
        threadId: thread,
        title: "Cut",
        assetPaths: [],
        template: boltOnTemplate,
      });
      assert.deepEqual(validation, {
        level: "full",
        ok: true,
        errors: [],
        export: {
          files: [{ name: "cut.m4a.sh", type: "text/plain", size: 9 }],
          ffmpegSkipped: "ffmpeg is not on this machine's PATH",
        },
      });
      assert.include(workspaceMutateAdvice(validation), "It loaded and exported without errors.");
    }).pipe(
      Effect.provide(
        layerKitWorkspace(
          reporting({
            chromePatches: [],
            export: {
              available: true,
              ok: true,
              files: [{ name: "cut.m4a.sh", type: "text/plain", size: 9 }],
              ffmpeg: ["ffmpeg -i a.wav -af volume=2 a.m4a"],
              problems: [],
            },
          }),
          ffmpegWith(() => Effect.succeed(Option.none())),
        ),
      ),
    ),
  );

  it.effect("reports a failed export, what it logged, its bad files and return shape", () => {
    const report = {
      chromePatches: [],
      export: {
        available: true,
        ok: false,
        error: 'image stage "glow": x is not defined',
        files: [
          {
            name: "photo-developed.jpg",
            type: "image/jpeg",
            size: 3,
            decodeError: "The source image cannot be decoded.",
          },
        ],
        ffmpeg: [],
        problems: [
          "export() returned files[0], which is neither a File nor a {name, type, size} description.",
        ],
      },
    };
    return Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const { validation } = yield* workspace.publish({
        threadId: thread,
        title: "Develop",
        assetPaths: [],
        template: boltOnTemplate,
      });
      // Problems after the probe started came from the export.
      assert.deepEqual(validation.errors, [
        { source: "console", message: "boot noise" },
        { source: "export", message: "stage blew up" },
        { source: "customScript", message: 'image stage "glow": x is not defined' },
        { source: "export", message: 'export() failed: image stage "glow": x is not defined' },
        {
          source: "export",
          message:
            "export() returned files[0], which is neither a File nor a {name, type, size} description.",
        },
        {
          source: "export",
          message:
            "export() produced photo-developed.jpg, which does not decode as image/jpeg: The source image cannot be decoded.",
        },
      ]);
      assert.deepEqual(validation.export, {
        files: [{ name: "photo-developed.jpg", type: "image/jpeg", size: 3 }],
      });
    }).pipe(
      Effect.provide(
        layerKitWorkspace(
          reporting(report, {
            problems: [
              { source: "console", text: "boot noise" },
              { source: "console", text: "stage blew up" },
              {
                source: "console",
                text: '[t3template] customScript error: image stage "glow": x is not defined',
              },
            ],
            probe: { problemsBefore: 1, value: Option.some(report) },
          }),
        ),
      ),
    );
  });

  it.effect("says when the export runs out of time or the page never booted", () => {
    let settled = true;
    return Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const publish = () =>
        workspace.publish({
          threadId: thread,
          title: "x",
          assetPaths: [],
          template: boltOnTemplate,
        });
      const slow = yield* publish();
      assert.deepEqual(slow.validation, {
        level: "full",
        ok: true,
        errors: [],
        export: { skipped: "export() did not finish within 6 seconds", files: [] },
      });
      settled = false;
      const stuck = yield* publish();
      assert.deepEqual(stuck.validation.export, {
        skipped: "the page did not finish booting within 6 seconds",
        files: [],
      });
    }).pipe(
      Effect.provide(
        layerKitWorkspace(
          observing(() =>
            Effect.sync(() =>
              Option.some({
                problems: [],
                omitted: 0,
                settled,
                ...(settled ? { probe: { problemsBefore: 0, value: Option.none() } } : {}),
              }),
            ),
          ),
        ),
      ),
    );
  });
});

const chromeTemplateKit = (chrome: Record<string, unknown>) =>
  makeWorkspaceKit({
    core: null,
    primitives: [],
    templates: [
      {
        id: "grade",
        title: "Grade",
        summary: "Grade one photo.",
        kit: [],
        options: {},
        examples: [],
        boltOn: {
          summary: "options.customScript runs once.",
          api: ["addPanel(title) -> body."],
          reservedShortcuts: [],
          example: "t3template.addPanel('Extra');",
        },
        chrome,
        html: "<!doctype html><html><head></head><body></body></html>",
      },
    ],
  });

const exposureChrome = {
  inspector: [
    {
      title: "Light",
      controls: [{ type: "slider", id: "exposure", label: "Exposure", min: -4, max: 4 }],
    },
  ],
};

const layerChromeTemplateWorkspace = (
  chrome: Record<string, unknown>,
  htmlRender = htmlRenderStub,
) =>
  Layer.provideMerge(
    MutationWorkspace.layerWithKit(chromeTemplateKit(chrome)).pipe(
      Layer.provide(htmlRender),
      Layer.provide(ffmpegUnused),
    ),
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-mutation-chrome-" })),
  );

it.layer(NodeServices.layer)("MutationWorkspace template chrome", (it) => {
  it.effect("uses a template's own chrome unless the agent passes one", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const own = yield* workspace.publish({
        threadId: thread,
        title: "Grade",
        assetPaths: [],
        template: { id: "grade" },
      });
      assert.strictEqual(own.reference.chrome?.inspector?.[0]?.controls[0]?.id, "exposure");
      const replaced = yield* workspace.publish({
        threadId: thread,
        title: "Grade",
        assetPaths: [],
        template: { id: "grade" },
        chrome: { toolbar: [{ type: "button", id: "export", label: "Export" }] },
      });
      assert.isUndefined(replaced.reference.chrome?.inspector);
      assert.deepInclude(replaced.reference.chrome?.toolbar?.[0], { id: "export" });
    }).pipe(Effect.provide(layerChromeTemplateWorkspace(exposureChrome))),
  );

  it.effect("names the template when its own chrome is invalid", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const error = yield* workspace
        .publish({ threadId: thread, title: "Grade", assetPaths: [], template: { id: "grade" } })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkspaceChromeInvalidError");
      assert.include(error.message, 'template "grade" declares chrome T3 rejects');
      assert.include(error.message, "chrome.toolbar[0].label");
    }).pipe(
      Effect.provide(layerChromeTemplateWorkspace({ toolbar: [{ type: "button", id: "export" }] })),
    ),
  );

  it.effect("hands the stand-in the chrome, and replays the page's setChrome patches", () => {
    const seen: Array<HtmlRender.ObservePageInput> = [];
    return Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const { validation } = yield* workspace.publish({
        threadId: thread,
        title: "Grade",
        assetPaths: [],
        template: { id: "grade" },
      });
      assert.include(seen[0]!.html, '"chrome":true');
      assert.include(seen[0]!.html, '"controls":{"exposure":-4}');
      assert.deepEqual(validation, {
        level: "boot",
        ok: false,
        errors: [
          {
            source: "chrome",
            message: "setChrome: values must be an object keyed by control id.",
          },
          { source: "chrome", message: "setChrome was passed a patch that is not JSON: cyclic" },
        ],
      });
    }).pipe(
      Effect.provide(
        layerChromeTemplateWorkspace(
          exposureChrome,
          reporting(
            {
              chromePatches: [
                { patch: { values: { exposure: 1 } } },
                {
                  patch: {
                    sidebar: [
                      { id: "history", title: "History", items: [{ id: "a", label: "A" }] },
                    ],
                  },
                },
                { patch: { values: [1] } },
                { error: "setChrome was passed a patch that is not JSON: cyclic" },
              ],
            },
            {},
            seen,
          ),
        ),
      ),
    );
  });

  it.effect("tells the stand-in a page without chrome has none", () => {
    const seen: Array<HtmlRender.ObservePageInput> = [];
    return Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      yield* workspace.publish({
        threadId: thread,
        title: "Page",
        assetPaths: [],
        html: "<p></p>",
      });
      assert.include(seen[0]!.html, '"chrome":false');
      assert.include(
        seen[0]!.html,
        '"chromeMissing":"This workspace has no native chrome; pass `chrome` to workspace_mutate to add it."',
      );
    }).pipe(Effect.provide(layerKitWorkspace(reporting({ chromePatches: [] }, {}, seen))));
  });
});

it.layer(NodeServices.layer)("MutationWorkspace preview", (it) => {
  it.effect("publishes the preview it reviews and hands its URL to the stand-in", () => {
    const seen: Array<HtmlRender.ObservePageInput> = [];
    return Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const { reference } = yield* workspace.publish({
        threadId: thread,
        title: "Design review",
        assetPaths: [],
        html: "<p></p>",
        preview: { url: "http://localhost:5173/pricing" },
      });
      assert.deepStrictEqual(reference.preview, { url: "http://localhost:5173/pricing" });
      assert.include(seen[0]!.html, '"previewUrl":"http://localhost:5173/pricing"');
    }).pipe(Effect.provide(layerKitWorkspace(reporting({ chromePatches: [] }, {}, seen))));
  });

  it.effect("rejects a preview that is not an http(s) URL as an invalid request", () =>
    Effect.gen(function* () {
      const workspace = yield* MutationWorkspace.MutationWorkspace;
      const error = yield* workspace
        .publish({
          threadId: thread,
          title: "Design review",
          assetPaths: [],
          html: "<p></p>",
          preview: { url: "localhost:5173" },
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkspacePreviewUrlInvalidError");
      assert.include(error.message, "http://localhost:5173/");
    }).pipe(Effect.provide(layerKitWorkspace())),
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
          expect(healthy.validation).toEqual({ level: "boot", ok: true, errors: [] });

          const placeholder = yield* publish(
            [
              "t3.workspace.ready().then(({ assets }) => {",
              '  if (assets.length !== 1 || assets[0].mimeType !== "image/png" || assets[0].file.size === 0) throw new Error("placeholder");',
              "});",
            ].join("\n"),
            [],
          );
          expect(placeholder.validation).toEqual({ level: "boot", ok: true, errors: [] });

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
            level: "boot",
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
          expect(boltOn.validation).toMatchObject({
            level: "full",
            ok: false,
            errors: [{ source: "customScript", message: "t3template.nope is not a function" }],
          });

          // A working bolt-on: the full export runs and its file is measured.
          const exported = yield* workspace.publish({
            threadId: thread,
            title: "Develop",
            assetPaths: [],
            template: {
              id: "photo-develop",
              options: {
                customScript:
                  "t3template.addControl({ id: 'lift', label: 'Lift', type: 'slider', min: 0, max: 1, step: 0.1, default: 0.5 });",
              },
            },
          });
          expect(exported.validation).toEqual({
            level: "full",
            ok: true,
            errors: [],
            export: {
              files: [
                {
                  name: "placeholder-developed.jpg",
                  type: "image/jpeg",
                  size: expect.any(Number),
                  width: 1600,
                  height: 1067,
                },
              ],
            },
          });
        }).pipe(Effect.scoped, Effect.provide(layerBrowserWorkspace(executable)));
      }),
    60_000,
  );

  // A template page that declares chrome, patches it at runtime, and exports
  // files plus an ffmpeg command that reads one of them.
  const chromeTemplateHtml = `<!doctype html><html><head></head><body><canvas id="c" width="64" height="32"></canvas><script>
Promise.all([t3.workspace.ready(), t3.workspace.controls()]).then(function (ready) {
  if (ready[1].exposure !== -4) throw new Error("controls " + JSON.stringify(ready[1]));
  window.t3template = {
    export: async function () {
      const blob = await new Promise((resolve) => document.getElementById("c").toBlob(resolve, "image/png"));
      const png = new File([blob], "grade-overlay.png", { type: "image/png" });
      const edl = new File(["{}"], "grade.edl.json", { type: "application/json" });
      await t3.workspace.attach(edl);
      await t3.workspace.download(edl, edl.name);
      return { files: [png, edl], ffmpeg: "ffmpeg -i clip.wav -i grade-overlay.png -filter_complex '[0:a]volume=2[a]' -map '[a]' grade.m4a" };
    },
  };
  return t3.workspace.setChrome({ values: { exposure: 2 } }).then(function () {
    return t3.workspace.setChrome({ toolbar: "nope" });
  });
});
</script></body></html>`;

  it.live(
    "runs a template page's setChrome and export against the stand-in",
    (ctx) =>
      Effect.gen(function* () {
        const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
        if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
        const dryRuns: Array<FfmpegDryRun.FfmpegDryRunInput> = [];
        const kit = chromeTemplateKit(exposureChrome);
        const template = kit.findTemplate("grade");
        if (!template.ok) throw new Error(template.error);
        const layer = MutationWorkspace.layerWithKit(
          makeWorkspaceKit({
            core: null,
            primitives: [],
            templates: [{ ...template.value, html: chromeTemplateHtml }],
          }),
        ).pipe(
          Layer.provide(
            ffmpegWith((input) =>
              Effect.sync(() => {
                dryRuns.push(input);
                return Option.some([{ command: 1, status: "ok" as const }]);
              }),
            ),
          ),
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
            Layer.fresh(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3code-mutation-browser-" }),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-validate-" });
          const clip = path.join(directory, "clip.wav");
          yield* fileSystem.writeFileString(clip, "RIFF");
          const workspace = yield* MutationWorkspace.MutationWorkspace;
          const { reference, validation } = yield* workspace.publish({
            threadId: thread,
            title: "Grade",
            assetPaths: [clip],
            template: { id: "grade" },
            validation: "full",
          });
          expect(reference.chrome?.inspector?.[0]?.controls[0]?.id).toBe("exposure");
          expect(validation).toEqual({
            level: "full",
            ok: false,
            errors: [{ source: "chrome", message: expect.stringContaining("chrome.toolbar") }],
            export: {
              files: [
                {
                  name: "grade-overlay.png",
                  type: "image/png",
                  size: expect.any(Number),
                  width: 64,
                  height: 32,
                },
                { name: "grade.edl.json", type: "application/json", size: 2 },
              ],
              ffmpeg: [{ command: 1, status: "ok" }],
            },
          });
          const [dryRun] = dryRuns;
          expect(dryRun?.assetPaths).toEqual([clip]);
          expect(dryRun?.files.map((file) => file.name)).toEqual(["grade-overlay.png"]);
          expect(Buffer.from(dryRun!.files[0]!.bytes.subarray(1, 4)).toString()).toBe("PNG");
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
    30_000,
  );
});

// Real-browser and real-ffmpeg test of every shipped template's bolt-on example.
const TEST_FFMPEG_ENV = "T3CODE_TEST_FFMPEG";
const TEMPLATE_FIXTURES = NodeURL.fileURLToPath(
  new URL("./__fixtures__/shipped-templates", import.meta.url),
);

describe("MutationWorkspace shipped templates in a browser", () => {
  it.live(
    "every shipped template's bolt-on example boots, exports, and dry-runs its ffmpeg",
    (ctx) =>
      Effect.gen(function* () {
        const env = yield* HostProcess.Environment;
        const executable = env[TEST_BROWSER_ENV];
        if (!executable || !env[TEST_FFMPEG_ENV]) {
          return ctx.skip(`Set ${TEST_BROWSER_ENV} and ${TEST_FFMPEG_ENV} to run this test.`);
        }
        yield* Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const runner = yield* ProcessRunner.ProcessRunner;
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-shipped-" });
          const clip = path.join(directory, "clip.mp4");
          yield* runner.run({
            command: "ffmpeg",
            args: [
              "-hide_banner",
              "-loglevel",
              "error",
              "-f",
              "lavfi",
              "-i",
              "testsrc=size=320x180:rate=24:duration=2",
              "-f",
              "lavfi",
              "-i",
              "sine=frequency=440:duration=2",
              "-c:v",
              "libx264",
              "-pix_fmt",
              "yuv420p",
              "-c:a",
              "aac",
              "-shortest",
              clip,
            ],
          });
          const table = path.join(directory, "trips.csv");
          yield* fileSystem.writeFileString(
            table,
            "trip_id,city,duration_min,member\nT1,Osaka,7.3,true\nT2,Austin,4.2,false\nT3,Osaka,12.5,true\n",
          );
          const workspace = yield* MutationWorkspace.MutationWorkspace;
          for (const id of yield* fileSystem.readDirectory(TEMPLATE_FIXTURES)) {
            expect(workspaceKit.templateIds, `fixture directory ${id}`).toContain(id);
          }
          for (const id of workspaceKit.templateIds) {
            const template = workspaceKit.findTemplate(id);
            if (!template.ok) throw new Error(template.error);
            const pipeline = /pipeline:\s*["'](edl|data)["']/.exec(template.value.html)?.[1];
            // A template that needs its own media (a page, a log, a profile) has a fixture
            // directory named after it; image templates get the stand-in's placeholder photo.
            const fixtures = path.join(TEMPLATE_FIXTURES, id);
            const assetPaths = (yield* fileSystem.exists(fixtures))
              ? (yield* fileSystem.readDirectory(fixtures))
                  .toSorted()
                  .map((name) => path.join(fixtures, name))
              : pipeline === "edl"
                ? [clip]
                : pipeline === "data"
                  ? [table]
                  : [];
            const { validation } = yield* workspace.publish({
              threadId: thread,
              title: template.value.title,
              assetPaths,
              template: { id, options: { customScript: template.value.boltOn.example } },
            });
            expect(validation, id).toMatchObject({ level: "full", ok: true, errors: [] });
            expect(validation.export?.files.length, `${id} exports files`).toBeGreaterThan(0);
            if (pipeline === "edl") {
              const checks = validation.export?.ffmpeg ?? [];
              expect(checks.length, `${id} returns ffmpeg`).toBeGreaterThan(0);
              for (const check of checks) expect(check.status, id).toBe("ok");
            }
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.merge(
              layerBrowserWorkspace(executable),
              ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
            ),
          ),
        );
      }),
    180_000,
  );
});
