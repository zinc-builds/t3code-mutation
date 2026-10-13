import { assert, describe, it } from "@effect/vitest";

import { GENERATED_KIT } from "./generated.ts";
import {
  boltOnCalls,
  makeWorkspaceKit,
  templateCatalogLine,
  validateTemplateOptions,
  workspaceKit,
} from "./index.ts";
import type { KitPrimitive, KitTemplate } from "./types.ts";

const primitive = (name: string, source = `t3kit.${name}={};`): KitPrimitive => ({
  name,
  summary: `${name} summary.`,
  docs: `t3kit.${name}: docs.`,
  source,
});

const template: KitTemplate = {
  id: "photo-develop",
  title: "Photo Develop",
  summary: "Grade one photo.",
  kit: ["develop", "histogram"],
  options: {
    title: { type: "string", default: "Develop" },
    look: { type: "string", enum: ["neutral", "moody"], default: "neutral" },
    strength: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
    panels: { type: "array", items: { type: "string", enum: ["light", "color"] }, default: [] },
  },
  examples: [{ look: "moody" }],
  boltOn: {
    summary: "options.customScript runs once.",
    api: ["addControl({ id }) -> control.", "addPanel(title) -> body.   refresh() re-renders."],
    reservedShortcuts: ["e"],
    example: "t3template.addPanel('Extra');",
  },
  html: '<!doctype html><html><head><meta charset="utf-8"></head><body><script>app()</script></body></html>',
};

const kit = makeWorkspaceKit({
  core: "/*core*/",
  primitives: [
    primitive("develop", "t3kit.develop={x:'</script>'};"),
    primitive("histogram"),
    primitive("viewer"),
    primitive("links"),
  ],
  templates: [template],
});

const plan = (request: Parameters<typeof kit.planPage>[0]) => {
  const result = kit.planPage(request);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const errorOf = (result: { ok: true } | { ok: false; error: string }) =>
  result.ok ? assert.fail("expected an error") : result.error;

describe("kit pages", () => {
  it("injects the core and requested primitives in load order, before the page's scripts", () => {
    const page = plan({
      html: "<html><head><title>x</title></head><body><script>glue()</script></body></html>",
      kit: ["links", "viewer", "viewer"],
    });
    const html = kit.inject(page.html, page);
    const order = ["_core", "viewer", "links"].map((name) =>
      html.indexOf(`<script data-t3kit="${name}">`),
    );
    assert.isTrue(
      order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)),
      html,
    );
    assert.isTrue(html.indexOf('data-t3kit="links"') < html.indexOf("<title>"));
    assert.notInclude(html, "t3-template-options");
  });

  it("escapes a closing script tag inside a primitive", () => {
    const page = plan({ html: "<p></p>", kit: ["develop"] });
    const html = kit.inject(page.html, page);
    assert.include(html, "t3kit.develop={x:'<\\/script>'};");
    assert.isTrue(html.startsWith("<!doctype html><head><script"));
  });

  it("leaves a page without kit untouched", () => {
    const page = plan({ html: "<p>hi</p>" });
    assert.strictEqual(kit.inject(page.html, page), "<p>hi</p>");
  });

  it("builds a template page with its declared kit plus extras, and escaped options", () => {
    const page = plan({
      template: { id: "photo-develop", options: { title: "</script><b>", look: "moody" } },
      kit: ["viewer"],
    });
    assert.deepEqual(
      page.primitives.map((p) => p.name),
      ["develop", "histogram", "viewer"],
    );
    const html = kit.inject(page.html, page);
    const tag = /<script id="t3-template-options" type="application\/json">(.*?)<\/script>/.exec(
      html,
    );
    assert.isNotNull(tag);
    assert.notInclude(tag![1]!, "<");
    assert.deepEqual(JSON.parse(tag![1]!), { title: "</script><b>", look: "moody" });
    assert.isTrue(html.indexOf("t3-template-options") < html.indexOf("<script>app()"));
    assert.isTrue(html.indexOf('data-t3kit="viewer"') < html.indexOf("t3-template-options"));
  });

  it("injects empty options for a template called without them", () => {
    const page = plan({ template: { id: "photo-develop" } });
    assert.include(
      kit.inject(page.html, page),
      '<script id="t3-template-options" type="application/json">{}</script>',
    );
  });
});

