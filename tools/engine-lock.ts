import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
export const order = (a: string, b: string): number => {
  const aa = Array.from(a, (c) => c.codePointAt(0)!);
  const bb = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
};
export type Pin = {
  repository: string;
  commit: string;
  subdirectory: string;
  paths: string[];
  files: Record<string, string>;
  supplemental?: { paths: string[]; destination: string; files: Record<string, string> };
};
export type Lock = { schema: string; engines: Record<"identity" | "work", Pin> };
export function readLock(): Lock {
  return JSON.parse(fs.readFileSync(join(ROOT, "engines.lock.json"), "utf8"));
}
export function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
}
export function checkout(name: string, pin: Pick<Pin, "repository" | "commit">, fetch = true): string {
  if (!/^[0-9a-f]{40}$/.test(pin.commit)) throw new Error("engine commit must be a full SHA");
  const folder = join(ROOT, ".isolation", "upstream", name);
  fs.mkdirSync(folder, { recursive: true });
  if (!fs.existsSync(join(folder, ".git"))) {
    git(folder, ["init"]);
    git(folder, ["remote", "add", "origin", pin.repository]);
  }
  if (git(folder, ["remote", "get-url", "origin"]) !== pin.repository) throw new Error("engine cache origin mismatch");
  if (fetch) git(folder, ["fetch", "--depth=1", "origin", pin.commit]);
  git(folder, ["checkout", "--detach", pin.commit]);
  if (git(folder, ["rev-parse", "HEAD"]) !== pin.commit) throw new Error("engine checkout mismatch");
  if (git(folder, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("dirty engine cache");
  return folder;
}
export function filesIn(folder: string): Record<string, Buffer> {
  const result: Record<string, Buffer> = {};
  const walk = (relative: string) => {
    const full = join(folder, relative),
      stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`symlink in payload: ${relative}`);
    if (stat.isDirectory())
      for (const name of fs.readdirSync(full).sort(order)) walk(relative ? relative + "/" + name : name);
    else if (stat.isFile()) result[relative] = fs.readFileSync(full);
    else throw new Error(`non-file payload: ${relative}`);
  };
  for (const name of fs.readdirSync(folder).sort(order)) walk(name);
  return result;
}
export function selected(folder: string, paths: string[]): Record<string, Buffer> {
  const all: Record<string, Buffer> = {};
  for (const path of paths) {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))
      throw new Error("unsafe engine path");
    const full = join(folder, path),
      stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error("symlink engine path");
    if (stat.isFile()) all[path] = fs.readFileSync(full);
    else if (stat.isDirectory())
      for (const [name, bytes] of Object.entries(filesIn(full))) all[path + "/" + name] = bytes;
    else throw new Error("non-file engine path");
  }
  return Object.fromEntries(Object.entries(all).sort(([a], [b]) => order(a, b)));
}
export function verify(files: Record<string, Buffer>, expected: Record<string, string>): void {
  if (JSON.stringify(Object.keys(files).sort(order)) !== JSON.stringify(Object.keys(expected).sort(order)))
    throw new Error("engine file inventory mismatch");
  for (const [file, bytes] of Object.entries(files))
    if (sha(bytes) !== expected[file]) throw new Error(`engine digest mismatch: ${file}`);
}
export function engineFiles(lock: Lock, fetch = true): Record<string, Buffer> {
  const output: Record<string, Buffer> = {};
  for (const name of ["identity", "work"] as const) {
    const pin = lock.engines[name],
      root = checkout(name, pin, fetch);
    const files = selected(join(root, pin.subdirectory), pin.paths);
    verify(files, pin.files);
    const pkg = JSON.parse(files["package.json"].toString("utf8"));
    if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length)
      throw new Error("engine dependency found");
    for (const [file, bytes] of Object.entries(files)) output[`engines/${name}/${file}`] = bytes;
    if (pin.supplemental) {
      const extra = selected(root, pin.supplemental.paths);
      verify(extra, pin.supplemental.files);
      for (const [file, bytes] of Object.entries(extra))
        output[pin.supplemental.destination + "/" + file.slice("trajecta_identity/profiles/".length)] = bytes;
    }
  }
  return output;
}
export function vendor(lock = readLock(), fetch = true): void {
  const files = engineFiles(lock, fetch);
  fs.rmSync(join(ROOT, "engines"), { recursive: true, force: true });
  for (const [file, bytes] of Object.entries(files)) {
    fs.mkdirSync(dirname(join(ROOT, file)), { recursive: true });
    fs.writeFileSync(join(ROOT, file), bytes);
  }
}
