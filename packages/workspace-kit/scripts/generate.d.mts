import type { KitSource } from "../src/types.ts";

export function readDocsHeader(source: string, file: string): string;
export function readSummary(docs: string, name: string): string;
export function readKit(kitDir: string): KitSource;
export function renderKitModule(kit: KitSource): string;
