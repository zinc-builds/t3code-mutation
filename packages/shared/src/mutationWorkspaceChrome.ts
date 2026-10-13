/**
 * The chrome manifest of a mutation workspace: the toolbar, sidebar, and
 * inspector an agent declares with `workspace_mutate({ chrome })`, which T3
 * renders with its own components around the page, so the app itself
 * reshapes instead of hosting a foreign panel. T3 owns the control values:
 * native controls change them, the page reads them over the bridge
 * (`controls` and `command` notifications) and can reshape the chrome live
 * with `t3.workspace.setChrome(patch)`.
 *
 * Values persist in the thread's one workspace state object, as
 * `{ controls, page }` (see `workspaceStateEnvelope`).
 */

/** JSON bytes a manifest passed to `workspace_mutate` may take; it rides in the tool result. */
export const WORKSPACE_CHROME_MAX_BYTES = 6_000;
/** JSON bytes of chrome a page may set live; larger, since sidebar thumbnails come from the page. */
export const WORKSPACE_CHROME_PATCH_MAX_BYTES = 512_000;

const MAX_TOOLBAR_ITEMS = 24;
const MAX_MENU_ITEMS = 24;
const MAX_OPTIONS = 16;
const MAX_SIDEBAR_SECTIONS = 6;
const MAX_SIDEBAR_ITEMS = 100;
const MAX_INSPECTOR_SECTIONS = 10;
const MAX_INSPECTOR_CONTROLS = 20;
const MAX_LABEL_LENGTH = 48;
const MAX_THUMBNAIL_LENGTH = 64_000;

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const ICON_PATTERN = /^[a-z0-9-]{1,64}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const SHORT_COLOR_PATTERN = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const THUMBNAIL_PATTERN = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export type WorkspaceChromeValue = number | string | boolean | null;
export type WorkspaceChromeValues = Readonly<Record<string, WorkspaceChromeValue>>;

export interface WorkspaceChromeOption {
  readonly value: string;
  readonly label: string;
  readonly icon?: string;
  readonly shortcut?: string;
}

export interface WorkspaceChromeMenuItem {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
}

export type WorkspaceToolbarItem =
  | {
      readonly type: "button";
      readonly id: string;
      readonly label: string;
      readonly icon?: string;
      readonly shortcut?: string;
    }
  | {
      readonly type: "toggle";
      readonly id: string;
      readonly label: string;
      readonly icon?: string;
      readonly shortcut?: string;
      readonly value: boolean;
    }
  | {
      readonly type: "segmented";
      readonly id: string;
      readonly label: string;
      readonly options: ReadonlyArray<WorkspaceChromeOption>;
      readonly value: string;
    }
  | {
      readonly type: "menu";
      readonly id: string;
      readonly label: string;
      readonly icon?: string;
      readonly items: ReadonlyArray<WorkspaceChromeMenuItem>;
    }
  | { readonly type: "separator" };

export interface WorkspaceSidebarItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly icon?: string;
  /** A data:image URL, usually set by the page with setChrome. */
  readonly thumbnail?: string;
}

/** A titled list in the sidebar; its value is the selected item's id. */
export interface WorkspaceSidebarSection {
  readonly id: string;
  readonly title: string;
  readonly items: ReadonlyArray<WorkspaceSidebarItem>;
  readonly value: string | null;
}

export type WorkspaceInspectorControl =
  | {
      readonly type: "slider";
      readonly id: string;
      readonly label: string;
      readonly min: number;
      readonly max: number;
      readonly step: number;
      readonly value: number;
      readonly unit?: string;
    }
  | {
      readonly type: "number";
      readonly id: string;
      readonly label: string;
      readonly min?: number;
      readonly max?: number;
      readonly step: number;
      readonly value: number;
      readonly unit?: string;
    }
  | {
      readonly type: "select" | "segmented";
      readonly id: string;
      readonly label: string;
      readonly options: ReadonlyArray<WorkspaceChromeOption>;
      readonly value: string;
    }
  | {
      readonly type: "toggle";
      readonly id: string;
      readonly label: string;
      readonly value: boolean;
    }
  | { readonly type: "color"; readonly id: string; readonly label: string; readonly value: string }
  | {
      readonly type: "button";
      readonly id: string;
      readonly label: string;
      readonly icon?: string;
    };

export interface WorkspaceInspectorSection {
  readonly title: string;
  readonly controls: ReadonlyArray<WorkspaceInspectorControl>;
}

/**
 * A validated manifest. Every value-bearing entry carries its default as
 * `value`; the current values live beside it in `WorkspaceChromeValues`.
 */
