import { validateTemplateOptions } from "./templateOptions.ts";
import type {
  KitPrimitive,
  KitSource,
  KitTemplate,
  KitTemplateManifest,
  KitVendor,
  KitVendorFile,
  KitVendorLoad,
} from "./types.ts";

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
  /** The template's vendored libraries; none for the agent's own page. */
  readonly vendor: ReadonlyArray<KitVendor>;
  /** Present for a template page; injected as `#t3-template-options`. */
  readonly template?: {
    readonly id: string;
    readonly options: Readonly<Record<string, unknown>>;
    /**
     * The template's seed chrome manifest, unchecked (`{}` for `chrome: true`);
     * absent when it declares none.
     */
    readonly chrome?: Readonly<Record<string, unknown>>;
  };
}

export interface KitDocs {
  readonly primitives: ReadonlyArray<{ readonly name: string; readonly docs: string }>;
  readonly templates: ReadonlyArray<KitTemplateManifest>;
}

// Named here rather than imported: the kit has no dependency on the server's tool names.
const KIT_DOCS_TOOL = "workspace_kit_docs";

/**
 * The manifest a template's chrome session opens with: `true` seeds an empty
 * one the page fills through `setChrome`, an object seeds itself.
 */
const templateSeedChrome = (
  chrome: KitTemplateManifest["chrome"],
): Readonly<Record<string, unknown>> | undefined =>
  chrome === true ? {} : chrome === false || chrome === undefined ? undefined : chrome;

const listOr = (names: ReadonlyArray<string>, none: string) =>
  names.length === 0 ? none : names.join(", ");

const templateDocs = ({ html: _html, ...manifest }: KitTemplate): KitTemplateManifest => manifest;

/**
 * A template's catalog line: what it is (its summary up to the first colon or
 * full stop) and when to pick it (the "Pick it ..." sentence). The full
 * summary stays in `docs`.
 */
export function templateCatalogLine(summary: string): string {
  const text = summary.replace(/\s+/g, " ").trim();
  const lead = (/^[^:.]+/.exec(text)?.[0] ?? text).trim();
  const pick = /(?:^|\s)(Pick it\b.*?\.)(?=\s|$)/.exec(text)?.[1];
  return pick === undefined || lead === pick.slice(0, -1) ? `${lead}.` : `${lead}. ${pick}`;
}

/**
 * The `window.t3template` calls a template's bolt-on api documents, in order:
 * each api line holds one or more calls, separated by three spaces or " / ".
 */
