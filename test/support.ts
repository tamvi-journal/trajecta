import assert from "node:assert/strict";
import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha, order } from "../tools/engine-lock.ts";
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(ROOT, "product/src/cli.ts");
export const TEMP = join(ROOT, ".isolation/tmp");
fs.mkdirSync(TEMP, { recursive: true });
export function contained(path: string): void {
  const part = relative(TEMP, resolve(path));
  assert(!isAbsolute(part) && part !== ".." && !part.startsWith(".." + (process.platform === "win32" ? "\\" : "/")));
}
export function temporary(): string {
  return fs.realpathSync.native(fs.mkdtempSync(join(TEMP, "m2-")));
}
export function isolatedEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: join(root, "local"),
    APPDATA: join(root, "roaming"),
    XDG_DATA_HOME: join(root, "xdg"),
    TRAJECTA_IDENTITY_DATA_DIR: join(root, "identity"),
    TRAJECTA_IDENTITY_PROFILES: join(root, "profiles"),
    TRAJECTA_HOME: join(root, "work"),
    TRAJECTA_PROOF_ROOT: join(root, "proof"),
    TMPDIR: TEMP,
    TEMP: TEMP,
    TMP: TEMP,
  };
  for (const key of ["SYSTEMROOT", "COMSPEC"]) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
export function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(root)) return { "<absent>": "" };
  const walk = (path: string, prefix: string) => {
    for (const name of fs.readdirSync(path).sort(order)) {
      const full = join(path, name),
        key = prefix + name,
        stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        result[key + "/"] = "";
        walk(full, key + "/");
      } else if (stat.isFile()) result[key] = sha(fs.readFileSync(full));
      else result[key] = fs.readlinkSync(full);
    }
  };
  walk(root, "");
  return result;
}
export function snapshot(root: string): { restore(): void; dispose(): void } {
  contained(root);
  const backup = temporary(),
    copy = join(backup, "copy"),
    exists = fs.existsSync(root);
  if (exists) fs.cpSync(root, copy, { recursive: true, preserveTimestamps: true });
  return {
    restore() {
      contained(root);
      fs.rmSync(root, { recursive: true, force: true });
      if (exists) fs.cpSync(copy, root, { recursive: true, preserveTimestamps: true });
    },
    dispose() {
      fs.rmSync(backup, { recursive: true, force: true });
    },
  };
}
