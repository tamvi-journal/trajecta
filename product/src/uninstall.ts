import * as fs from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { acquire, release, cleanupTemps, cleanupClaims, owner, type Owner } from "./install-lock.ts";
import { atomic, digest, jsonBytes, regular, safeRoot, syncDir } from "./install-fs.ts";
import { ledger, adopt, walk, versionName, type Ledger } from "./owned.ts";
import { createRecovery, cleanupRecovery, signedManifest, productPaths } from "./recovery.ts";
import { options, pointer, doctor, confirmation, type Options } from "./installer.ts";
import { probeNode, handoffNode, supported } from "./node-probe.ts";
import { requireAnchor } from "./release.ts";
import { recoveryVerifierSource } from "./engines.ts";
import { checkpoint } from "./checkpoint.ts";

function versions(root: string): string[] {
  return fs
    .readdirSync(root)
    .filter((name) => {
      if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(name)) return false;
      safeRoot(join(root, name));
      return fs.existsSync(join(root, name));
    })
    .sort();
}
function retained(root: string, paths: string[]): never {
  throw new Error(
    "uninstall retained paths: " +
      [...new Set(paths)].sort().join(", ") +
      "; resume with hash-checked installer --resume-uninstall --root " +
      JSON.stringify(root),
  );
}
function unlink(root: string, name: string): void {
  const path = join(root, name);
  if (!regular(path)) return;
  checkpoint("U:before-unlink:" + name);
  fs.unlinkSync(path);
  syncDir(root);
  checkpoint("U:after-unlink:" + name);
}
function removeScope(root: string, scope: string, data: Ledger): string[] {
  const entries = Object.entries(data.entries).filter(([, entry]) => entry.scope === scope);
  const priority = (name: string) => (name.endsWith("/.planned.json") ? 1 : name.endsWith("/MANIFEST.json") ? 2 : 0);
  for (const [name, entry] of entries
    .filter(([, e]) => e.kind === "file")
    .sort(([a], [b]) => priority(a) - priority(b) || (a < b ? -1 : 1))) {
    const path = join(root, name);
    if (!fs.existsSync(path)) continue;
    if (!fs.lstatSync(path).isFile()) continue;
    if (entry.kind === "file" && digest(fs.readFileSync(path)) === entry.sha256) unlink(root, name);
  }
  for (const [name] of entries
    .filter(([, e]) => e.kind === "directory")
    .sort(([a], [b]) => b.split("/").length - a.split("/").length || (a < b ? -1 : 1))) {
    const path = join(root, name);
    try {
      safeRoot(path);
      fs.rmdirSync(path);
      checkpoint("U:rmdir:" + name);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  if (scope !== "shared")
    return fs.existsSync(join(root, scope)) ? [join(root, scope), ...walk(join(root, scope))] : [];
  const leftovers = entries.map(([name]) => join(root, name)).filter((path) => fs.existsSync(path));
  return [...new Set(leftovers.flatMap((path) => (fs.lstatSync(path).isDirectory() ? [path, ...walk(path)] : [path])))];
}
/** External anchor is embedded before the first import; no on-disk list authenticates itself. */
export function resumeCommand(root: string, anchor: string): string {
  const source = recoveryVerifierSource(root, anchor);
  const quote = (value: string) => "'" + value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'";
  return (
    (process.platform === "win32" ? "& " : "") +
    quote(process.execPath) +
    " --experimental-strip-types -e " +
    quote(source)
  );
}
function recoveryAnchor(root: string, data: Ledger): string {
  const folder = join(root, ".uninstall"),
    manifest = signedManifest(folder),
    files: Record<string, string> = {};
  for (const name of productPaths(manifest)) {
    const path = join(folder, name),
      expected = manifest.files[name];
    if (!regular(path) || digest(fs.readFileSync(path)) !== expected.sha256)
      throw new Error("recovery product mismatch: " + name);
    files[name] = expected.sha256;
  }
  const version = manifest.version,
    receipt = data.entries[version + "/node"];
  if (
    receipt?.kind !== "file" ||
    !regular(join(folder, "node")) ||
    digest(fs.readFileSync(join(folder, "node"))) !== receipt.sha256
  )
    throw new Error("recovery node receipt mismatch");
  files.node = receipt.sha256;
  for (const name of ["MANIFEST.json", "release.json.sig", "release.json"])
    files[name] = digest(fs.readFileSync(join(folder, name)));
  const expected = jsonBytes({ schema: "trajecta.recovery/v1", version, files });
  if (!regular(join(folder, "DIGESTS.json")) || !fs.readFileSync(join(folder, "DIGESTS.json")).equals(expected))
    throw new Error("recovery digest list mismatch");
  return digest(expected);
}
async function finalize(opts: Options, held: ReturnType<typeof acquire>): Promise<void> {
  cleanupTemps(opts.root, held);
  checkpoint("U:temps");
  cleanupClaims(opts.root, held);
  checkpoint("U:claims");
  unlink(opts.root, "owned.json");
  checkpoint("U:owned");
  unlink(opts.root, "current");
  checkpoint("U:current");
  const paths = cleanupRecovery(opts.root);
  if (paths.length) retained(opts.root, paths);
  checkpoint("U:recovery-cleanup");
}
/** Verified bootstrap calls only this bounded resume entry with its own held token. */
export async function resumeUninstallHeld(argv: string[], token: string): Promise<number> {
  const opts = options(argv);
  const record = regular(join(opts.root, ".lock")) && owner(fs.readFileSync(join(opts.root, ".lock")));
  if (!record || record.token !== token || record.pid !== process.pid || record.hostname !== hostname())
    throw new Error("resume entry requires its own process lock");
  return uninstallWithLock(["--resume", ...argv], record);
}
export async function uninstall(argv: string[]): Promise<number> {
  return uninstallWithLock(argv);
}
async function uninstallWithLock(argv: string[], inherited?: Owner): Promise<number> {
  const resume = argv.includes("--resume"),
    status = argv.includes("--status"),
    yes = argv.includes("--yes");
  const index = argv.indexOf("--version"),
    version = index >= 0 ? versionName(argv[index + 1] ?? "") : undefined;
  const filtered = argv.filter(
    (_, i) => !["--resume", "--status", "--yes"].includes(argv[i]) && i !== index && !(index >= 0 && i === index + 1),
  );
  const opts = options(filtered);
  if (status) {
    process.stdout.write(pointer(opts.root) === "uninstalling" ? "uninstalling\n" : "not uninstalling\n");
    return 0;
  }
  requireAnchor();
  if (!inherited) {
    const node = probeNode(),
      handoff = handoffNode(node);
    if (handoff !== null) return handoff;
  } else if (!supported(process.versions.node)) throw new Error("need Node 22.19+ or 24 LTS");
  safeRoot(opts.root);
  if (!fs.existsSync(opts.root)) return 0;
  const held = inherited ?? acquire(opts.root);
  let completed = false;
  try {
    const current = pointer(opts.root);
    if (current === "uninstalling" && !resume)
      throw new Error("trajecta is being uninstalled; run trajecta uninstall --resume");
    if (version && (current === "uninstalling" || current?.includes(version)))
      throw new Error("cannot uninstall current or rollback-protected version");
    if (resume && !regular(join(opts.root, "owned.json"))) {
      await finalize(opts, held);
      completed = true;
      return 0;
    }
    const data = ledger(opts.root),
      installed = versions(opts.root);
    for (const ver of installed) adopt(opts.root, ver, data, true);
    checkpoint("U:converge");
    if (version) {
      const paths = removeScope(opts.root, version, data);
      if (paths.length) retained(opts.root, paths);
      return 0;
    }
    let anchor: string;
    if (current === "uninstalling") anchor = recoveryAnchor(opts.root, data);
    else {
      if (!current || !installed.includes(current[0])) {
        if (fs.existsSync(join(opts.root, ".uninstall"))) {
          await finalize(opts, held);
          completed = true;
          return 0;
        }
        throw new Error("no installed version to uninstall");
      }
      anchor = createRecovery(opts.root, current[0], data).anchor;
    }
    process.stdout.write("Resume command: " + resumeCommand(opts.root, anchor) + "\n");
    checkpoint("U:resume-printed");
    if (current !== "uninstalling") atomic(join(opts.root, "current"), Buffer.from("uninstalling\n"), "U:sentinel");
    checkpoint("U:sentinel");
    const active = JSON.parse(fs.readFileSync(join(opts.root, ".uninstall/MANIFEST.json"), "utf8")).version;
    const paths: string[] = [];
    for (const ver of installed.sort((a, b) => (a === active ? 1 : b === active ? -1 : a < b ? -1 : 1)))
      paths.push(...removeScope(opts.root, ver, data));
    checkpoint("U:versions");
    if (paths.length) retained(opts.root, paths);
    const shared = removeScope(opts.root, "shared", data);
    if (shared.length) retained(opts.root, shared);
    checkpoint("U:shared");
    const state = join(opts.root, "update-state.json");
    if (
      fs.existsSync(state) &&
      regular(state) &&
      !yes &&
      (await confirmation(
        "Removing update-state.json resets replay protection and the key-rotation chain. Type RESET UPDATE STATE: ",
        "RESET UPDATE STATE",
      ))
    )
      unlink(opts.root, "update-state.json");
    checkpoint("U:update-state");
    await finalize(opts, held);
    completed = true;
    process.stdout.write(
      `Data remains at ${opts.db} and ${opts.workRoot}; profiles and client configs were not touched.\n`,
    );
    return 0;
  } finally {
    if (!inherited) {
      release(opts.root, ".lock", held);
      checkpoint("U:lock-released");
      if (completed && fs.existsSync(opts.root) && !fs.readdirSync(opts.root).length) {
        fs.rmdirSync(opts.root);
        checkpoint("U:root");
      } else if (fs.existsSync(opts.root) && pointer(opts.root) === null) {
        process.stdout.write("Retained paths: " + walk(opts.root).join(", ") + "\n");
      }
    }
  }
}
export async function fallback(opts: Options): Promise<number> {
  return uninstall([
    "--resume",
    "--root",
    opts.root,
    "--db",
    opts.db,
    "--profile",
    opts.profile,
    "--work-root",
    opts.workRoot,
  ]);
}
export async function productDoctor(argv: string[]): Promise<number> {
  const opts = options(argv),
    current = pointer(opts.root);
  if (!current || current === "uninstalling")
    throw new Error("trajecta is being uninstalled; run trajecta uninstall --resume");
  await doctor(join(opts.root, current[0]), opts);
  return 0;
}