export function boltOnCalls(api: ReadonlyArray<string>): ReadonlyArray<string> {
  const calls = api.flatMap((line) =>
    line
      .split(/\s{3,}|\s\/\s/)
      .flatMap((segment) => /^\s*([a-z][A-Za-z0-9]*)\(/.exec(segment)?.[1] ?? []),
  );
  return [...new Set(calls)];
}

/**
 * The tag a template reads its options from. `\u003c` keeps the JSON valid
 * and rules out a closing tag inside it.
 */
export const templateOptionsTag = (options: Readonly<Record<string, unknown>>) =>
  `<script id="t3-template-options" type="application/json">${JSON.stringify(options).replace(/</g, "\\u003c")}</script>`;

// A literal `</script` inside an inline script would end it early.
const inlineScript = (attributes: string, source: string) =>
  `<script ${attributes}>${source.replace(/<\/script/gi, "<\\/script")}</script>`;

/**
 * Where T3 serves vendored library files. Pages hold it as a root-relative
 * path and resolve it against their own URL, so the same stored page loads
 * them from whichever origin serves it: the environment's (directly, over
 * Tailscale or a tunnel, in every client) or the validation browser's.
 */
export const WORKSPACE_VENDOR_ROUTE = "/api/workspace-vendor/";

/** A library's directory under the vendor route: its name, pinned version and content hash. */
const vendorLibraryPath = (library: KitVendor) =>
  `${library.name}/${library.version}/${library.hash}/`;

/** The content type a vendored file is served with, and the type `t3kit.vendor.file` gives its Blob. */
const vendorContentType = (load: KitVendorLoad, path: string) =>
  load !== "bytes"
    ? "text/javascript; charset=utf-8"
    : path.endsWith(".wasm")
      ? "application/wasm"
      : "application/octet-stream";

/** One file of a vendored library as the vendor route serves it. */
interface VendorServedFile {
  /** Its path under the vendor route. */
  readonly path: string;
  readonly contentType: string;
  /** The library's hash: the bytes at a path never change, since the hash is in it. */
  readonly etag: string;
  readonly read: () => Uint8Array;
}

const fromBase64 = (base64: string) => {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
};

/** Every file the vendor route serves for a library: its package files, then the kit's init.js. */
export function vendorLibraryFiles(library: KitVendor): ReadonlyArray<VendorServedFile> {
  const dir = vendorLibraryPath(library);
  const etag = `"${library.hash}"`;
  const encoder = new TextEncoder();
  return [
    ...library.files.map((file: KitVendorFile) => ({
      path: `${dir}${file.path}`,
      contentType: vendorContentType(file.load, file.path),
      etag,
      read: () => (file.load === "bytes" ? fromBase64(file.content) : encoder.encode(file.content)),
    })),
    {
      path: `${dir}init.js`,
      contentType: vendorContentType("script", "init.js"),
      etag,
      read: () => encoder.encode(library.init),
    },
  ];
}

/**
 * The markup that vendors libraries into a page: a manifest of where each
 * library's files are (under `baseUrl`, resolved against the page's URL) and
 * the `t3kit.vendor` registry that loads them on `load(name)`.
 */
export function vendorScripts(
  runtime: string,
  libraries: ReadonlyArray<KitVendor>,
  baseUrl: string,
): string {
  if (libraries.length === 0) return "";
  const manifest = Object.fromEntries(
    libraries.map((library) => [
      library.name,
      {
        url: `${baseUrl}${vendorLibraryPath(library)}`,
        files: library.files.map((file) => ({
          name: file.name,
          path: file.path,
          load: file.load,
          type: vendorContentType(file.load, file.path),
        })),
      },
    ]),
  );
  // `\u003c` keeps the JSON valid and rules out a closing tag inside it.
  const json = JSON.stringify(manifest).replace(/</g, "\\u003c");
  return `<script type="application/json" id="t3kit-vendor">${json}</script>${inlineScript('data-t3kit="_vendor"', runtime)}`;
}

/** Lookups, docs, and page assembly over one kit (the generated one, or a fixture in tests). */
export function makeWorkspaceKit(source: KitSource) {
  const primitivesByName = new Map(source.primitives.map((p) => [p.name, p]));
  const templatesById = new Map(source.templates.map((t) => [t.id, t]));
  // A template that vendors a library the kit lacks is a broken kit, not a bad request.
  const vendorByName = new Map(source.vendor.map((v) => [v.name, v]));
  const vendorByTemplate = new Map(
    source.templates.map((t) => [
      t.id,
      t.vendor.map((name) => {
        const library = vendorByName.get(name);
        if (library === undefined) {
          throw new Error(`Template "${t.id}" vendors "${name}", which the kit lacks.`);
        }
        return library;
      }),
    ]),
  );
  const vendorRuntime = source.vendorRuntime;
  if (source.vendor.length > 0 && vendorRuntime === null) {
    throw new Error("The kit vendors libraries but has no vendor runtime.");
  }
  // Read once, on first request: the route and validation share the bytes.
  const vendorFilesByPath = new Map(
    source.vendor.flatMap(vendorLibraryFiles).map((file) => [file.path, file]),
  );
  const vendorBodies = new Map<string, Uint8Array>();
  /** A file the vendor route serves, by its path under the route; undefined for any other path. */
  const vendorFile = (path: string) => {
    const file = vendorFilesByPath.get(path);
    if (file === undefined) return undefined;
    let body = vendorBodies.get(path);
    if (body === undefined) {
      body = file.read();
      vendorBodies.set(path, body);
    }
    return { path, contentType: file.contentType, etag: file.etag, body };
  };
  const primitiveNames = source.primitives.map((p) => p.name);
  const templateIds = source.templates.map((t) => t.id);

  // Bolt-on calls every template has are listed once; each template line adds its own.
  const callsByTemplate = new Map(source.templates.map((t) => [t.id, boltOnCalls(t.boltOn.api)]));
  const sharedCalls = [...callsByTemplate.values()].reduce<ReadonlyArray<string>>(
    (shared, calls, index) => (index === 0 ? calls : shared.filter((c) => calls.includes(c))),
    [],
  );
  const templateLine = (t: KitTemplate) => {
    const own = (callsByTemplate.get(t.id) ?? []).filter((c) => !sharedCalls.includes(c));
    const line = `- ${t.id}: ${templateCatalogLine(t.summary)}`;
    return own.length === 0 ? line : `${line} Bolt-on: ${own.join(", ")}.`;
  };

  /**
   * One line per template and primitive, for the `workspace_mutate`
   * description; `docs` returns the details.
   */
  const catalog = [
    "Templates (template: {id, options}):",
    ...(source.templates.length === 0
      ? ["- none installed yet"]
      : [
          ...source.templates.map(templateLine),
          `Bolt-ons: options.customScript calls window.t3template (${sharedCalls.join(", ")}, plus each template's own above), seeded by options.controls. Use only what the template's boltOn in ${KIT_DOCS_TOOL} lists; read its signatures, reservedShortcuts and runnable example first.`,
        ]),
    "Kit primitives (kit: [names], then window.t3kit.<camelCasedName>.create(el, options)):",
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
      return ok({ html: request.html, primitives: primitives.value, vendor: [] });
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
    const chrome = templateSeedChrome(template.value.chrome);
    return ok({
      html: template.value.html,
      primitives: primitives.value,
      vendor: vendorByTemplate.get(template.value.id) ?? [],
      template: {
        id: template.value.id,
        options,
        ...(chrome === undefined ? {} : { chrome }),
      },
    });
  };

  /**
   * Inserts the vendor registry for the plan's libraries (their files load
   * from WORKSPACE_VENDOR_ROUTE on `t3kit.vendor.load`), its primitives (after the kit's
   * shared core, if any) and the template options at the start of the
   * document head, so they run before the page's own scripts. T3 then inserts
   * the workspace bridge ahead of them.
   */
  const inject = (html: string, plan: WorkspacePagePlan): string => {
    const scripts = [
      ...(plan.vendor.length > 0 && vendorRuntime !== null
        ? [vendorScripts(vendorRuntime, plan.vendor, WORKSPACE_VENDOR_ROUTE)]
        : []),
      ...(plan.primitives.length > 0 && source.core !== null
        ? [inlineScript('data-t3kit="_core"', source.core)]
        : []),
      ...plan.primitives.map((p) => inlineScript(`data-t3kit="${p.name}"`, p.source)),
      ...(plan.template === undefined ? [] : [templateOptionsTag(plan.template.options)]),
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
    vendorFile,
  };
}

export type WorkspaceKit = ReturnType<typeof makeWorkspaceKit>;
