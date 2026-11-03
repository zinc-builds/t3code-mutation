import { expect, it } from "@effect/vitest";
import { workspaceKit } from "@t3tools/workspace-kit";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { WORKSPACE_GUIDES, workspaceKitIndex } from "./guides.ts";
import { WorkspaceToolkit } from "./tools.ts";

// MCP requires a top-level object input schema. Anything else (an explicit
// empty Schema.Struct({}) serializes to `anyOf: [object, array]`) makes clients
// reject the whole T3 server, and once stalled server startup.
it("gives every workspace tool an object input schema", () => {
  const tools = Object.values(WorkspaceToolkit.tools);
  expect(tools.map((tool) => tool.name).toSorted()).toEqual([
    "workspace_kit_docs",
    "workspace_mutate",
    "workspace_restore",
    "workspace_state",
  ]);
  for (const tool of tools) {
    expect(Tool.getJsonSchema(tool).type, `inputSchema.type of ${tool.name}`).toBe("object");
  }
});

it("would catch a tool declared with empty parameters", () => {
  const empty = Tool.make("empty", { parameters: Schema.Struct({}) });
  expect(Tool.getJsonSchema(empty).type).not.toBe("object");
});

it("names every template in workspace_mutate and groups each in the catalog tier", () => {
  const { workspace_mutate: mutate } = WorkspaceToolkit.tools;
  const index = workspaceKitIndex(workspaceKit.catalog);
  expect(workspaceKit.templateIds.length).toBeGreaterThan(0);
  expect(index).not.toContain("Other:");
  for (const id of workspaceKit.templateIds) {
    expect(mutate.description).toContain(id);
    expect(index).toContain(`- ${id}: `);
  }
  for (const name of workspaceKit.primitiveNames) expect(index).toContain(`- ${name}: `);
  expect(index).toContain("window.t3template (addControl");
});

it("keeps depth out of the tool list", () => {
  const { workspace_mutate: mutate } = WorkspaceToolkit.tools;
  expect(
    JSON.stringify(Tool.getJsonSchema(mutate)).length + (mutate.description?.length ?? 0),
  ).toBeLessThan(5_000);
  for (const guide of Object.values(WORKSPACE_GUIDES)) expect(guide.length).toBeGreaterThan(0);
});

const decodeKitDocs = Schema.decodeSync(WorkspaceToolkit.tools.workspace_kit_docs.successSchema);

it("points agents at each template's bolt-on docs and returns them whole", () => {
  expect(WorkspaceToolkit.tools.workspace_kit_docs.description).toContain("boltOn");
  const all = workspaceKit.docs(workspaceKit.templateIds);
  if (!all.ok) throw new Error(all.error);
  const decoded = decodeKitDocs({ ...all.value, guides: [] });
  for (const template of decoded.templates) {
    expect(template.boltOn.api.length).toBeGreaterThan(0);
    expect(template.boltOn.example).toContain("t3template");
  }
});
