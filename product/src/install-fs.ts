import * as fs from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { checkpoint } from "./checkpoint.ts";

export const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
export function regular(path: string): boolean {
  try {
    if (!fs.lstatSync(path).isFile()) throw new Error(`not a regular file: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export function safeRoot(root: string): void {
  let path = resolve(root);
  for (;;) {
    try {
      const stat = fs.lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe install directory: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(path) === path) break;
    path = dirname(path);
  }
}
export function beneath(root: string, path: string): string {
  const part = relative(resolve(root), resolve(path));
  if (!part || isAbsolute(part) || part === ".." || part.startsWith(".." + sep))
    throw new Error(`path outside install root: ${path}`);
  safeRoot(dirname(path));
  return part.split(sep).join("/");
}
export function syncDir(path: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(path, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function atomic(path: string, bytes: Buffer, point: string, mode = 0o600): void {
  safeRoot(dirname(path));
  regular(path);
  const tmp = path + ".tmp";
  if (regular(tmp)) fs.unlinkSync(tmp);
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  checkpoint(point + ":before-rename");
  fs.renameSync(tmp, path);
  syncDir(dirname(path));
  checkpoint(point + ":after-rename");
}
export function readJson(path: string): any {
  return regular(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : null;
}
export const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + "\n");
