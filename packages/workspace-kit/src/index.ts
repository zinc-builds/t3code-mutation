/**
 * The workspace kit: pro-grade UI primitives and whole-page templates that T3
 * injects into mutation workspaces, so an agent writes glue (or only options)
 * instead of a whole application. Sources are baked into generated.ts by
 * scripts/generate.mjs because the server ships as a bundle.
 */
import { GENERATED_KIT } from "./generated.ts";
import { makeWorkspaceKit } from "./kit.ts";

/** The kit T3 ships. */
export const workspaceKit = makeWorkspaceKit(GENERATED_KIT);

export {
  boltOnCalls,
  makeWorkspaceKit,
  templateCatalogLine,
  templateOptionsTag,
  type KitDocs,
  type KitResult,
  type WorkspaceKit,
  type WorkspacePagePlan,
  type WorkspacePageRequest,
} from "./kit.ts";
export { TEMPLATE_CUSTOM_SCRIPT_ERROR_MARKER, validateTemplateOptions } from "./templateOptions.ts";
export type {
  KitPrimitive,
  KitSource,
  KitTemplate,
  KitTemplateManifest,
  TemplateBoltOn,
  TemplateOptionSpec,
  TemplateOptionType,
} from "./types.ts";