describe("kit request errors", () => {
  it("names unknown primitives and lists the known ones", () => {
    assert.strictEqual(
      errorOf(kit.planPage({ html: "<p></p>", kit: ["viewer", "warp", "warp"] })),
      "Unknown kit primitives: warp. Known primitives: develop, histogram, viewer, links.",
    );
  });

  it("names an unknown template and lists the installed ones", () => {
    assert.include(
      errorOf(kit.planPage({ template: { id: "video" } })),
      'Unknown template "video". Known templates: photo-develop.',
    );
  });

  it("forbids html alongside a template, and requires one of them", () => {
    assert.include(
      errorOf(kit.planPage({ html: "<p></p>", template: { id: "photo-develop" } })),
      "not both",
    );
    assert.include(errorOf(kit.planPage({ kit: ["viewer"] })), "Pass html");
  });

  it("reports every invalid option with its exact path", () => {
    const error = errorOf(
      kit.planPage({
        template: {
          id: "photo-develop",
          options: { look: "dark", strength: 2, panels: ["light", 3], titel: "x", title: 1 },
        },
      }),
    );
    assert.include(error, 'template.options.look: expected one of "neutral", "moody", got "dark"');
    assert.include(error, "template.options.strength: must be at most 1, got 2");
    assert.include(error, 'template.options.panels[1]: expected one of "light", "color", got 3');
    assert.include(
      error,
      "template.options.titel: unknown option; this template takes title, look",
    );
    assert.include(error, "template.options.title: expected a string, got 1");
  });

  it("checks the declared properties of objects inside options", () => {
    const markers = {
      options: {
        markers: {
          type: "array",
          items: {
            type: "object",
            properties: { time: { type: "number", minimum: 0 }, label: { type: "string" } },
            required: ["time"],
          },
        },
      },
    } as const;
    assert.deepEqual(
      validateTemplateOptions(markers, { markers: [{ time: 2, label: "Beat" }, { time: 0 }] }),
      [],
    );
    assert.deepEqual(
      validateTemplateOptions(markers, {
        markers: [{ label: "Open" }, { time: -1, text: "x" }],
      }),
      [
        "template.options.markers[0].time: required",
        "template.options.markers[1].time: must be at least 0, got -1",
        "template.options.markers[1].text: unknown key; expected time, label",
      ],
    );
  });

  it("accepts a customScript bolt-on without the template declaring it", () => {
    assert.isTrue(
      kit.planPage({
        template: { id: "photo-develop", options: { customScript: "t3template.addPanel('x')" } },
      }).ok,
    );
    assert.include(
      errorOf(kit.planPage({ template: { id: "photo-develop", options: { customScript: 1 } } })),
      "template.options.customScript: expected a string",
    );
  });
});