export interface WorkspaceChrome {
  readonly toolbar?: ReadonlyArray<WorkspaceToolbarItem>;
  readonly sidebar?: ReadonlyArray<WorkspaceSidebarSection>;
  readonly inspector?: ReadonlyArray<WorkspaceInspectorSection>;
}

export type WorkspaceChromeReadResult =
  | { readonly ok: true; readonly chrome: WorkspaceChrome }
  | { readonly ok: false; readonly error: string };

class ChromeError extends Error {}

function fail(path: string, problem: string): never {
  throw new ChromeError(`${path}: ${problem}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string, max: number): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > max) fail(path, `at most ${max} entries`);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string");
  return value.trim().slice(0, MAX_LABEL_LENGTH);
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path);
}

function id(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail(path, "must be 1-64 letters, digits, or _ . : -");
  }
  return value;
}

function icon(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ICON_PATTERN.test(value)) {
    fail(path, 'must be a lucide icon name such as "crop"');
  }
  return value;
}

function shortcut(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || parseWorkspaceShortcut(value) === undefined) {
    fail(path, 'must be a shortcut such as "mod+z", "shift+r", or "v"');
  }
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

function optionalFinite(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : finite(value, path);
}

function clamp(value: number, min: number | undefined, max: number | undefined) {
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));
}

function normalizeColor(value: string): string | undefined {
  if (COLOR_PATTERN.test(value)) return value.toLowerCase();
  const short = SHORT_COLOR_PATTERN.exec(value);
  return short
    ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
    : undefined;
}

/** `T` with its possibly-undefined keys made optional instead. */
type Compact<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drops undefined keys, so normalized manifests stay small and comparable. */
function compact<T extends Record<string, unknown>>(value: T): Compact<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Compact<T>;
}

function options(value: unknown, path: string): ReadonlyArray<WorkspaceChromeOption> {
  const entries = list(value, path, MAX_OPTIONS);
  if (entries.length === 0) fail(path, "needs at least one option");
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const at = `${path}[${index}]`;
    const option =
      typeof entry === "string"
        ? { value: text(entry, at), label: text(entry, at) }
        : (() => {
            const raw = record(entry, at);
            const optionValue = text(raw.value, `${at}.value`);
            return compact({
              value: optionValue,
              label: optionalText(raw.label, `${at}.label`) ?? optionValue,
              icon: icon(raw.icon, `${at}.icon`),
              shortcut: shortcut(raw.shortcut, `${at}.shortcut`),
            });
          })();
    if (seen.has(option.value)) fail(at, `duplicate option "${option.value}"`);
    seen.add(option.value);
    return option;
  });
}

function chosen(value: unknown, choices: ReadonlyArray<WorkspaceChromeOption>): string {
  return choices.find((option) => option.value === value)?.value ?? choices[0]!.value;
}

function toolbarItem(value: unknown, path: string): WorkspaceToolbarItem {
  const raw = record(value, path);
  switch (raw.type) {
    case "separator":
      return { type: "separator" };
    case "button":
      return compact({
        type: "button" as const,
        id: id(raw.id, `${path}.id`),
        label: text(raw.label, `${path}.label`),
        icon: icon(raw.icon, `${path}.icon`),
        shortcut: shortcut(raw.shortcut, `${path}.shortcut`),
      });
    case "toggle":
      return compact({
        type: "toggle" as const,
        id: id(raw.id, `${path}.id`),
        label: text(raw.label, `${path}.label`),
        icon: icon(raw.icon, `${path}.icon`),
        shortcut: shortcut(raw.shortcut, `${path}.shortcut`),
        value: raw.value === true,
      });
    case "segmented": {
      const choices = options(raw.options, `${path}.options`);
      return {
        type: "segmented",
        id: id(raw.id, `${path}.id`),
        label: text(raw.label, `${path}.label`),
        options: choices,
        value: chosen(raw.value, choices),
      };
    }
    case "menu":
      return compact({
        type: "menu" as const,
        id: id(raw.id, `${path}.id`),
        label: text(raw.label, `${path}.label`),
        icon: icon(raw.icon, `${path}.icon`),
        items: list(raw.items, `${path}.items`, MAX_MENU_ITEMS).map((item, index) => {
          const at = `${path}.items[${index}]`;
          const entry = record(item, at);
          return compact({
            id: id(entry.id, `${at}.id`),
            label: text(entry.label, `${at}.label`),
            shortcut: shortcut(entry.shortcut, `${at}.shortcut`),
          });
        }),
      });
    default:
      return fail(
        `${path}.type`,
        'must be "button", "toggle", "segmented", "menu", or "separator"',
      );
  }
}

function sidebarSection(value: unknown, path: string): WorkspaceSidebarSection {
  const raw = record(value, path);
  const seen = new Set<string>();
  const items = list(raw.items ?? [], `${path}.items`, MAX_SIDEBAR_ITEMS).map((item, index) => {
    const at = `${path}.items[${index}]`;
    const entry = record(item, at);
    const itemId = id(entry.id, `${at}.id`);
    if (seen.has(itemId)) fail(`${at}.id`, `duplicate item id "${itemId}"`);
    seen.add(itemId);
    const thumbnail = entry.thumbnail;
    if (
      thumbnail !== undefined &&
      (typeof thumbnail !== "string" ||
        thumbnail.length > MAX_THUMBNAIL_LENGTH ||
        !THUMBNAIL_PATTERN.test(thumbnail))
    ) {
      fail(`${at}.thumbnail`, "must be a base64 data:image URL under 64KB");
    }
    return compact({
      id: itemId,
      label: text(entry.label, `${at}.label`),
      detail: optionalText(entry.detail, `${at}.detail`),
      icon: icon(entry.icon, `${at}.icon`),
      thumbnail: thumbnail as string | undefined,
    });
  });
  const selected = items.find((item) => item.id === raw.value)?.id;
  return {
    id: id(raw.id, `${path}.id`),
    title: text(raw.title, `${path}.title`),
    items,
    value: raw.value === null ? null : (selected ?? items[0]?.id ?? null),
  };
}

function inspectorControl(value: unknown, path: string): WorkspaceInspectorControl {
  const raw = record(value, path);
  const base = { id: id(raw.id, `${path}.id`), label: text(raw.label, `${path}.label`) };
  switch (raw.type) {
    case "slider": {
      const min = finite(raw.min, `${path}.min`);
      const max = finite(raw.max, `${path}.max`);
      if (!(min < max)) fail(path, "min must be less than max");
      const step = optionalFinite(raw.step, `${path}.step`) ?? (max - min) / 100;
      if (!(step > 0)) fail(`${path}.step`, "must be positive");
      return compact({
        type: "slider" as const,
        ...base,
        min,
        max,
        step,
        value: clamp(optionalFinite(raw.value, `${path}.value`) ?? min, min, max),
        unit: optionalText(raw.unit, `${path}.unit`),
      });
    }
    case "number": {
      const min = optionalFinite(raw.min, `${path}.min`);
      const max = optionalFinite(raw.max, `${path}.max`);
      if (min !== undefined && max !== undefined && !(min < max)) {
        fail(path, "min must be less than max");
      }
      const step = optionalFinite(raw.step, `${path}.step`) ?? 1;
      if (!(step > 0)) fail(`${path}.step`, "must be positive");
      return compact({
        type: "number" as const,
        ...base,
        min,
        max,
        step,
        value: clamp(optionalFinite(raw.value, `${path}.value`) ?? min ?? 0, min, max),
        unit: optionalText(raw.unit, `${path}.unit`),
      });
    }
    case "select":
    case "segmented": {
      const choices = options(raw.options, `${path}.options`);
      return { type: raw.type, ...base, options: choices, value: chosen(raw.value, choices) };
    }
    case "toggle":
      return { type: "toggle", ...base, value: raw.value === true };
    case "color": {
      const color = typeof raw.value === "string" ? normalizeColor(raw.value) : undefined;
      if (raw.value !== undefined && color === undefined) {
        fail(`${path}.value`, 'must be a hex color such as "#ff8800"');
      }
      return { type: "color", ...base, value: color ?? "#ffffff" };
    }
    case "button":
      return compact({ type: "button" as const, ...base, icon: icon(raw.icon, `${path}.icon`) });
    default:
      return fail(
        `${path}.type`,
        'must be "slider", "number", "select", "segmented", "toggle", "color", or "button"',
      );
  }
}

function inspectorSection(value: unknown, path: string): WorkspaceInspectorSection {
  const raw = record(value, path);
  return {
    title: text(raw.title, `${path}.title`),
    controls: list(raw.controls, `${path}.controls`, MAX_INSPECTOR_CONTROLS).map((control, index) =>
      inspectorControl(control, `${path}.controls[${index}]`),
    ),
  };
}

/** Ids of every entry that carries a value or sends a command, which share one namespace. */
function chromeIds(chrome: WorkspaceChrome): string[] {
  const ids: string[] = [];
  for (const item of chrome.toolbar ?? []) {
    if (item.type === "separator") continue;
    ids.push(item.id);
    if (item.type === "menu") ids.push(...item.items.map((entry) => entry.id));
  }
  for (const section of chrome.sidebar ?? []) ids.push(section.id);
  for (const section of chrome.inspector ?? []) {
    ids.push(...section.controls.map((control) => control.id));
  }
  return ids;
}

/**
 * Validates and normalizes a chrome manifest. Errors name the offending path
 * so the agent can fix its call; the server rejects a manifest that fails.
 */
export function readWorkspaceChrome(
  value: unknown,
  maxBytes: number = WORKSPACE_CHROME_MAX_BYTES,
): WorkspaceChromeReadResult {
  try {
    const raw = record(value, "chrome");
    const size = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
    if (size > maxBytes) fail("chrome", `must be at most ${maxBytes} bytes of JSON (got ${size})`);
    const chrome = compact({
      toolbar:
        raw.toolbar === undefined
          ? undefined
          : list(raw.toolbar, "chrome.toolbar", MAX_TOOLBAR_ITEMS).map((item, index) =>
              toolbarItem(item, `chrome.toolbar[${index}]`),
            ),
      sidebar:
        raw.sidebar === undefined
          ? undefined
          : list(raw.sidebar, "chrome.sidebar", MAX_SIDEBAR_SECTIONS).map((section, index) =>
              sidebarSection(section, `chrome.sidebar[${index}]`),
            ),
      inspector:
        raw.inspector === undefined
          ? undefined
          : list(raw.inspector, "chrome.inspector", MAX_INSPECTOR_SECTIONS).map((section, index) =>
              inspectorSection(section, `chrome.inspector[${index}]`),
            ),
    });
    const seen = new Set<string>();
    for (const entryId of chromeIds(chrome)) {
      if (seen.has(entryId)) fail("chrome", `id "${entryId}" is used twice; ids must be unique`);
      seen.add(entryId);
    }
    return { ok: true, chrome };
  } catch (error) {
    if (error instanceof ChromeError) return { ok: false, error: error.message };
    throw error;
  }
}

/** A stored manifest, or undefined when it is absent or no longer valid. */
export function readStoredWorkspaceChrome(value: unknown): WorkspaceChrome | undefined {
  if (value === undefined) return undefined;
  const result = readWorkspaceChrome(value);
  return result.ok ? result.chrome : undefined;
}

export function hasWorkspaceChrome(chrome: WorkspaceChrome | undefined): chrome is WorkspaceChrome {
  return (
    chrome !== undefined &&
    ((chrome.toolbar?.length ?? 0) > 0 ||
      (chrome.sidebar?.length ?? 0) > 0 ||
      (chrome.inspector?.length ?? 0) > 0)
  );
}

// Values ---------------------------------------------------------------------

/** An entry that holds a value, with the rule that admits one. */
type ValueEntry =
  | {
      readonly kind: "number";
      readonly min?: number;
      readonly max?: number;
      readonly fallback: number;
    }
  | { readonly kind: "choice"; readonly choices: ReadonlyArray<string>; readonly fallback: string }
  | {
      readonly kind: "nullable-choice";
      readonly choices: ReadonlyArray<string>;
      readonly fallback: string | null;
    }
  | { readonly kind: "boolean"; readonly fallback: boolean }
  | { readonly kind: "color"; readonly fallback: string };

function valueEntries(chrome: WorkspaceChrome): Map<string, ValueEntry> {
  const entries = new Map<string, ValueEntry>();
  for (const item of chrome.toolbar ?? []) {
    if (item.type === "toggle") entries.set(item.id, { kind: "boolean", fallback: item.value });
    if (item.type === "segmented") {
      entries.set(item.id, {
        kind: "choice",
        choices: item.options.map((option) => option.value),
        fallback: item.value,
      });
    }
  }
  for (const section of chrome.sidebar ?? []) {
    entries.set(section.id, {
      kind: "nullable-choice",
      choices: section.items.map((item) => item.id),
      fallback: section.value,
    });
  }
  for (const section of chrome.inspector ?? []) {
    for (const control of section.controls) {
      switch (control.type) {
        case "slider":
        case "number":
          entries.set(control.id, {
            kind: "number",
            ...(control.min === undefined ? {} : { min: control.min }),
            ...(control.max === undefined ? {} : { max: control.max }),
            fallback: control.value,
          });
          break;
        case "select":
        case "segmented":
          entries.set(control.id, {
            kind: "choice",
            choices: control.options.map((option) => option.value),
            fallback: control.value,
          });
          break;
        case "toggle":
          entries.set(control.id, { kind: "boolean", fallback: control.value });
          break;
        case "color":
          entries.set(control.id, { kind: "color", fallback: control.value });
          break;
        case "button":
          break;
      }
    }
  }
  return entries;
}

function admit(entry: ValueEntry, value: unknown): WorkspaceChromeValue | undefined {
  switch (entry.kind) {
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? clamp(value, entry.min, entry.max)
        : undefined;
    case "choice":
      return typeof value === "string" && entry.choices.includes(value) ? value : undefined;
    case "nullable-choice":
      return value === null || (typeof value === "string" && entry.choices.includes(value))
        ? value
        : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "color":
      return typeof value === "string" ? normalizeColor(value) : undefined;
  }
}

/** The manifest's defaults, overridden by each value in `from` that still fits its control. */
export function resolveWorkspaceChromeValues(
  chrome: WorkspaceChrome,
  from: unknown = undefined,
): WorkspaceChromeValues {
  const source =
    typeof from === "object" && from !== null && !Array.isArray(from)
      ? (from as Record<string, unknown>)
      : {};
  const values: Record<string, WorkspaceChromeValue> = {};
  for (const [entryId, entry] of valueEntries(chrome)) {
    values[entryId] = Object.hasOwn(source, entryId)
      ? (admit(entry, source[entryId]) ?? entry.fallback)
      : entry.fallback;
  }
  return values;
}

/** The value `value` becomes for control `id`, or undefined when it does not fit (or `id` holds none). */
export function admitWorkspaceChromeValue(
  chrome: WorkspaceChrome,
  id: string,
  value: unknown,
): WorkspaceChromeValue | undefined {
  const entry = valueEntries(chrome).get(id);
  return entry === undefined ? undefined : admit(entry, value);
}

/** The manifest's default for control `id`, or undefined when it holds no value. */
export function workspaceChromeDefault(
  chrome: WorkspaceChrome,
  id: string,
): WorkspaceChromeValue | undefined {
  return valueEntries(chrome).get(id)?.fallback;
}

export function workspaceChromeValuesEqual(
  left: WorkspaceChromeValues,
  right: WorkspaceChromeValues,
) {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
}

// Live patches from the page ---------------------------------------------------

export interface WorkspaceChromePatchResult {
  readonly chrome: WorkspaceChrome;
  readonly values: WorkspaceChromeValues;
}

/**
 * Applies a page's `setChrome(patch)`: each region it names replaces that
 * region (an empty array removes it), and `values` merge over the current
 * values. Values of controls that survive keep theirs. Returns an error
 * message when the result is not a valid manifest.
 */
export function applyWorkspaceChromePatch(
  chrome: WorkspaceChrome,
  values: WorkspaceChromeValues,
  patch: unknown,
): WorkspaceChromePatchResult | { readonly error: string } {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return { error: "setChrome takes an object such as { inspector: [...], values: {...} }." };
  }
  const { values: patchValues, ...regions } = patch as Record<string, unknown>;
  const unknownKey = Object.keys(regions).find(
    (key) => key !== "toolbar" && key !== "sidebar" && key !== "inspector",
  );
  if (unknownKey !== undefined) {
    return {
      error: `setChrome: unknown key "${unknownKey}"; use toolbar, sidebar, inspector, or values.`,
    };
  }
  const merged: Record<string, unknown> = { ...chrome, ...regions };
  for (const key of ["toolbar", "sidebar", "inspector"] as const) {
    if (Array.isArray(merged[key]) && merged[key].length === 0) delete merged[key];
  }
  const read = readWorkspaceChrome(merged, WORKSPACE_CHROME_PATCH_MAX_BYTES);
  if (!read.ok) return { error: read.error };
  if (
    patchValues !== undefined &&
    (typeof patchValues !== "object" || patchValues === null || Array.isArray(patchValues))
  ) {
    return { error: "setChrome: values must be an object keyed by control id." };
  }
  // Region defaults apply to controls the patch introduced; values set explicitly win.
  const base = resolveWorkspaceChromeValues(read.chrome, values);
  const next = resolveWorkspaceChromeValues(read.chrome, {
    ...base,
    ...(patchValues as object | undefined),
  });
  return { chrome: read.chrome, values: next };
}

// Stored state ------------------------------------------------------------------

/**
 * How a workspace with chrome stores its state: T3's control values beside
 * the page's own `setState` object. A workspace without chrome stores the
 * page's state as is.
 */
export interface WorkspaceStateEnvelope {
  readonly controls: WorkspaceChromeValues;
  readonly page: unknown;
}

function isStateEnvelope(value: unknown): value is { controls: unknown; page?: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const { controls } = value as Record<string, unknown>;
  return (
    keys.includes("controls") &&
    keys.every((key) => key === "controls" || key === "page") &&
    typeof controls === "object" &&
    controls !== null &&
    !Array.isArray(controls)
  );
}

export function workspaceStateEnvelope(
  controls: WorkspaceChromeValues,
  page: unknown,
): WorkspaceStateEnvelope {
  return { controls, page: page ?? null };
}

/** Splits stored state into stored control values (undefined when none) and the page's own state. */
export function readWorkspaceStateEnvelope(stored: unknown): {
  readonly controls: unknown;
  readonly page: unknown;
} {
  return isStateEnvelope(stored)
    ? { controls: stored.controls, page: stored.page ?? null }
    : { controls: undefined, page: stored };
}

/** The page's own part of stored state: what `initialState()` resolves to. */
export function workspacePageState(stored: unknown): unknown {
  return readWorkspaceStateEnvelope(stored).page;
}

// Shortcuts ---------------------------------------------------------------------

export interface WorkspaceShortcut {
  readonly key: string;
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export interface WorkspaceKeyInput {
  readonly key: string;
  /** The physical key ("KeyE"), so Alt and Shift combinations match on any layout. */
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  space: " ",
  enter: "enter",
  return: "enter",
  esc: "escape",
  escape: "escape",
  tab: "tab",
  backspace: "backspace",
  delete: "delete",
  del: "delete",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  arrowup: "arrowup",
  arrowdown: "arrowdown",
  arrowleft: "arrowleft",
  arrowright: "arrowright",
  plus: "+",
  minus: "-",
};

/** Parses "mod+shift+e", "alt+[", "space", or "v"; `mod` is Cmd on macOS and Ctrl elsewhere. */
export function parseWorkspaceShortcut(value: string): WorkspaceShortcut | undefined {
  if (value.length === 0 || value.length > 32) return undefined;
  const parts = value.toLowerCase().split("+");
  // "mod++" names the plus key.
  if (parts.length > 1 && parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "+");
  const keyPart = parts.pop();
  if (keyPart === undefined || keyPart === "") return undefined;
  const shortcut = { key: "", mod: false, ctrl: false, alt: false, shift: false };
  for (const modifier of parts) {
    if (modifier === "mod" || modifier === "cmd" || modifier === "meta") shortcut.mod = true;
    else if (modifier === "ctrl" || modifier === "control") shortcut.ctrl = true;
    else if (modifier === "alt" || modifier === "option" || modifier === "opt") shortcut.alt = true;
    else if (modifier === "shift") shortcut.shift = true;
    else return undefined;
  }
  const named = NAMED_KEYS[keyPart];
  if (named !== undefined) shortcut.key = named;
  else if (/^f(?:[1-9]|1[0-2])$/.test(keyPart) || [...keyPart].length === 1) shortcut.key = keyPart;
  else return undefined;
  return shortcut;
}

/** Whether a key press triggers `value`. Shift must match for letters and named keys only, so "?" works however it is typed. */
export function matchWorkspaceShortcut(
  value: string,
  event: WorkspaceKeyInput,
  isMac: boolean,
): boolean {
  const shortcut = parseWorkspaceShortcut(value);
  if (shortcut === undefined) return false;
  const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code ?? "");
  const physicalKey = physical ? (physical[1] ?? physical[2] ?? "").toLowerCase() : undefined;
  if (event.key.toLowerCase() !== shortcut.key && physicalKey !== shortcut.key) return false;
  const wantMeta = isMac && shortcut.mod;
  const wantCtrl = isMac ? shortcut.ctrl : shortcut.mod || shortcut.ctrl;
  if (event.metaKey !== wantMeta || event.ctrlKey !== wantCtrl) return false;
  if (event.altKey !== shortcut.alt) return false;
  const shiftMatters = /^[a-z0-9]$/.test(shortcut.key) || shortcut.key.length > 1 || shortcut.shift;
  return !shiftMatters || event.shiftKey === shortcut.shift;
}

/** How a shortcut reads in a tooltip: "⌘⇧E" on macOS, "Ctrl+Shift+E" elsewhere. */
export function workspaceShortcutLabel(value: string, isMac: boolean): string {
  const shortcut = parseWorkspaceShortcut(value);
  if (shortcut === undefined) return value;
  const key =
    shortcut.key === " "
      ? "Space"
      : shortcut.key.length > 1
        ? shortcut.key.replace(/^arrow/, "").replace(/^./, (c) => c.toUpperCase())
        : shortcut.key.toUpperCase();
  if (isMac) {
    return `${shortcut.ctrl ? "⌃" : ""}${shortcut.alt ? "⌥" : ""}${shortcut.shift ? "⇧" : ""}${shortcut.mod ? "⌘" : ""}${key}`;
  }
  return [
    shortcut.mod || shortcut.ctrl ? "Ctrl" : null,
    shortcut.alt ? "Alt" : null,
    shortcut.shift ? "Shift" : null,
    key,
  ]
    .filter((part) => part !== null)
    .join("+");
}

/** What a user action sends the page: the entry's id, and its new value when it holds one. */
export interface WorkspaceChromeCommand {
  readonly id: string;
  readonly value?: WorkspaceChromeValue;
}

/** The toolbar command a key press triggers, if any: a button or menu item, a toggle flip, or a segment choice. */
export function workspaceChromeShortcutCommand(
  chrome: WorkspaceChrome,
  values: WorkspaceChromeValues,
  event: WorkspaceKeyInput,
  isMac: boolean,
): WorkspaceChromeCommand | undefined {
  const matches = (value: string | undefined) =>
    value !== undefined && matchWorkspaceShortcut(value, event, isMac);
  for (const item of chrome.toolbar ?? []) {
    switch (item.type) {
      case "button":
        if (matches(item.shortcut)) return { id: item.id };
        break;
      case "toggle":
        if (matches(item.shortcut)) return { id: item.id, value: values[item.id] !== true };
        break;
      case "segmented": {
        const option = item.options.find((entry) => matches(entry.shortcut));
        if (option !== undefined) return { id: item.id, value: option.value };
        break;
      }
      case "menu": {
        const entry = item.items.find((menuItem) => matches(menuItem.shortcut));
        if (entry !== undefined) return { id: entry.id };
        break;
      }
      case "separator":
        break;
    }
  }
  return undefined;
}

// Bridge ----------------------------------------------------------------------------

/** What a page's `setChrome` rejects with when its workspace has no chrome to patch. */
export const WORKSPACE_CHROME_MISSING_ERROR =
  "This workspace has no native chrome; pass `chrome` to workspace_mutate to add it.";

/** Bridge methods the chrome adds; `WORKSPACE_BRIDGE_METHODS` carries them too. */
export const WORKSPACE_CHROME_BRIDGE_METHODS = {
  /** Request from the page: patch the chrome (regions replace, values merge). */
  setChrome: "t3/workspace/set-chrome",
  /** Notification from the page: a key press it left unhandled, for toolbar shortcuts. */
  key: "t3/workspace/key",
  /** Notification from the host: every control value, on load and on each change. */
  controls: "t3/workspace/controls",
  /** Notification from the host: a user action on the chrome, `{ id, value? }`. */
  command: "t3/workspace/command",
} as const;

export type WorkspaceChromeBridgeMessage =
  | {
      readonly id: string | number;
      readonly method: typeof WORKSPACE_CHROME_BRIDGE_METHODS.setChrome;
      readonly patch: unknown;
    }
  | {
      readonly method: typeof WORKSPACE_CHROME_BRIDGE_METHODS.key;
      readonly event: WorkspaceKeyInput;
    };

/** A page's chrome bridge message, or undefined when `data` is not one. */
export function readWorkspaceChromeBridgeMessage(
  data: unknown,
): WorkspaceChromeBridgeMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, id: requestId, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0") return undefined;
  const p = (typeof params === "object" && params !== null ? params : {}) as Record<
    string,
    unknown
  >;
  switch (method) {
    case WORKSPACE_CHROME_BRIDGE_METHODS.setChrome:
      return typeof requestId === "string" || typeof requestId === "number"
        ? { id: requestId, method, patch: p.patch }
        : undefined;
    case WORKSPACE_CHROME_BRIDGE_METHODS.key:
      return typeof p.key === "string" && p.key.length <= 32
        ? {
            method,
            event: {
              key: p.key,
              ...(typeof p.code === "string" && p.code.length <= 32 ? { code: p.code } : {}),
              metaKey: p.meta === true,
              ctrlKey: p.ctrl === true,
              altKey: p.alt === true,
              shiftKey: p.shift === true,
            },
          }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The page side of the chrome, appended to the workspace bridge script. It
 * extends `window.t3.workspace` with `controls()`, `setChrome(patch)`, and
 * the `controls` and `command` events (a late `on('controls')` gets the
 * current values at once), and forwards key presses the page leaves
 * unhandled so toolbar shortcuts work while the page has focus.
 */
export const WORKSPACE_CHROME_BRIDGE_SCRIPT = `(function(){
var M=${JSON.stringify(WORKSPACE_CHROME_BRIDGE_METHODS)},w=window.t3&&window.t3.workspace;if(!w)return;
var on=w.on,ls={},controls,n=0,pending={};
function post(m){window.parent.postMessage(m,"*");}
function emit(name,v){(ls[name]||[]).slice().forEach(function(cb){try{cb(v);}catch(e){console.error(e);}});}
window.addEventListener("message",function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.jsonrpc!=="2.0")return;
if(d.id!=null&&pending[d.id]){var p=pending[d.id];delete pending[d.id];if(d.error)p.reject(new Error(d.error.message||"Request failed."));else p.resolve(d.result);return;}
if(d.method===M.controls&&d.params&&d.params.values){controls=d.params.values;emit("controls",controls);}
if(d.method===M.command&&d.params&&typeof d.params.id==="string"){emit("command",{id:d.params.id,value:d.params.value});}
});
w.on=function(name,cb){if(name!=="controls"&&name!=="command")return on(name,cb);(ls[name]=ls[name]||[]).push(cb);if(name==="controls"&&controls!==undefined){var v=controls;Promise.resolve().then(function(){cb(v);});}return function(){ls[name]=(ls[name]||[]).filter(function(x){return x!==cb;});};};
w.controls=function(){return controls!==undefined?Promise.resolve(controls):new Promise(function(r){var off=w.on("controls",function(v){off();r(v);});});};
w.setChrome=function(patch){return new Promise(function(resolve,reject){var id="c"+(++n);pending[id]={resolve:resolve,reject:reject};post({jsonrpc:"2.0",id:id,method:M.setChrome,params:{patch:patch}});});};
window.addEventListener("keydown",function(e){if(e.repeat||e.isComposing)return;var t=e.target,k=e.key;
setTimeout(function(){if(e.defaultPrevented)return;var editable=t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));if(editable)return;
post({jsonrpc:"2.0",method:M.key,params:{key:k,code:e.code,meta:e.metaKey,ctrl:e.ctrlKey,alt:e.altKey,shift:e.shiftKey}});},0);});
})();`;

/** Agent-facing description of the `chrome` parameter of `workspace_mutate`. */
export const WORKSPACE_CHROME_GUIDE = [
  "Optional native chrome T3 renders with its own components, so the app itself reshapes around the task: toolbar (tools in the window header), sidebar (replaces the app sidebar: layers, history, bins, presets), inspector (a native right column of controls with the chat composer docked at its bottom; with one, make the page just the canvas or timeline, without its own control panel or data-t3-composer slot).",
  "T3 owns the values and keeps them across rebuilds: in the page, t3.workspace.on('controls', values => render(values)) fires on load and on every change (values keyed by id; also await t3.workspace.controls()), t3.workspace.on('command', ({id, value}) => …) fires for every user action (buttons and menu items have no value), and t3.workspace.setChrome({toolbar?, sidebar?, inspector?, values?}) updates the chrome live (a region you pass replaces that region; values merge; set sidebar thumbnails here as data:image URLs). workspace_state then returns {controls, page}.",
  "Toolbar items: {type:'button'|'toggle', id, label, icon?, shortcut?, value?}, {type:'segmented', id, label, options, value?}, {type:'menu', id, label, icon?, items:[{id, label, shortcut?}]}, {type:'separator'}.",
  "Sidebar: [{id, title, items:[{id, label, detail?, icon?}], value?}] (value is the selected item id).",
  "Inspector: [{title, controls:[…]}] with controls {type:'slider', id, label, min, max, step?, value?, unit?}, {type:'number', id, label, min?, max?, step?, value?, unit?}, {type:'select'|'segmented', id, label, options:[string | {value, label, icon?, shortcut?}], value?}, {type:'toggle', id, label, value?}, {type:'color', id, label, value?:'#rrggbb'}, {type:'button', id, label, icon?}.",
  `Icons are lucide names; shortcuts look like 'mod+z', 'shift+r', 'v' and work while the page has focus too. Ids are unique across the manifest; at most ${WORKSPACE_CHROME_MAX_BYTES} bytes of JSON.`,
  'Example: {"toolbar":[{"type":"segmented","id":"tool","label":"Tool","options":[{"value":"move","label":"Move","icon":"move","shortcut":"v"},{"value":"crop","label":"Crop","icon":"crop","shortcut":"c"}]},{"type":"button","id":"export","label":"Export","icon":"download","shortcut":"mod+e"}],"sidebar":[{"id":"history","title":"History","items":[{"id":"open","label":"Opened"}]}],"inspector":[{"title":"Light","controls":[{"type":"slider","id":"exposure","label":"Exposure","min":-5,"max":5,"step":0.05,"value":0,"unit":"EV"}]}]}',
].join(" ");
