/** The only engine adapter. Engine CLIs own their process and public semantics. */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export type Engine = "identity" | "work";
export function enginePath(engine: Engine, entry = "cli.ts"): string {
  return fileURLToPath(new URL(`../../engines/${engine}/src/${entry}`, import.meta.url));
}
export function engineMetadata(engine: Engine): { name: string; version: string } {
  return JSON.parse(readFileSync(new URL(`../../engines/${engine}/package.json`, import.meta.url), "utf8"));
}
export async function identityApi() {
  return import("../../engines/identity/src/index.ts");
}
/** Public CLI module, also initializes its frozen diagnostic handling. */
export async function prepareIdentityCli() {
  return import("../../engines/identity/src/cli.ts");
}
export async function workApi() {
  return import("../../engines/work/src/index.ts");
}
export async function passThrough(engine: Engine, argv: string[]): Promise<void> {
  const entry = enginePath(engine);
  process.argv = [process.execPath, entry, ...argv];
  await import(pathToFileURL(entry).href);
}