describe("kit docs", () => {
  it("returns primitive headers and template details without the template html", () => {
    const docs = kit.docs(["histogram", "photo-develop"]);
    assert.isTrue(docs.ok);
    if (!docs.ok) return;
    assert.deepEqual(docs.value.primitives, [
      { name: "histogram", docs: "t3kit.histogram: docs." },
    ]);
    assert.strictEqual(docs.value.templates[0]?.id, "photo-develop");
    assert.isFalse("html" in docs.value.templates[0]!);
    assert.deepEqual(docs.value.templates[0]?.boltOn, template.boltOn);
  });

  it("returns everything without names, and rejects unknown names", () => {
    const all = kit.docs();
    assert.isTrue(all.ok && all.value.primitives.length === 4 && all.value.templates.length === 1);
    assert.include(errorOf(kit.docs(["nope"])), "Unknown kit names: nope.");
  });

  it("keeps the shipped catalog compact, with every template and primitive", () => {
    // It rides in every workspace_mutate description: one line per template (with its own
    // bolt-on calls), one bolt-on line, one line per primitive.
    assert.isAtMost(workspaceKit.catalog.length, 2_500);
    for (const name of [...workspaceKit.templateIds, ...workspaceKit.primitiveNames])
      assert.include(workspaceKit.catalog, `- ${name}: `);
  });

  it("lists every template's bolt-on calls once and points at their docs", () => {
    const listed = (id: string) =>
      workspaceKit.catalog
        .split("\n")
        .find((line) => line.startsWith(`- ${id}: `))
        ?.split(" Bolt-on: ")[1] ?? "";
    const shared = /window\.t3template \(([^)]*), plus each/.exec(workspaceKit.catalog)?.[1] ?? "";
    assert.include(shared, "addControl");
    for (const template of GENERATED_KIT.templates) {
      for (const call of boltOnCalls(template.boltOn.api)) {
        assert.isTrue(
          shared.split(", ").includes(call) || listed(template.id).includes(call),
          `${template.id}: ${call} is not in the catalog`,
        );
      }
    }
    assert.include(listed("photo-develop"), "addImageStage");
    assert.include(workspaceKit.catalog, "boltOn in workspace_kit_docs");
  });

  it("reads bolt-on call names from api lines, several per line", () => {
    assert.deepEqual(
      boltOnCalls([
        "addControl({ id }) -> control.",
        "info (third argument) = { phase }.",
        "getValues() -> {}.   setValues(partial) -> values.",
        "addPreset(name, values) / applyPreset(name) applies it.",
        "ctx.crop = { x, y }.",
        "addControl again(",
      ]),
      ["addControl", "getValues", "setValues", "addPreset", "applyPreset"],
    );
  });

  it("lists a template by what it is and when to pick it", () => {
    assert.strictEqual(
      templateCatalogLine(
        "Editor for one photo: crop, grade. History too. Pick it for any photo edit. Exports.",
      ),
      "Editor for one photo. Pick it for any photo edit.",
    );
    assert.strictEqual(templateCatalogLine("Grade one photo."), "Grade one photo.");
  });
});

describe("shipped templates", () => {
  const defaultsOf = (template: KitTemplate) =>
    Object.fromEntries(
      Object.entries(template.options).flatMap(([key, spec]) =>
        spec.default === undefined ? [] : [[key, spec.default]],
      ),
    );

  it("are installed and documented", () => {
    assert.isNotEmpty(workspaceKit.templateIds);
    const docs = workspaceKit.docs(workspaceKit.templateIds);
    assert.isTrue(docs.ok);
    if (!docs.ok) return;
    assert.deepEqual(
      docs.value.templates.map((t) => t.id),
      workspaceKit.templateIds,
    );
  });

  it.each(GENERATED_KIT.templates.map((template) => [template.id, template] as const))(
    "%s: its defaults and every example build a page",
    (_id, template) => {
      assert.isNotEmpty(template.examples, "a template ships examples");
      for (const options of [defaultsOf(template), ...template.examples]) {
        const where = `${template.id} ${JSON.stringify(options)}`;
        assert.deepEqual(validateTemplateOptions(template, options), [], where);
        const page = workspaceKit.planPage({
          template: { id: template.id, options: options as Record<string, unknown> },
        });
        if (!page.ok) return assert.fail(`${where}: ${page.error}`);
        const html = workspaceKit.inject(page.value.html, page.value);
        for (const name of template.kit)
          assert.include(html, `<script data-t3kit="${name}">`, where);
        const tag =
          /<script id="t3-template-options" type="application\/json">(.*?)<\/script>/s.exec(html);
        assert.isNotNull(tag, where);
        assert.deepEqual(JSON.parse(tag![1]!), options, where);
        assert.include(template.html, "t3-template-options", `${template.id} reads its options`);
      }
    },
  );
});
