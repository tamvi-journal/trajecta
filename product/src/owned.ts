import * as fs from "node:fs";
import { dirname, join, relative, sep, isAbsolute } from "node:path";
import { atomic, beneath, digest, jsonBytes, readJson, regular, safeRoot } from "./install-fs.ts";
import { verifyMetadata, authenticateManifest } from "./release.ts";
import { readShared, validateShared } from "./shared-effects.ts";

export type Entry =
  | { kind: "file"; sha256: string; scope: string }
  | { kind: "directory"; scope: string }
  | { kind: "external-report"; scope: "shared"; dev: string; ino: string };
export type Ledger = {
  schema: "trajecta.owned/v1";
  root: string;
  entries: Record<string, Entry>;
  effects: Record<string, unknown>;
};
export function versionName(value: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(value)) throw new Error("invalid version");
  return value;
}
export function ledger(root: string): Ledger {
  const data = readJson(join(root, "owned.json")) ?? { schema: "trajecta.owned/v1", root, entries: {}, effects: {} };
  if (data.schema !== "trajecta.owned/v1" || data.root !== root || !data.entries || !data.effects)
    throw new Error("invalid ownership ledger");
  for (const [path, entry] of Object.entries(data.entries) as Array<[string, Entry]>) {
    if (entry.kind === "external-report") {
      if (!isAbsolute(path) || entry.scope !== "shared" || !/^\d+$/u.test(entry.dev) || !/^\d+$/u.test(entry.ino))
        throw new Error("unsafe external report");
      continue;
    }
    if (
      beneath(root, join(root, path)) !== path ||
      !["file", "directory"].includes(entry.kind) ||
      (entry.kind === "file" && !/^[a-f0-9]{64}$/u.test(entry.sha256)) ||
      typeof entry.scope !== "string"
    )
      throw new Error("unsafe ownership ledger");
    if (entry.scope !== "shared" && !path.startsWith(versionName(entry.scope) + "/") && path !== entry.scope)
      throw new Error("ownership path/scope mismatch");
  }
  return data;
}
export function saveLedger(root: string, data: Ledger): void {
  atomic(join(root, "owned.json"), jsonBytes(data), "ledger");
}
export function walk(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  safeRoot(root);
  const paths: string[] = [];
  function visit(folder: string) {
    for (const name of fs.readdirSync(folder).sort()) {
      const path = join(folder, name),
        stat = fs.lstatSync(path);
      paths.push(path);
      if (stat.isDirectory()) visit(path);
    }
  }
  visit(root);
  return paths;
}
export function verifyVersion(folder: string): any {
  safeRoot(folder);
  for (const name of ["release.json", "release.json.sig", "MANIFEST.json", "node"])
    if (!regular(join(folder, name))) throw new Error(`missing version control: ${name}`);
  const metadata = verifyMetadata(
    fs.readFileSync(join(folder, "release.json")),
    fs.readFileSync(join(folder, "release.json.sig"), "utf8"),
  );
  const manifestBytes = fs.readFileSync(join(folder, "MANIFEST.json"));
  const manifest = authenticateManifest(manifestBytes, metadata, "stored");
  for (const [path, expected] of Object.entries(manifest.files) as Array<[string, { size: number; sha256: string }]>) {
    const file = join(folder, path);
    if (beneath(folder, file) !== path || !regular(file)) throw new Error("missing version file");
    const bytes = fs.readFileSync(file);
    if (bytes.length !== expected.size || digest(bytes) !== expected.sha256)
      throw new Error(`version digest mismatch: ${path}`);
  }
  return manifest;
}
export function buildPlan(
  root: string,
  version: string,
  manifest: any,
  createdDirectories?: string[],
  bootstrap?: { db: string; absent: boolean },
): any {
  const folder = join(root, version),
    files: Record<string, string> = {};
  for (const path of [
    ...Object.keys(manifest.files),
    "MANIFEST.json",
    "release.json",
    "release.json.sig",
    "node",
    ...walk(join(folder, ".install-effects"))
      .filter((path) => fs.lstatSync(path).isFile())
      .map((path) => relative(folder, path).split(sep).join("/")),
  ].sort())
    files[version + "/" + path] = digest(fs.readFileSync(join(folder, path)));
  const implied = new Set<string>([version]);
  for (const name of Object.keys(files).map((name) => name.slice(version.length + 1))) {
    let parent = dirname(name).split(sep).join("/");
    while (parent !== ".") {
      implied.add(version + "/" + parent);
      parent = dirname(parent).split(sep).join("/");
    }
  }
  const directories = (createdDirectories ?? [...implied]).sort();
  return {
    schema: "trajecta.planned/v1",
    version,
    manifest_sha256: digest(fs.readFileSync(join(folder, "MANIFEST.json"))),
    ledger: "owned.json",
    files,
    directories,
    effects: ["identity-public-init", "doctor"],
    bootstrap,
    ...(readShared(folder) ? { shared: readShared(folder) } : {}),
  };
}
export function adopt(root: string, version: string, data: Ledger, includePlan = false): void {
  const path = join(root, version, ".planned.json"),
    plan = readJson(path);
  if (!plan) return;
  if (
    plan.schema !== "trajecta.planned/v1" ||
    plan.version !== version ||
    !plan.files ||
    !Array.isArray(plan.directories)
  )
    throw new Error("invalid plan");
  for (const [name, sha256] of Object.entries(plan.files) as Array<[string, string]>) {
    if (!name.startsWith(version + "/") || beneath(root, join(root, name)) !== name || !/^[a-f0-9]{64}$/u.test(sha256))
      throw new Error("unsafe plan");
    const file = join(root, name);
    if (!data.entries[name] && regular(file) && digest(fs.readFileSync(file)) === sha256)
      data.entries[name] = { kind: "file", sha256, scope: version };
  }
  for (const directory of plan.directories) {
    if (
      (directory !== version && !directory.startsWith(version + "/")) ||
      beneath(root, join(root, directory)) !== directory
    )
      throw new Error("unsafe planned directory");
    safeRoot(join(root, directory));
    if (fs.existsSync(join(root, directory)) && !data.entries[directory])
      data.entries[directory] = { kind: "directory", scope: version };
  }
  if (includePlan && !data.entries[version + "/.planned.json"]) {
    const manifest = verifyVersion(join(root, version));
    const expected = jsonBytes(buildPlan(root, version, manifest, plan.directories, plan.bootstrap));
    if (fs.readFileSync(path).equals(expected))
      data.entries[version + "/.planned.json"] = { kind: "file", sha256: digest(expected), scope: version };
  }
  if (plan.shared) {
    const receipt = data.entries[version + "/.planned.json"];
    const shared =
      receipt?.kind === "file" && digest(fs.readFileSync(path)) === receipt.sha256
        ? plan.shared
        : readShared(join(root, version));
    validateShared(shared);
    if (JSON.stringify(shared) !== JSON.stringify(plan.shared))
      throw new Error("shared plan differs from staged bytes");
    for (const [name, entry] of Object.entries(shared!.files)) {
      const file = join(root, name);
      beneath(root, file);
      if (entry.eligible && !data.entries[name] && regular(file) && digest(fs.readFileSync(file)) === entry.sha256)
        data.entries[name] = { kind: "file", scope: "shared", sha256: entry.sha256 };
    }
    for (const name of shared!.directories)
      if (fs.existsSync(join(root, name)) && !data.entries[name]) {
        safeRoot(join(root, name));
        data.entries[name] = { kind: "directory", scope: "shared" };
      }
  }
  saveLedger(root, data);
}
