import * as fs from "node:fs";
import { join } from "node:path";
/** §13.6: the single inventory/token authority for build, render and tests. */
export const TEMPLATE_COUNTS = {
  "trajecta.sh.tmpl": { "@@ROOT_SH@@": 1, "@@ROOT_PS@@": 0, "@@POWERSHELL@@": 0, "@@ENCODED_VALIDATOR@@": 0 },
  "trajecta-mcp.sh.tmpl": { "@@ROOT_SH@@": 1, "@@ROOT_PS@@": 0, "@@POWERSHELL@@": 0, "@@ENCODED_VALIDATOR@@": 0 },
  "user-stub.sh.tmpl": { "@@ROOT_SH@@": 1, "@@ROOT_PS@@": 0, "@@POWERSHELL@@": 0, "@@ENCODED_VALIDATOR@@": 0 },
  "trajecta.cmd.tmpl": { "@@ROOT_SH@@": 0, "@@ROOT_PS@@": 0, "@@POWERSHELL@@": 1, "@@ENCODED_VALIDATOR@@": 1 },
  "trajecta-mcp.cmd.tmpl": { "@@ROOT_SH@@": 0, "@@ROOT_PS@@": 0, "@@POWERSHELL@@": 1, "@@ENCODED_VALIDATOR@@": 1 },
  "validator.ps1.tmpl": { "@@ROOT_SH@@": 0, "@@ROOT_PS@@": 1, "@@POWERSHELL@@": 0, "@@ENCODED_VALIDATOR@@": 0 },
} as const;
export type TemplateName = keyof typeof TEMPLATE_COUNTS;
type Token = keyof (typeof TEMPLATE_COUNTS)[TemplateName];
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}
export function shQuote(value: string): string {
  if (value.includes("\0")) throw new TemplateError("shell path contains NUL");
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
function splitTemplate(name: TemplateName, source: string): string[] {
  if (!Object.hasOwn(TEMPLATE_COUNTS, name)) throw new TemplateError("unknown wrapper template");
  const tokens = Object.keys(TEMPLATE_COUNTS[name]) as Token[],
    parts = source.split(new RegExp("(" + tokens.join("|") + ")", "u"));
  for (const literal of parts.filter((_, i) => i % 2 === 0))
    if (literal.includes("@@")) throw new TemplateError("unknown or malformed wrapper token");
  for (const token of tokens)
    if (parts.filter((part, i) => i % 2 === 1 && part === token).length !== TEMPLATE_COUNTS[name][token])
      throw new TemplateError("wrapper token count differs: " + token);
  return parts;
}
export function renderTemplate(
  name: TemplateName,
  source: string,
  input: { root: string; powershell?: string; validator?: string },
): string {
  const parts = splitTemplate(name, source),
    values: Partial<Record<Token, string>> = {
      "@@ROOT_SH@@": shQuote(input.root),
      "@@ROOT_PS@@": "'" + input.root.replaceAll("'", "''") + "'",
    };
  if (TEMPLATE_COUNTS[name]["@@POWERSHELL@@"]) {
    if (
      !input.powershell ||
      !/^[\x20-\x7e]+$/u.test(input.powershell) ||
      /[%!^&|<>"()]/u.test(input.powershell) ||
      !/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(input.powershell)
    )
      throw new TemplateError("system PowerShell path is not absolute cmd-safe ASCII");
    values["@@POWERSHELL@@"] = input.powershell;
    if (input.validator === undefined) throw new TemplateError("missing rendered validator");
    values["@@ENCODED_VALIDATOR@@"] = Buffer.from(input.validator, "utf16le").toString("base64");
  }
  // Only the original literal segments and tokens are visited; values are never rescanned.
  const output = parts.map((part, i) => (i % 2 === 0 ? part : values[part as Token]!)).join("");
  if (
    name.endsWith(".cmd.tmpl") &&
    output.split(/\r?\n/u).some((line) => line.includes("-EncodedCommand") && line.length > 8000)
  )
    throw new TemplateError("Windows validator invocation exceeds 8000 characters");
  return output;
}
export function readTemplate(name: TemplateName): string {
  try {
    const bytes = fs.readFileSync(new URL("../../bin/templates/" + name, import.meta.url));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TemplateError("missing or invalid wrapper template: " + name);
  }
}
export function templateFiles(directory: string): Record<string, Buffer> {
  const names = Object.keys(TEMPLATE_COUNTS).sort() as TemplateName[];
  if (!fs.existsSync(directory) || JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(names))
    throw new TemplateError("release requires complete bin/templates/");
  const result: Record<string, Buffer> = {};
  for (const name of names) {
    const path = join(directory, name),
      stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new TemplateError("invalid wrapper template file");
    const bytes = fs.readFileSync(path);
    splitTemplate(name, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    result["bin/templates/" + name] = bytes;
  }
  return result;
}
