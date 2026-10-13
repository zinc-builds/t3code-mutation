import { validateTemplateOptions } from "./templateOptions.ts";
import type { KitPrimitive, KitSource, KitTemplate } from "./types.ts";

/** A kit lookup either succeeds or says exactly what to fix. */
export type KitResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

const ok = <A>(value: A): KitResult<A> => ({ ok: true, value });
const fail = <A>(error: string): KitResult<A> => ({ ok: false, error });

/** What `workspace_mutate` asks for: its own page or a template, plus kit primitives. */
export interface WorkspacePageRequest {
  readonly html?: string | undefined;
  readonly kit?: ReadonlyArray<string> | undefined;
  readonly template?:
    | { readonly id: string; readonly options?: Readonly<Record<string, unknown>> | undefined }
    | undefined;
}

/** A checked request: the page to prepare, and what to inject into it afterwards. */
export interface WorkspacePagePlan {
  /** The agent's html, or the template's. */
  readonly html: string;
  readonly primitives: ReadonlyArray<KitPrimitive>;
  /** Present for a template page; injected as `#t3-template-options`. */
  readonly template?: { readonly id: string; readonly options: Readonly<Record<string, unknown>> };
}

export interface KitDocs {
  readonly primitives: ReadonlyArray<{ readonly name: string; readonly docs: string }>;
  readonly templates: ReadonlyArray<Omit<KitTemplate, "html">>;
}

const listOr = (names: ReadonlyArray<string>, none: string) =>
  names.length === 0 ? none : names.join(", ");

const templateDocs = ({ html: _html, ...template }: KitTemplate) => template;

// A literal `</script` inside an inline script would end it early.
const inlineScript = (attributes: string, source: string) =>
  `<script ${attributes}>${source.replace(/<\/script/gi, "<\\/script")}</script>`;

/** Lookups, docs, and page assembly over one kit (the generated one, or a fixture in tests). */
export function makeWorkspaceKit(source: KitSource) {
  const primitivesByName = new Map(source.primitives.map((p) => [p.name, p]));
  const templatesById = new Map(source.templates.map((t) => [t.id, t]));
  const primitiveNames = source.primitives.map((p) => p.name);
  const templateIds = source.templates.map((t) => t.id);

  /**
   * One line per template and primitive, for the `workspace_mutate`
   * description; `docs` returns the details.
   */
  const catalog = [
    "Templates (template: {id, options}):",
    ...(source.templates.length === 0
      ? ["- none installed yet"]
      : source.templates.map((t) => `- ${t.id}: ${t.summary}`)),
    "Kit primitives (kit: [names], then window.t3kit.<name>.create(el, options)):",
    ...source.primitives.map((p) => `- ${p.name}: ${p.summary}`),
  ].join("\n");

  /** The requested primitives, deduplicated, in the kit's load order. */
  const resolvePrimitives = (
    names: ReadonlyArray<string>,
  ): KitResult<ReadonlyArray<KitPrimitive>> => {
    const unknown = [...new Set(names.filter((name) => !primitivesByName.has(name)))];
    if (unknown.length > 0) {
      return fail(
        `Unknown kit primitives: ${unknown.join(", ")}. Known primitives: ${listOr(primitiveNames, "none")}.`,
      );
    }
    const wanted = new Set(names);
    return ok(source.primitives.filter((p) => wanted.has(p.name)));
  };

  const findTemplate = (id: string): KitResult<KitTemplate> => {
    const template = templatesById.get(id);
    if (template !== undefined) return ok(template);
    return fail(
      `Unknown template "${id}". Known templates: ${listOr(templateIds, "none are installed yet, so pass html (with kit) instead")}.`,
    );
  };

  /**
   * Docs headers for primitives, and summary, kit and options for templates.
   * `names` mixes primitive names and template ids; omitted, it means everything.
   */
  const docs = (names?: ReadonlyArray<string>): KitResult<KitDocs> => {
    const unknown = [
      ...new Set(
        (names ?? []).filter((name) => !primitivesByName.has(name) && !templatesById.has(name)),
      ),
    ];
    if (unknown.length > 0) {
      return fail(
        `Unknown kit names: ${unknown.join(", ")}. Primitives: ${listOr(primitiveNames, "none")}. Templates: ${listOr(templateIds, "none")}.`,
      );
    }
    const wanted = names === undefined ? undefined : new Set(names);
    return ok({
      primitives: source.primitives
        .filter((p) => wanted === undefined || wanted.has(p.name))
        .map(({ name, docs }) => ({ name, docs })),
      templates: source.templates
        .filter((t) => wanted === undefined || wanted.has(t.id))
        .map(templateDocs),
    });
  };

  /**
   * Checks a request. A template is the whole page, so `html` alongside one
   * is an error rather than ignored; the agent extends a template with
   * `options.customScript`. The template's own kit is merged with `kit`.
   */
  const planPage = (request: WorkspacePageRequest): KitResult<WorkspacePagePlan> => {
    const requestedKit = request.kit ?? [];
    if (request.template === undefined) {
      if (request.html === undefined || request.html.trim() === "") {
        return fail("Pass html (optionally with kit), or a template.");
      }
      const primitives = resolvePrimitives(requestedKit);
      if (!primitives.ok) return primitives;
      return ok({ html: request.html, primitives: primitives.value });
    }
    if (request.html !== undefined) {
      return fail(
        "Pass either html or template, not both: a template is the whole page. Extend it with template.options.customScript instead.",
      );
    }
    const template = findTemplate(request.template.id);
    if (!template.ok) return template;
    const options = request.template.options ?? {};
    const problems = validateTemplateOptions(template.value, options);
    if (problems.length > 0) {
      return fail(`Invalid options for template "${template.value.id}": ${problems.join("; ")}.`);
    }
    const primitives = resolvePrimitives([...template.value.kit, ...requestedKit]);
    if (!primitives.ok) return primitives;
    return ok({
      html: template.value.html,
      primitives: primitives.value,
      template: { id: template.value.id, options },
    });
  };

  /**
   * Inserts the plan's primitives (after the kit's shared core, if any) and
   * the template options at the start of the document head, so they run
   * before the page's own scripts. T3 then inserts the workspace bridge
   * ahead of them.
   */
  const inject = (html: string, plan: WorkspacePagePlan): string => {
    const scripts = [
      ...(plan.primitives.length > 0 && source.core !== null
        ? [inlineScript('data-t3kit="_core"', source.core)]
        : []),
      ...plan.primitives.map((p) => inlineScript(`data-t3kit="${p.name}"`, p.source)),
      ...(plan.template === undefined
        ? []
        : [
            // `\u003c` keeps the JSON valid and rules out a closing tag inside it.
            `<script id="t3-template-options" type="application/json">${JSON.stringify(plan.template.options).replace(/</g, "\\u003c")}</script>`,
          ]),
    ];
    if (scripts.length === 0) return html;
    const markup = scripts.join("");
    const headOpen = /<head(?:\s[^>]*)?>/i.exec(html);
    if (headOpen) {
      const at = headOpen.index + headOpen[0].length;
      return html.slice(0, at) + markup + html.slice(at);
    }
    return `<!doctype html><head>${markup}</head>${html}`;
  };

  return {
    primitiveNames,
    templateIds,
    catalog,
    resolvePrimitives,
    findTemplate,
    docs,
    planPage,
    inject,
  };
}

export type WorkspaceKit = ReturnType<typeof makeWorkspaceKit>;
