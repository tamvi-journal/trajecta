/** Narrow source gate for the complete engine-dispatch path, including its import dependencies. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./engine-lock.ts";
const compact = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "").replace(/\s+/gu, "");
export function scanDispatcher(cli: string, adapter: string): void {
  const fail = () => {
    throw new Error("observable engine dispatcher or product error wrapper");
  };
  const pass = /export async function passThrough\([^]*?\n\}/u.exec(adapter)?.[0];
  if (
    compact(pass ?? "") !==
    compact(`export async function passThrough(engine: Engine, argv: string[]): Promise<void> {
    const entry = enginePath(engine);
    process.argv = [process.execPath, entry, ...argv];
    await ${"im" + "port"}(pathToFileURL(entry).href);
  }`)
  )
    fail();
  const path = /export function enginePath\([^]*?\n\}/u.exec(adapter)?.[0];
  if (
    compact(path ?? "") !==
    compact(
      'export function enginePath(engine: Engine, entry = "cli.ts"): string { return fileURLToPath(new URL(`../../engines/${engine}/src/${entry}`, import.meta.url)); }',
    )
  )
    fail();
  const entry = cli.slice(cli.indexOf("if (process.argv[1]"));
  if (
    compact(entry) !==
    compact(`if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [command, ...args] = process.argv.slice(2);
    if (command === "identity" || command === "work") {
      await passThrough(command, args);
    } else {
      main()
        .then((code) => { process.exitCode = code; })
        .catch((error) => {
          process.stderr.write(\`trajecta: \${error.message}\\n\`);
          process.exitCode = 1;
        });
    }
  }`)
  )
    fail();
  if (/passThrough/u.test(cli.slice(0, cli.indexOf("if (process.argv[1]")).replace(/import[^;]+;/gu, ""))) fail();
  // The route's only dependencies are built-ins and this adapter. No side-effect
  // import, computed dependency, hidden parent, or top-level invocation is allowed.
  for (const [source, imports] of [
    [
      cli,
      [
        'import { readFileSync } from "node:fs";',
        'import { pathToFileURL } from "node:url";',
        'import { engineMetadata, passThrough } from "./engines.ts";',
      ],
    ],
    [adapter, ['import { readFileSync } from "node:fs";', 'import { fileURLToPath, pathToFileURL } from "node:url";']],
  ] as const) {
    const found = source.match(/^import[^\n]+/gmu) ?? [];
    if (JSON.stringify(found.map(compact)) !== JSON.stringify(imports.map(compact))) fail();
  }
  const beforeEntry = cli
    .slice(0, cli.indexOf("if (process.argv[1]"))
    .replace(/^#![^\n]*\n/u, "")
    .replace(/^import[^\n]+/gmu, "")
    .replace(/export async function main[^]*?\n\}/u, "");
  if (compact(beforeEntry)) fail();
  const residue = adapter
    .replace(/^import[^\n]+/gmu, "")
    .replace(/export (?:async )?function [^]*?\n\}/gu, "")
    .replace(/export type Engine[^;]+;/u, "");
  if (compact(residue)) fail();
  const outsidePass = compact(adapter.replace(pass!, ""));
  if (/\bprocess\b|child_process|\b(?:spawn|exec|eval|Function|require)\s*\(/u.test(outsidePass)) fail();
}
export function checkDispatcher(): void {
  scanDispatcher(
    readFileSync(join(ROOT, "product/src/cli.ts"), "utf8"),
    readFileSync(join(ROOT, "product/src/engines.ts"), "utf8"),
  );
}
