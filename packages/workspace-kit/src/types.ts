/** A kit primitive: a classic script that registers `window.t3kit.<name>`. */
export interface KitPrimitive {
  readonly name: string;
  /** One line for the agent's catalog. */
  readonly summary: string;
  /** The file's docs header without comment markers: the API agents read. */
  readonly docs: string;
  readonly source: string;
}

/**
 * One key of a template's options, verbatim from `template.json`: a JSON
 * Schema subset. T3 checks the keys typed here; any others ride along for
 * agents to read.
 */
export interface TemplateOptionSpec {
  readonly type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
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
  readonly options: Readonly<Record<string, TemplateOptionSpec>>;
  readonly examples: ReadonlyArray<unknown>;
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
  /** In load order. */
  readonly primitives: ReadonlyArray<KitPrimitive>;
  readonly templates: ReadonlyArray<KitTemplate>;
}
