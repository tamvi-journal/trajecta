import * as fs from "node:fs";
import { dirname, join, resolve, isAbsolute, delimiter } from "node:path";
import { homedir } from "node:os";
import { posixWrapper, windowsWrapper, userStub, WrapperBuildError, shQuote } from "./wrappers.ts";
import { pluginFiles, pluginName, pluginZip, type PluginOptions } from "./plugin.ts";
import { atomic, beneath, digest, jsonBytes, regular, safeRoot } from "./install-fs.ts";
import { checkpoint } from "./checkpoint.ts";
import { saveLedger, type Ledger } from "./owned.ts";

export type SharedPlan = {
  files: Record<string, { source: string; sha256: string; mode: number; eligible: boolean }>;
  directories: string[];
  userBin?: string;
};
/** The only pre-validation Windows executable is pinned once, at install. */
export function systemPowerShell(): string {
  const system = process.env.SystemRoot ?? process.env.SYSTEMROOT,
    windows = process.env.windir ?? process.env.WINDIR;
  if (!system || !windows || resolve(system).toLowerCase() !== resolve(windows).toLowerCase())
    throw new WrapperBuildError("SystemRoot and windir must agree");
  const path = join(system, "System32/WindowsPowerShell/v1.0/powershell.exe");
  let stat;
  try {
    stat = fs.lstatSync(path);
  } catch {
    throw new WrapperBuildError("system PowerShell is unavailable");
  }
  if (
    !isAbsolute(path) ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !/^[\x20-\x7e]+$/u.test(path) ||
    /[%!^&|<>"()]/u.test(path)
  )
    throw new WrapperBuildError("system PowerShell is not a regular cmd-safe ASCII executable");
  return path;
}
/** Actual bytes are built in Phase A and carried with the version rename. */
export async function stageShared(
  source: string,
  opts: PluginOptions & { explicitProfile?: boolean; userBin?: string; noUserBin?: boolean },
): Promise<void> {
  const generated = join(source, ".install-effects");
  fs.mkdirSync(generated);
  const targets: Record<string, { bytes: Buffer; mode: number }> = {};
  if (process.platform === "win32") {
    const ps = systemPowerShell();
    targets["bin/trajecta.cmd"] = { bytes: Buffer.from(windowsWrapper(opts.root, ps, false)), mode: 0o644 };
    targets["bin/trajecta-mcp.cmd"] = { bytes: Buffer.from(windowsWrapper(opts.root, ps, true)), mode: 0o644 };
  } else {
    targets["bin/trajecta"] = { bytes: Buffer.from(posixWrapper(opts.root, false)), mode: 0o755 };
    targets["bin/trajecta-mcp"] = { bytes: Buffer.from(posixWrapper(opts.root, true)), mode: 0o755 };
    targets["bin/.user-stub"] = { bytes: Buffer.from(userStub(opts.root)), mode: 0o755 };
  }
  if (opts.explicitProfile)
    targets["plugins/" + (await pluginName(opts.profile))] = { bytes: pluginZip(await pluginFiles(opts)), mode: 0o644 };
  const files: SharedPlan["files"] = {},
    directories = new Set<string>();
  const existing = (await import("./owned.ts")).ledger(opts.root);
  for (const [name, entry] of Object.entries(targets)) {
    beneath(opts.root, join(opts.root, name));
    const staged = join(generated, name);
    fs.mkdirSync(dirname(staged), { recursive: true });
    fs.writeFileSync(staged, entry.bytes, { flag: "wx", mode: entry.mode });
    fs.chmodSync(staged, entry.mode);
    const destination = join(opts.root, name),
      receipt = existing.entries[name];
    const eligible =
      !fs.existsSync(destination) ||
      (receipt?.kind === "file" && regular(destination) && digest(fs.readFileSync(destination)) === receipt.sha256);
    files[name] = { source: ".install-effects/" + name, sha256: digest(entry.bytes), mode: entry.mode, eligible };
    if (!fs.existsSync(join(opts.root, dirname(name)))) directories.add(dirname(name));
  }
  const plan: SharedPlan = { files, directories: [...directories].sort() };
  if (process.platform !== "win32" && !opts.noUserBin)
    plan.userBin = resolve(opts.userBin ?? join(homedir(), ".local/bin"));
  fs.writeFileSync(join(generated, "shared.json"), jsonBytes(plan), { flag: "wx" });
  checkpoint("A:shared-built");
}
export function readShared(folder: string): SharedPlan | undefined {
  const path = join(folder, ".install-effects/shared.json");
  if (!regular(path)) return undefined;
  const plan: SharedPlan = JSON.parse(fs.readFileSync(path, "utf8"));
  validateShared(plan);
  for (const entry of Object.values(plan.files)) {
    beneath(folder, join(folder, entry.source));
    if (!regular(join(folder, entry.source)) || digest(fs.readFileSync(join(folder, entry.source))) !== entry.sha256)
      throw new Error("staged shared bytes differ");
  }
  return plan;
}
export function validateShared(plan: SharedPlan): void {
  if (!plan.files || !Array.isArray(plan.directories)) throw new Error("invalid shared plan");
  for (const [name, entry] of Object.entries(plan.files)) {
    if (
      !/^(?:bin\/(?:trajecta(?:-mcp)?(?:\.cmd)?|\.user-stub)|plugins\/trajecta-[^/\\]+\.plugin)$/u.test(name) ||
      entry.source !== ".install-effects/" + name ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      ![0o644, 0o755].includes(entry.mode) ||
      typeof entry.eligible !== "boolean"
    )
      throw new Error("unsafe shared plan");
  }
  if (
    plan.directories.some((name) => name !== "bin" && name !== "plugins") ||
    (plan.userBin !== undefined && !isAbsolute(plan.userBin))
  )
    throw new Error("unsafe shared directory plan");
}
export function pathHint(root: string): void {
  const folder = join(root, "bin");
  if (!(process.env.PATH ?? "").split(delimiter).includes(folder))
    process.stdout.write(
      process.platform === "win32" ? `Add ${folder} to PATH.\n` : `export PATH=${shQuote(folder)}:"$PATH"\n`,
    );
}
export function reportExternal(data: Ledger): void {
  for (const [name, entry] of Object.entries(data.entries))
    if (entry.kind === "external-report")
      process.stdout.write(`trajecta: left ${name} in place; remove it yourself if you no longer want it\n`);
}
export function publishUserStub(root: string, dir: string, data: Ledger): void {
  const source = join(root, "bin/.user-stub"),
    target = join(dir, "trajecta");
  const skip = () => {
    process.stdout.write(`trajecta: left ${target} untouched; use ${join(root, "bin")} on PATH\n`);
    pathHint(root);
  };
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory() || stat.uid !== process.getuid!()) {
      skip();
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      skip();
      return;
    }
    throw error;
  }
  // Link only. No outside-root mkdir, overwrite, rename, write-through or cleanup.
  checkpoint("C:user-link-before");
  try {
    fs.linkSync(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      let equal = false;
      try {
        equal = fs.lstatSync(target).isFile() && fs.readFileSync(target).equals(fs.readFileSync(source));
      } catch {}
      if (!equal) {
        skip();
        return;
      }
    } else if (["EXDEV", "EPERM", "ENOTSUP"].includes(code ?? "")) {
      skip();
      return;
    } else throw error;
  }
  checkpoint("C:user-link-effect");
  const stat = fs.lstatSync(target, { bigint: true });
  data.entries[target] = { kind: "external-report", scope: "shared", dev: String(stat.dev), ino: String(stat.ino) };
  saveLedger(root, data);
  checkpoint("C:user-link-ledger");
  if (!(process.env.PATH ?? "").split(delimiter).includes(dir))
    process.stdout.write(`export PATH=${shQuote(dir)}:"$PATH"\n`);
}
export function publishShared(root: string, folder: string, plan: SharedPlan, data: Ledger): void {
  for (const name of plan.directories) {
    const path = join(root, name);
    safeRoot(path);
    if (!fs.existsSync(path)) fs.mkdirSync(path);
    if (!data.entries[name]) data.entries[name] = { kind: "directory", scope: "shared" };
    saveLedger(root, data);
    checkpoint("C:shared-directory:" + name);
  }
  for (const [name, entry] of Object.entries(plan.files)) {
    const path = join(root, name),
      source = join(folder, entry.source);
    if (!entry.eligible) {
      process.stdout.write(`trajecta: retained ${path}\n`);
      continue;
    }
    beneath(root, path);
    const receipt = data.entries[name];
    let exists = fs.existsSync(path);
    if (exists) {
      const stat = fs.lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        process.stdout.write(`trajecta: retained ${path}\n`);
        continue;
      }
      const actual = digest(fs.readFileSync(path));
      if (actual !== entry.sha256 && (receipt?.kind !== "file" || actual !== receipt.sha256)) {
        process.stdout.write(`trajecta: retained ${path}\n`);
        continue;
      }
      if (!receipt && actual !== entry.sha256) {
        process.stdout.write(`trajecta: retained ${path}\n`);
        continue;
      }
      exists = actual === entry.sha256;
    }
    if (!exists) atomic(path, fs.readFileSync(source), "C:shared:" + name, entry.mode);
    fs.chmodSync(path, entry.mode);
    checkpoint("C:shared-effect:" + name);
    if (digest(fs.readFileSync(path)) !== entry.sha256) throw new Error("shared effect differs from plan");
    data.entries[name] = { kind: "file", sha256: entry.sha256, scope: "shared" };
    saveLedger(root, data);
    checkpoint("C:shared-ledger:" + name);
  }
  if (process.platform !== "win32" && plan.userBin) {
    const stub = data.entries["bin/.user-stub"];
    if (
      stub?.kind === "file" &&
      regular(join(root, "bin/.user-stub")) &&
      digest(fs.readFileSync(join(root, "bin/.user-stub"))) === stub.sha256
    )
      publishUserStub(root, plan.userBin, data);
  } else pathHint(root);
}
