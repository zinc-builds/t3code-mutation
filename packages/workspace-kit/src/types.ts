/** A kit primitive: a classic script that registers `window.t3kit.<name>`. */
export interface KitPrimitive {
  readonly name: string;
  /** One line for the agent's catalog. */
  readonly summary: string;
  /** The file's docs header without comment markers: the API agents read. */
  readonly docs: string;
  readonly source: string;
}

/** How the page uses one file of a vendored library (see KitVendor). */
export type KitVendorLoad = "script" | "module" | "bytes";

/** One file taken from a vendored package. */
export interface KitVendorFile {
  /** Its base name in the package, unique within the library: what `bytes(name)` and the exports map key it by. */
  readonly name: string;
  /**
   * Its path in the package, as vendor.json lists it: T3 serves it at that path
   * under the library's URL, and `t3kit.vendor.file(library, path)` names it so.
   */
  readonly path: string;
  /**
   * `script`: a classic script, run in order before the modules. `module`: an
   * ES module, imported; it may import the library's other modules by
   * relative path. `bytes`: binary data (wasm) fetched for the library's init;
   * it never executes.
   */
  readonly load: KitVendorLoad;
  /** The file's text, or base64 for `bytes`. */
  readonly content: string;
}

/**
 * A third-party library baked into the kit from an npm package pinned to an
 * exact version. T3 serves its files and init from one versioned, immutable
 * URL per library (`vendorLibraryPath`); a page that names it carries only the
 * `t3kit.vendor` registry and where to find them.
 */
export interface KitVendor {
  readonly name: string;
  readonly package: string;
  readonly version: string;
  readonly license: string;
  /** A hash of the version, files and init: part of every URL, so a cache can never serve other bytes. */
  readonly hash: string;
  readonly files: ReadonlyArray<KitVendorFile>;
  /** The kit's classic script that turns the files into the page's API (`t3kit.vendor.define`). */
  readonly init: string;
}

/**
 * One key of a template's options, verbatim from `template.json`: a JSON
 * Schema subset. T3 checks the keys typed here; any others ride along for
 * agents to read.
 */
export type TemplateOptionType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"
  | "null";

export interface TemplateOptionSpec {
  /** One type, or several (JSON Schema): the value must match one of them. */
  readonly type?: TemplateOptionType | ReadonlyArray<TemplateOptionType>;
  readonly enum?: ReadonlyArray<unknown>;
  readonly items?: TemplateOptionSpec;
  /** For an object: its keys. Keys it does not declare are rejected. */
  readonly properties?: Readonly<Record<string, TemplateOptionSpec>>;
  /** For an object: the declared keys it must have. */
  readonly required?: ReadonlyArray<string>;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: unknown;
  readonly description?: string;
  readonly [key: string]: unknown;
}

/**
 * How an agent extends a template with `options.customScript`: everything it
 * may call on `window.t3template`, so it never guesses.
 */
export interface TemplateBoltOn {
  /** When the script runs, what its hooks reach (preview, export), and how errors surface. */
  readonly summary: string;
  /** One line per call, with this template's values shape and sizes. */
  readonly api: ReadonlyArray<string>;
  /** Keys the template already binds; a bolt-on toolbar shortcut must avoid them. */
  readonly reservedShortcuts: ReadonlyArray<string>;
  /** A runnable customScript. */
  readonly example: string;
  readonly [key: string]: unknown;
}

/**
 * A template's `template.json`, verbatim: fields T3 does not read, such as
 * bolt-on docs, are kept for agents.
 */
export interface KitTemplateManifest {
  readonly id: string;
  readonly title: string;
  /** One line for the agent's catalog: when to pick this template. */
  readonly summary: string;
  /** Primitives T3 injects before the template's own scripts. */
  readonly kit: ReadonlyArray<string>;
  /** Vendored libraries the page loads with `t3kit.vendor.load(name)`. */
  readonly vendor: ReadonlyArray<string>;
  readonly options: Readonly<Record<string, TemplateOptionSpec>>;
  readonly examples: ReadonlyArray<unknown>;
  readonly boltOn: TemplateBoltOn;
  /**
   * Whether the page projects its toolbar into T3's native chrome. `true`
   * opens a chrome session with an empty seed manifest (the page fills its
   * regions on load through `setChrome`); `false` or absent opens none. An
   * object is the seed manifest itself. Used when the agent passes no chrome;
   * T3 checks the manifest on publish.
   */
  readonly chrome?: boolean | Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** A complete workspace page composed from kit primitives: its manifest and its html. */
export interface KitTemplate extends KitTemplateManifest {
  readonly html: string;
}

/** Everything a kit is built from: what generated.ts holds, or a test fixture. */
export interface KitSource {
  /** Shared helpers loaded before any primitive; null when the kit has none. */
  readonly core: string | null;
  /** The `t3kit.vendor` registry, injected before any vendored library; null when the kit vendors none. */
  readonly vendorRuntime: string | null;
  /** Vendored libraries, by name. */
  readonly vendor: ReadonlyArray<KitVendor>;
  /** In load order. */
  readonly primitives: ReadonlyArray<KitPrimitive>;
  readonly templates: ReadonlyArray<KitTemplate>;
}
