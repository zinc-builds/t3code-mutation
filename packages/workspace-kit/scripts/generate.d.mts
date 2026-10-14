import type { KitSource, KitVendor } from "../src/types.ts";

export function primitiveGlobal(name: string): string;
export function readDocsHeader(source: string, file: string): string;
export function readSummary(docs: string, name: string): string;
export function vendorModuleEpilogue(source: string, library: string, file: string): string;
export function readVendor(
  kitDir: string,
  packageDir: string,
): { vendorRuntime: string | null; vendor: ReadonlyArray<KitVendor> };
export function readKit(kitDir: string, packageDir?: string): KitSource;
export function renderKitModule(kit: KitSource): string;
