import * as fs from "node:fs";
import { join, isAbsolute, win32, relative, sep, resolve } from "node:path";
import { canonicalProductJson, parseCanonicalProductJson, productMetadataVersion } from "./engines.ts";
import { pluginDefaults, pluginFiles, pluginStem, pluginZip, pluginVersion, type PluginOptions } from "./plugin.ts";
import { digest, jsonBytes, syncDir } from "./install-fs.ts";
import { ledger, saveLedger, type Ledger, type Entry } from "./owned.ts";
import { checkpoint } from "./checkpoint.ts";
import { hostname } from "node:os";
import { owner } from "./install-lock.ts";

export class PluginDirectoryError extends Error {
  constructor(path: string) {
    super(`plugin directory ${path} is not a product-owned real directory; nothing was written`);
    this.name = "PluginDirectoryError";
  }
}
export class PluginModified extends Error {
  constructor(root: string, plugin: string, paths: string[]) {
    super(
      `plugin ${plugin} was modified (${paths.join(", ")}); move those paths out of ${join(root, "plugins", plugin)}/ and run trajecta plugin --profile … again`,
    );
    this.name = "PluginModified";
  }
}
export type Recipe = {
  schema: "trajecta.plugin-recipe/v1";
  target: "posix" | "windows";
  profile: string;
  name: string | null;
  db: string | null;
  defaults: Record<string, string>;
  plugin_sha256: string;
};
export type PreparedPlugin = { name: string; recipe: Recipe; recipeBytes: Buffer; bytes: Buffer };
type Identity = { dev: string; ino: string };
type Generation = { generation: number; base: string; entries: Array<[string, Entry]> };
type Current = Generation & { recipe: Recipe; path: string };
const FILES = [".planned.json", "recipe.json", "trajecta.plugin"];
const DEFAULTS = new Set([
  "TRAJECTA_IDENTITY_DATA_DIR",
  "TRAJECTA_IDENTITY_PROFILES",
  "TRAJECTA_WORK_ROOT",
  "TRAJECTA_HOME",
]);
function assertOwner(root: string, data: Ledger): void {
  const path = join(root, ".lock"),
    stat = lstat(path);
  const held = stat?.isFile() && !stat.isSymbolicLink() ? owner(fs.readFileSync(path)) : undefined;
  if (!held || held.pid !== process.pid || held.hostname !== hostname() || data.root !== root)
    throw new Error("plugin transaction requires its own process lock owner");
}
function lstat(path: string) {
  try {
    return fs.lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function identity(stat: fs.BigIntStats): Identity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function same(stat: fs.BigIntStats, receipt: Identity): boolean {
  return String(stat.dev) === receipt.dev && String(stat.ino) === receipt.ino;
}
function checkedFile(path: string): Buffer {
  const before = lstat(path);
  if (!before || !before.isFile() || before.isSymbolicLink()) throw new PluginDirectoryError(path);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !same(opened, identity(before))) throw new PluginDirectoryError(path);
    const bytes = fs.readFileSync(fd),
      after = lstat(path);
    if (!after || !after.isFile() || after.isSymbolicLink() || !same(after, identity(before)))
      throw new PluginDirectoryError(path);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
function real(path: string, receipt?: Identity): fs.BigIntStats {
  const stat = lstat(path);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || (receipt && !same(stat, receipt)))
    throw new PluginDirectoryError(path);
  return stat;
}
export function preflightPluginRoot(root: string): void {
  if (lstat(root)) real(root);
}
function validateName(name: string): void {
  if (!/^trajecta-[^/\\\x00-\x1f]+$/u.test(name)) throw new PluginDirectoryError(name);
}
function dir(root: string, name: string, data: Ledger, allowMissing = false): fs.BigIntStats | undefined {
  real(root);
  let full = root;
  for (const part of name.split("/")) {
    full = join(full, part);
    const key = relative(root, full).split(sep).join("/"),
      stat = lstat(full),
      receipt = data.entries[key];
    if (!stat && allowMissing && !receipt) return undefined;
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new PluginDirectoryError(full);
    if (receipt?.kind === "dir") {
      if (!same(stat, receipt)) throw new PluginDirectoryError(full);
    } else if (!(allowMissing && !receipt && fs.readdirSync(full).length === 0)) throw new PluginDirectoryError(full);
  }
  return real(full);
}
function groups(name: string, data: Ledger): { committed: Generation[]; tombstones: Generation[] } {
  validateName(name);
  const sets = new Map<number, Array<[string, Entry]>>();
  for (const [path, entry] of Object.entries(data.entries))
    if ("plugin" in entry && entry.plugin === name && "generation" in entry && entry.generation !== undefined) {
      const entries = sets.get(entry.generation) ?? [];
      entries.push([path, entry]);
      sets.set(entry.generation, entries);
    }
  const committed: Generation[] = [],
    tombstones: Generation[] = [];
  for (const [generation, entries] of sets) {
    const base = `plugins/${name}/g${generation}`,
      item = { generation, base, entries };
    if (entries.length === 1 && entries[0][0] === base && entries[0][1].kind === "tombstone") tombstones.push(item);
    else if (
      entries.length === 4 &&
      entries.some(([key, entry]) => key === base && entry.kind === "dir") &&
      FILES.every((file) => entries.some(([key, entry]) => key === base + "/" + file && entry.kind === "file"))
    )
      committed.push(item);
    else throw new Error("invalid plugin 0-or-4 receipts: " + base);
  }
  return { committed, tombstones };
}
function highWater(name: string, data: Ledger): Generation | undefined {
  const values = groups(name, data);
  return [...values.committed, ...values.tombstones].sort((a, b) => b.generation - a.generation)[0];
}
function checkRecipe(value: any): asserts value is Recipe {
  const fields = ["schema", "target", "profile", "name", "db", "defaults", "plugin_sha256"];
  if (
    !value ||
    Object.keys(value).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(value, k)) ||
    value.schema !== "trajecta.plugin-recipe/v1" ||
    !["posix", "windows"].includes(value.target) ||
    typeof value.profile !== "string" ||
    !(value.name === null || typeof value.name === "string") ||
    !(
      value.db === null ||
      (typeof value.db === "string" && (value.target === "windows" ? win32.isAbsolute(value.db) : isAbsolute(value.db)))
    ) ||
    !/^[a-f0-9]{64}$/u.test(value.plugin_sha256) ||
    !value.defaults ||
    Object.entries(value.defaults).some(([key, value]) => !DEFAULTS.has(key) || typeof value !== "string")
  )
    throw new Error("invalid plugin recipe");
}
export async function preparePlugin(
  opts: PluginOptions,
  target: "posix" | "windows" = process.platform === "win32" ? "windows" : "posix",
  defaults = pluginDefaults(opts),
): Promise<PreparedPlugin> {
  const bytes = pluginZip(await pluginFiles(opts, target, defaults));
  const recipe: Recipe = {
    schema: "trajecta.plugin-recipe/v1",
    target,
    profile: opts.profile,
    name: opts.name ?? null,
    db: opts.db === undefined ? null : target === "windows" ? win32.resolve(opts.db) : resolve(opts.db),
    defaults,
    plugin_sha256: digest(bytes),
  };
  checkRecipe(recipe);
  const recipeBytes = await canonicalProductJson(recipe);
  // Validate stored bytes in Phase A as well. Both codec entries must be loaded
  // while the verified staged tree still exists, before its version rename.
  checkRecipe(await parseCanonicalProductJson(recipeBytes));
  return { name: await pluginStem(opts.profile), recipe, recipeBytes, bytes };
}
export async function preparedFromBytes(name: string, recipeBytes: Buffer, bytes: Buffer): Promise<PreparedPlugin> {
  const recipe = await parseCanonicalProductJson(recipeBytes);
  checkRecipe(recipe);
  if (recipe.plugin_sha256 !== digest(bytes) || name !== (await pluginStem(recipe.profile)))
    throw new Error("staged plugin recipe differs");
  return { name, recipe, recipeBytes, bytes };
}
/** Read-only inspection. High-water tombstones suppress all older committed recipes. */
export async function currentGeneration(root: string, name: string, data: Ledger): Promise<Current | undefined> {
  validateName(name);
  const top = highWater(name, data);
  if (!top || top.entries[0][1].kind === "tombstone") return undefined;
  dir(root, `plugins/${name}`, data);
  const path = join(root, top.base),
    directory = top.entries.find(([key]) => key === top.base)![1];
  if (directory.kind !== "dir") throw new Error("invalid plugin directory receipt");
  try {
    real(path, directory);
  } catch {
    return undefined;
  }
  const contents: Record<string, Buffer> = {};
  for (const file of FILES) {
    dir(root, top.base, data);
    const full = join(path, file),
      receipt = top.entries.find(([key]) => key === top.base + "/" + file)![1],
      stat = lstat(full);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || receipt.kind !== "file") return undefined;
    contents[file] = checkedFile(full);
    dir(root, top.base, data);
    if (digest(contents[file]) !== receipt.sha256) return undefined;
  }
  try {
    const recipe = await parseCanonicalProductJson(contents["recipe.json"]);
    checkRecipe(recipe);
    if (recipe.plugin_sha256 !== digest(contents["trajecta.plugin"])) return undefined;
    real(path, directory);
    dir(root, `plugins/${name}`, data);
    return { ...top, recipe, path: join(path, "trajecta.plugin") };
  } catch {
    return undefined;
  }
}
/** Preflight all existing components before a mkdir, cleanup or ledger mutation. */
async function inspect(root: string, name: string, data: Ledger) {
  validateName(name);
  const parent = `plugins/${name}`;
  const exists = dir(root, parent, data, true),
    generations = groups(name, data);
  let max = Math.max(
    0,
    ...generations.committed.map((g) => g.generation),
    ...generations.tombstones.map((g) => g.generation),
  );
  const leftovers: string[] = [];
  if (exists)
    for (const item of fs.readdirSync(join(root, parent))) {
      const match = /^g([0-9]{1,9})$/u.exec(item);
      if (!match || Number(match[1]) === 0) continue;
      max = Math.max(max, Number(match[1]));
      const path = join(root, parent, item);
      real(path); // Never descend into unreceipted or reparse generation entries.
      if (!generations.committed.some((g) => g.base === parent + "/" + item)) leftovers.push(path);
    }
  const top = highWater(name, data),
    current = await currentGeneration(root, name, data);
  if (top && top.entries[0][1].kind !== "tombstone" && !current && lstat(join(root, top.base)))
    throw new PluginModified(root, name, [top.base]);
  if (max >= 999999999) throw new Error("plugin generation limit reached");
  return { max, current, top, leftovers };
}
export async function preflightPlugin(root: string, name: string, data: Ledger): Promise<void> {
  await inspect(root, name, data);
}
function ensureParent(root: string, key: string, data: Ledger): void {
  const parts = key.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const name = parts.slice(0, i).join("/"),
      full = join(root, name);
    if (data.entries[name]) {
      dir(root, name, data);
      continue;
    }
    if (i > 1) dir(root, parts.slice(0, i - 1).join("/"), data);
    else real(root);
    let stat = lstat(full);
    if (!stat) {
      checkpoint("plugin:mkdir:before:" + name);
      fs.mkdirSync(full);
      checkpoint("plugin:mkdir:after:" + name);
      stat = real(full);
    } else if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(full).length)
      throw new PluginDirectoryError(full);
    data.entries[name] = { kind: "dir", scope: "shared", ...identity(stat) };
    checkpoint("plugin:dir-ledger:before:" + name);
    saveLedger(root, data);
    checkpoint("plugin:dir-ledger:after:" + name);
  }
}
function checkNew(root: string, name: string, generation: string, expected: Identity, data: Ledger): void {
  dir(root, `plugins/${name}`, data);
  real(join(root, generation), expected);
}
function newFile(
  root: string,
  name: string,
  base: string,
  expected: Identity,
  file: string,
  bytes: Buffer,
  data: Ledger,
): void {
  checkNew(root, name, base, expected, data);
  const path = join(root, base, file),
    tmp = path + ".tmp";
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
    0o644,
  );
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, 0o644);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  checkNew(root, name, base, expected, data);
  if (lstat(path)) throw new PluginDirectoryError(path);
  checkpoint("plugin:file:before-rename:" + file);
  fs.renameSync(tmp, path);
  checkpoint("plugin:file:after-rename:" + file);
  checkNew(root, name, base, expected, data);
  syncDir(join(root, base));
}
function removeGeneration(root: string, item: Generation, data: Ledger): string[] {
  const path = join(root, item.base),
    remaining: string[] = [],
    receipt = item.entries.find(([key]) => key === item.base)![1];
  dir(root, item.base.split("/").slice(0, -1).join("/"), data);
  if (lstat(path)) {
    try {
      if (receipt.kind !== "dir") throw new Error();
      real(path, receipt);
    } catch {
      return [path];
    }
    for (const file of FILES) {
      dir(root, item.base, data);
      const full = join(path, file),
        stat = lstat(full),
        entry = item.entries.find(([key]) => key === item.base + "/" + file)![1];
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink() || entry.kind !== "file") {
        remaining.push(full);
        continue;
      }
      const bytes = checkedFile(full);
      if (digest(bytes) !== entry.sha256) {
        remaining.push(full);
        continue;
      }
      dir(root, item.base, data);
      checkpoint("plugin:retire:before-unlink:" + item.generation + ":" + file);
      fs.unlinkSync(full);
      checkpoint("plugin:retire:after-unlink:" + item.generation + ":" + file);
      dir(root, item.base, data);
    }
    if (!fs.readdirSync(path).length) {
      checkpoint("plugin:retire:before-rmdir:" + item.generation);
      fs.rmdirSync(path);
      checkpoint("plugin:retire:after-rmdir:" + item.generation);
    } else remaining.push(path);
  }
  if (!lstat(path)) {
    for (const [key] of item.entries) delete data.entries[key];
    checkpoint("plugin:retire:before-ledger:" + item.generation);
    saveLedger(root, data);
    checkpoint("plugin:retire:after-ledger:" + item.generation);
  }
  return remaining;
}
export async function buildGeneration(root: string, prepared: PreparedPlugin, data: Ledger): Promise<Current> {
  assertOwner(root, data);
  const { name } = prepared,
    state = await inspect(root, name, data);
  if (name !== (await pluginStem(prepared.recipe.profile))) throw new Error("prepared plugin name differs");
  checkRecipe(prepared.recipe);
  if (
    prepared.recipe.plugin_sha256 !== digest(prepared.bytes) ||
    !(await canonicalProductJson(prepared.recipe)).equals(prepared.recipeBytes)
  )
    throw new Error("prepared plugin bytes differ");
  if (state.top && state.top.entries[0][1].kind !== "tombstone" && !state.current) {
    for (const [key] of state.top.entries) delete data.entries[key];
    data.entries[state.top.base] = { kind: "tombstone", plugin: name, generation: state.top.generation };
    checkpoint("plugin:tombstone:before");
    saveLedger(root, data);
    checkpoint("plugin:tombstone:after");
  }
  ensureParent(root, `plugins/${name}`, data);
  let n = state.max + 1,
    base: string,
    id: Identity;
  for (;;) {
    if (n > 999999999) throw new Error("plugin generation limit reached");
    base = `plugins/${name}/g${n}`;
    dir(root, `plugins/${name}`, data);
    checkpoint(`plugin:g${n}:mkdir:before`);
    try {
      fs.mkdirSync(join(root, base));
      id = identity(real(join(root, base)));
      checkpoint(`plugin:g${n}:mkdir:after`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      n++;
    }
  }
  const files: Record<string, Buffer> = { "recipe.json": prepared.recipeBytes, "trajecta.plugin": prepared.bytes };
  files[".planned.json"] = jsonBytes({
    schema: "trajecta.plugin-generation/v1",
    plugin: name,
    generation: n,
    files: Object.fromEntries(Object.entries(files).map(([key, bytes]) => [key, digest(bytes)])),
  });
  for (const file of FILES) newFile(root, name, base!, id!, file, files[file], data);
  for (const file of FILES) {
    checkNew(root, name, base!, id!, data);
    if (!checkedFile(join(root, base!, file)).equals(files[file]))
      throw new Error("plugin generation differs from plan");
    checkNew(root, name, base!, id!, data);
  }
  checkNew(root, name, base!, id!, data);
  data.entries[base!] = { kind: "dir", scope: "shared", ...id!, plugin: name, generation: n };
  for (const file of FILES)
    data.entries[base! + "/" + file] = {
      kind: "file",
      scope: "shared",
      sha256: digest(files[file]),
      plugin: name,
      generation: n,
    };
  checkpoint("plugin:commit:before");
  saveLedger(root, data);
  checkpoint("plugin:commit:after");
  const current = await currentGeneration(root, name, data);
  if (!current) throw new Error("new committed plugin is invalid");
  if (state.leftovers.length)
    process.stdout.write("trajecta: retained uncommitted plugin generations: " + state.leftovers.join(", ") + "\n");
  await resumePluginRetirement(root, name, data);
  process.stdout.write(current.path + "\n");
  return current;
}
/** Install retries may already have committed the new generation before their effect receipt. */
export async function resumePluginRetirement(root: string, name: string, data: Ledger): Promise<void> {
  assertOwner(root, data);
  const current = await currentGeneration(root, name, data);
  if (!current) throw new PluginModified(root, name, [highWater(name, data)?.base ?? `plugins/${name}`]);
  for (const old of groups(name, data).committed.filter((item) => item.generation < current.generation)) {
    const retained = removeGeneration(root, old, data);
    if (retained.length) process.stdout.write("trajecta: retained " + retained.join(", ") + "\n");
  }
}
/** Future update's narrow entry: an invalid/absent current causes no write or cleanup. */
export async function rebuildCurrent(root: string, name: string, data: Ledger): Promise<Current | undefined> {
  let current: Current | undefined;
  try {
    current = await currentGeneration(root, name, data);
  } catch {
    current = undefined;
  }
  if (!current) {
    process.stdout.write(
      "trajecta: " + new PluginModified(root, name, [highWater(name, data)?.base ?? `plugins/${name}`]).message + "\n",
    );
    return undefined;
  }
  const r = current.recipe;
  return buildGeneration(
    root,
    await preparePlugin(
      {
        root,
        profile: r.profile,
        ...(r.name === null ? {} : { name: r.name }),
        ...(r.db === null ? {} : { db: r.db }),
      },
      r.target,
      r.defaults,
    ),
    data,
  );
}
export async function removeAllPlugins(root: string, data: Ledger): Promise<string[]> {
  assertOwner(root, data);
  if (fs.readFileSync(join(root, "current"), "utf8") !== "uninstalling\n")
    throw new Error("plugin removal requires full uninstall sentinel");
  const names = new Set(
      Object.values(data.entries)
        .filter((entry) => "plugin" in entry && entry.plugin)
        .map((entry) => (entry as any).plugin as string),
    ),
    remaining: string[] = [];
  if (lstat(join(root, "plugins"))) {
    try {
      dir(root, "plugins", data);
    } catch (error) {
      if (error instanceof PluginDirectoryError) return [join(root, "plugins")];
      throw error;
    }
  }
  for (const name of names) {
    for (const item of groups(name, data).committed) remaining.push(...removeGeneration(root, item, data));
    for (const item of groups(name, data).tombstones) {
      delete data.entries[item.base];
      saveLedger(root, data);
    }
  }
  const directories = Object.entries(data.entries)
    .filter(([key, entry]) => entry.kind === "dir" && (key === "plugins" || /^plugins\/[^/]+$/u.test(key)))
    .sort(([a], [b]) => b.split("/").length - a.split("/").length);
  for (const [key, receipt] of directories) {
    const path = join(root, key);
    if (lstat(path)) {
      try {
        if (receipt.kind !== "dir") throw new Error();
        dir(root, key, data);
        if (fs.readdirSync(path).length) {
          remaining.push(path);
          continue;
        }
        checkpoint("plugin:remove-dir:before:" + key);
        dir(root, key, data);
        fs.rmdirSync(path);
        checkpoint("plugin:remove-dir:after:" + key);
      } catch (error) {
        if (error instanceof PluginDirectoryError) {
          remaining.push(path);
          continue;
        }
        throw error;
      }
    }
    delete data.entries[key];
    saveLedger(root, data);
  }
  return [...new Set(remaining)];
}
export async function reportPlugins(root: string, data: Ledger): Promise<void> {
  const names = new Set(
    Object.values(data.entries)
      .filter((entry) => "plugin" in entry && entry.plugin)
      .map((entry) => (entry as any).plugin as string),
  );
  for (const [key, entry] of Object.entries(data.entries))
    if (entry.kind === "dir" && /^plugins\/[^/]+$/u.test(key)) names.add(key.slice("plugins/".length));
  for (const name of names) {
    let current: Current | undefined;
    try {
      current = await currentGeneration(root, name, data);
    } catch {}
    if (current) {
      process.stdout.write(current.path + "\n");
      const built = await pluginVersion(checkedFile(current.path)),
        version = await productMetadataVersion(fs.readFileSync(new URL("../package.json", import.meta.url)));
      if (built !== version)
        process.stdout.write(`trajecta: plugin ${name} built ${built}; current ${version} (information only)\n`);
    } else
      process.stdout.write(
        "trajecta: " +
          new PluginModified(root, name, [highWater(name, data)?.base ?? `plugins/${name}`]).message +
          "\n",
      );
  }
}
