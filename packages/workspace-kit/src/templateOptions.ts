import type { KitTemplate, TemplateOptionSpec, TemplateOptionType } from "./types.ts";

/** Every template runs this bolt-on hook, declared or not (TEMPLATE_CONTRACT.md). */
const CUSTOM_SCRIPT_KEY = "customScript";

/**
 * How a template reports a failed `customScript`: it logs this prefix and the
 * error message (`console.error(MARKER, err.message)`) beside its banner, so
 * T3's publish-time validation can hand the error back to the agent.
 */
export const TEMPLATE_CUSTOM_SCRIPT_ERROR_MARKER = "[t3template] customScript error:";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const show = (value: unknown) => JSON.stringify(value) ?? String(value);

function checkValue(
  spec: TemplateOptionSpec,
  value: unknown,
  path: string,
  problems: Array<string>,
): void {
  if (spec.enum !== undefined && !spec.enum.some((allowed) => allowed === value)) {
    problems.push(`${path}: expected one of ${spec.enum.map(show).join(", ")}, got ${show(value)}`);
    return;
  }
  if (Array.isArray(spec.type)) {
    checkUnion(spec, spec.type, value, path, problems);
    return;
  }
  switch (spec.type as TemplateOptionType | undefined) {
    case "string":
      if (typeof value !== "string")
        problems.push(`${path}: expected a string, got ${show(value)}`);
      return;
    case "null":
      if (value !== null) problems.push(`${path}: expected null, got ${show(value)}`);
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        problems.push(`${path}: expected true or false, got ${show(value)}`);
      }
      return;
    case "number":
    case "integer": {
      const valid =
        typeof value === "number" &&
        Number.isFinite(value) &&
        (spec.type === "number" || Number.isInteger(value));
      if (!valid) {
        problems.push(
          `${path}: expected ${spec.type === "integer" ? "an integer" : "a number"}, got ${show(value)}`,
        );
        return;
      }
      if (spec.minimum !== undefined && value < spec.minimum) {
        problems.push(`${path}: must be at least ${spec.minimum}, got ${value}`);
      }
      if (spec.maximum !== undefined && value > spec.maximum) {
        problems.push(`${path}: must be at most ${spec.maximum}, got ${value}`);
      }
      return;
    }
    case "array":
      if (!Array.isArray(value)) {
        problems.push(`${path}: expected an array, got ${show(value)}`);
        return;
      }
      if (spec.items !== undefined) {
        const items = spec.items;
        value.forEach((item, index) => checkValue(items, item, `${path}[${index}]`, problems));
      }
      return;
    case "object":
      if (!isPlainObject(value)) {
        problems.push(`${path}: expected an object, got ${show(value)}`);
        return;
      }
      checkProperties(spec, value, path, problems);
      return;
    case undefined:
      return;
  }
}

/**
 * A value whose spec lists several types: it passes when it matches one. A
 * value of a listed kind reports that type's problems (an object with a bad
 * key); any other value reports the list.
 */
function checkUnion(
  spec: TemplateOptionSpec,
  types: ReadonlyArray<TemplateOptionType>,
  value: unknown,
  path: string,
  problems: Array<string>,
): void {
  const attempts = types.map((type) => {
    const found: Array<string> = [];
    checkValue({ ...spec, type }, value, path, found);
    return { type, found };
  });
  if (attempts.some((attempt) => attempt.found.length === 0)) return;
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const sameKind = attempts.find(
    (attempt) =>
      attempt.type === kind ||
      (kind === "number" && (attempt.type === "integer" || attempt.type === "number")),
  );
  if (sameKind !== undefined) problems.push(...sameKind.found);
  else problems.push(`${path}: expected ${types.join(" or ")}, got ${show(value)}`);
}

/**
 * An object's declared properties: each present one checked, required ones
 * present, and undeclared ones rejected like undeclared options. An object
 * spec without `properties` takes any keys.
 */
function checkProperties(
  spec: TemplateOptionSpec,
  value: Record<string, unknown>,
  path: string,
  problems: Array<string>,
): void {
  const properties = spec.properties;
  if (properties === undefined) return;
  for (const key of spec.required ?? []) {
    if (!(key in value)) problems.push(`${path}.${key}: required`);
  }
  for (const [key, item] of Object.entries(value)) {
    const property = properties[key];
    if (property !== undefined) checkValue(property, item, `${path}.${key}`, problems);
    else {
      problems.push(
        `${path}.${key}: unknown key; expected ${Object.keys(properties).join(", ") || "no keys"}`,
      );
    }
  }
}

/**
 * Checks an agent's template options against `template.json`: each declared
 * key's type, enum and range, and no undeclared keys (a typo would otherwise
 * silently fall back to the default). Missing keys are fine; the template
 * merges its defaults. Returns one problem per wrong value, with its path.
 */
export function validateTemplateOptions(
  template: Pick<KitTemplate, "options">,
  options: unknown,
  path = "template.options",
): ReadonlyArray<string> {
  if (!isPlainObject(options)) return [`${path}: expected an object, got ${show(options)}`];
  const problems: Array<string> = [];
  const declared = Object.keys(template.options);
  for (const [key, value] of Object.entries(options)) {
    const spec = template.options[key];
    if (spec !== undefined) {
      checkValue(spec, value, `${path}.${key}`, problems);
    } else if (key === CUSTOM_SCRIPT_KEY) {
      checkValue({ type: "string" }, value, `${path}.${key}`, problems);
    } else {
      const known = [
        ...declared,
        ...(declared.includes(CUSTOM_SCRIPT_KEY) ? [] : [CUSTOM_SCRIPT_KEY]),
      ];
      problems.push(`${path}.${key}: unknown option; this template takes ${known.join(", ")}`);
    }
  }
  return problems;
}
