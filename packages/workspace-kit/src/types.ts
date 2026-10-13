/** A kit primitive: a classic script that registers `window.t3kit.<name>`. */
export interface KitPrimitive {
  readonly name: string;
  /** One line for the agent's catalog. */
  readonly summary: string;
  /** The file's docs header without comment markers: the API agents read. */
  readonly docs: string;
  readonly source: string;
}

/** One key of a template's options, as `template.json` declares it. */
export interface TemplateOptionSpec {
  readonly type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  readonly enum?: ReadonlyArray<unknown>;
  readonly items?: TemplateOptionSpec;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: unknown;
  readonly description?: string;
}

/** A complete workspace page composed from kit primitives. */
export interface KitTemplate {
  readonly id: string;
  readonly title: string;
  /** One line for the agent's catalog: when to pick this template. */
  readonly summary: string;
  /** Primitives T3 injects before the template's own scripts. */
  readonly kit: ReadonlyArray<string>;
  readonly options: Readonly<Record<string, TemplateOptionSpec>>;
  readonly examples: ReadonlyArray<unknown>;
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
