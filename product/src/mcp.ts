import { homedir } from "node:os";
import { runEngineMcp, type Engine } from "./engines.ts";

const KEYS = new Set([
  "TRAJECTA_IDENTITY_DATA_DIR",
  "TRAJECTA_IDENTITY_PROFILES",
  "TRAJECTA_WORK_ROOT",
  "TRAJECTA_HOME",
]);
export class RecipeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeUsageError";
  }
}
export type Recipe = { label: string; engine: Engine; defaults: Array<[string, string]>; args: string[] };
export function parseRecipe(argv: string[]): Recipe {
  const [label, option, engine] = argv;
  if (!label || !/^[A-Za-z0-9._-]{1,64}$/u.test(label)) throw new RecipeUsageError("invalid MCP label");
  if (option !== "--engine" || (engine !== "identity" && engine !== "work"))
    throw new RecipeUsageError("expected --engine identity|work");
  const defaults: Array<[string, string]> = [],
    seen = new Set<string>();
  let i = 3;
  for (; i < argv.length && argv[i] !== "--"; i += 3) {
    const [flag, key, value] = argv.slice(i, i + 3);
    if (flag !== "--default" || !KEYS.has(key) || value === undefined || seen.has(key))
      throw new RecipeUsageError("invalid or repeated MCP default");
    defaults.push([key, value]);
    seen.add(key);
  }
  if (argv[i] !== "--") throw new RecipeUsageError("missing -- before engine arguments");
  return { label, engine, defaults, args: argv.slice(i + 1) };
}
export function applyDefaults(recipe: Recipe, env: NodeJS.ProcessEnv = process.env, home = homedir): void {
  // Resolve the entire recipe first: a refusal must not leave half-applied defaults.
  const values: Array<[string, string]> = [];
  for (const [key, value] of recipe.defaults) {
    if (env[key]) continue;
    let resolved = value;
    if (value.startsWith("~/") || value.startsWith("$HOME/")) {
      const folder = home();
      if (!folder) throw new Error(`${recipe.label}: cannot resolve home folder for ${key}`);
      resolved = folder + value.slice(value.startsWith("~/") ? 1 : 5);
    }
    values.push([key, resolved]);
  }
  for (const [key, value] of values) env[key] = value;
}
export async function runMcp(argv: string[]): Promise<void> {
  let recipe: Recipe;
  try {
    recipe = parseRecipe(argv);
  } catch (error) {
    if (!(error instanceof RecipeUsageError)) throw error;
    process.stderr.write(`trajecta mcp: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    applyDefaults(recipe);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  await runEngineMcp(recipe.engine, recipe.args);
}
