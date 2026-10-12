import { filesIn, ROOT } from "./engine-lock.ts";
import { join } from "node:path";
export function lintSource(file: string, source: string): void {
  const adapter = file === "product/src/engines.ts";
  const imports = /\b(?:import\s*(?:[^;]*?\sfrom\s*)?|export\s+[^;]*?\sfrom\s*|require\s*\()["']([^"']+)["']/gu;
  for (const match of source.matchAll(imports))
    if (!adapter && (match[1] === "node:sqlite" || /(?:^|\/)engines(?:\/|$)/u.test(match[1])))
      throw new Error(`authority import outside adapter: ${file}: ${match[1]}`);
  if (!adapter && /\bimport\s*\(\s*["'](?:node:sqlite|[^"']*\/engines\/)/u.test(source))
    throw new Error(`dynamic authority import outside adapter: ${file}`);
  if (!adapter && /\b(?:import|require)\s*\(\s*(?!["'])/u.test(source))
    throw new Error(`computed authority import cannot be audited: ${file}`);
  if (!adapter && /\b(?:import|require)\s*\(\s*["'][^"']*["']\s*\+/u.test(source))
    throw new Error(`computed authority import cannot be audited: ${file}`);
}
export function sourceScan(file: string, source: string): void {
  if (file === "product/src/engines.ts") return;
  const statements = source.match(/(?:\bimport|\bexport|\brequire)[^;]*[;\n]/gu) ?? [];
  for (const statement of statements)
    if (statement.includes("node:sqlite") || /["'`][^"'\n]*\/engines\//u.test(statement))
      throw new Error(`authority source scan: ${file}`);
  if (/\b(?:eval|Function)\s*\(/u.test(source)) throw new Error(`dynamic code in production: ${file}`);
  if (
    /\b(?:import|require)\s*\(\s*(?!["'])/u.test(source) ||
    /\b(?:import|require)\s*\(\s*["'][^"']*["']\s*\+/u.test(source)
  )
    throw new Error(`computed authority import cannot be audited: ${file}`);
}
export function checkAuthority(): void {
  for (const root of ["product/src", "tools"])
    for (const [name, bytes] of Object.entries(filesIn(join(ROOT, root))))
      if (name.endsWith(".ts")) {
        const file = root + "/" + name,
          source = bytes.toString("utf8");
        // The rule implementation contains adversarial syntax as data.
        if (file !== "tools/authority-lint.ts") {
          lintSource(file, source);
          sourceScan(file, source);
        }
      }
}
