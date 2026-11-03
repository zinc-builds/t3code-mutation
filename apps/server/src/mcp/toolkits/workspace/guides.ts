import { HTML_RENDER_THEME_GUIDE } from "@t3tools/shared/htmlRender";
import {
  WORKSPACE_KIT_DOCS_TOOL_NAME,
  WORKSPACE_PAGE_GUIDE,
} from "@t3tools/shared/mutationWorkspace";
import { WORKSPACE_CHROME_GUIDE } from "@t3tools/shared/mutationWorkspaceChrome";

// Every tool description costs context on every turn, so depth lives here and agents ask for it.
export const WORKSPACE_GUIDES: Readonly<Record<string, string>> = {
  "build-guide": `Build it the fastest way that fits, in this order. 1) A template, when one matches the task: pass template: {id, options} and no html; it is a complete pro app ready in seconds, and options.customScript (JS run with (t3template, options)) bolts on anything it lacks, using only the calls in that template's boltOn docs. 2) Otherwise kit primitives plus glue: pass kit: [names] and write only the layout and wiring in html; T3 injects each primitive as window.t3kit.<name> before your scripts, at no cost to your output. 3) Only when neither covers the task, write the whole interface from scratch. Call ${WORKSPACE_KIT_DOCS_TOOL_NAME} with the names you will use for their exact APIs and options before writing glue; never hand-roll what a primitive does.`,
  "page-guide": `A page you write is one self-contained document with inline <style> and <script>; remote http(s) libraries load as-is. ${WORKSPACE_PAGE_GUIDE} ${HTML_RENDER_THEME_GUIDE}`,
  "chrome-guide": `Declare the app's toolbar, sidebar, and inspector with chrome so T3 renders them natively and the page only needs its canvas or timeline. ${WORKSPACE_CHROME_GUIDE} A template that declares its own chrome gets it when you omit this; passing chrome replaces the template's.`,
  "validation-guide": `T3 boots the published page itself and returns what broke in the result's validation, so do not screenshot or test it yourself; when validation lists errors, fix them with another call. validation.notValidated names what it could not check, such as media its browser cannot decode; those are not errors to fix. "boot" loads the page with your assets for a few seconds and reports uncaught exceptions, console errors, customScript failures, and setChrome patches T3 would reject. "full" then also calls window.t3template.export() (up to 6 s; its files are captured, not delivered to the user) and dry-runs each ffmpeg command the export returns against your assets with this machine's ffmpeg (0.5 s of output each, up to 4 s in all; skipped when ffmpeg is not installed). Default: "full" for a template with options.customScript, since bolt-ons most often break an export that loads fine; "boot" otherwise. Pass "full" after changing what an export reads; pass "boot" to skip the export while iterating on layout.`,
};

const TEMPLATE_CATEGORIES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  [
    "Photo, video and audio",
    ["photo-develop", "social-crop", "video-edit", "audio-edit", "transcript-cut"],
  ],
  [
    "Design",
    [
      "poster-design",
      "slide-deck",
      "3d-viewer",
      "design-review",
      "component-playground",
      "token-studio",
    ],
  ],
  ["Data", ["data-explore", "sql-workbench"]],
  ["Code and debugging", ["log-trace", "profile-flame", "merge-resolve"]],
];

/** The first tier of the kit docs: the catalog with its templates grouped by what they work on. */
export const workspaceKitIndex = (catalog: string): string => {
  const lines = catalog.split("\n");
  const start = lines.findIndex((line) => line.startsWith("- "));
  const end = lines.findIndex((line, index) => index > start && !line.startsWith("- "));
  if (start === -1 || end === -1) return catalog;
  const templates = lines.slice(start, end);
  const idOf = (line: string) => line.slice(2, line.indexOf(":"));
  const placed = new Set(TEMPLATE_CATEGORIES.flatMap(([, ids]) => ids));
  const groups: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ...TEMPLATE_CATEGORIES.map(
      ([name, ids]) => [name, templates.filter((line) => ids.includes(idOf(line)))] as const,
    ),
    ["Other", templates.filter((line) => !placed.has(idOf(line)))],
  ];
  return [
    ...lines.slice(0, start),
    ...groups.flatMap(([name, entries]) => (entries.length === 0 ? [] : [`${name}:`, ...entries])),
    ...lines.slice(end),
  ].join("\n");
};
