import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

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
