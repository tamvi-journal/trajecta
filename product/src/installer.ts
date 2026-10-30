import * as fs from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { homedir, hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { atomic, digest, jsonBytes, regular, safeRoot, readJson, syncDir } from "./install-fs.ts";
import { acquire, breakLock, cleanupTemps, owner, release } from "./install-lock.ts";
import { probeNode, supported, handoffNode } from "./node-probe.ts";
import { requireAnchor, verifyRelease, authenticateManifest } from "./release.ts";
import { adopt, buildPlan, ledger, saveLedger, verifyVersion, versionName, walk } from "./owned.ts";
import { identityInstall, workDoctor, runVerifiedExtractor, runStagedInstall } from "./engines.ts";
import { checkpoint } from "./checkpoint.ts";
import { inspect } from "../trajecta-extract.mjs";
import { cleanupRecovery } from "./recovery.ts";
import { stageShared, readShared, publishShared } from "./shared-effects.ts";

export type Options = {
  root: string;
  releaseDir: string;
  db: string;
  profile: string;
  workRoot: string;
  staged?: string;
  token?: string;
  rollback?: boolean;
  break?: boolean;
  resumeUninstall?: boolean;
  explicitProfile?: boolean;
  userBin?: string;
  noUserBin?: boolean;
};
export function defaultRoot(): string {
  return process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData/Local"), "Trajecta")
    : join(homedir(), ".trajecta");
}
export function options(argv: string[]): Options {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const data =
    process.env.TRAJECTA_IDENTITY_DATA_DIR ||
    (process.platform === "darwin"
      ? join(home, "Library/Application Support/Trajecta Identity Memory")
      : process.platform === "win32"
        ? join(process.env.LOCALAPPDATA || join(home, "AppData/Local"), "Trajecta Identity Memory")
        : join(process.env.XDG_DATA_HOME || join(home, ".local/share"), "trajecta-identity-memory"));
  const work =
    process.env.TRAJECTA_HOME ||
    (process.platform === "darwin"
      ? join(home, "Library/Application Support/Trajecta Work Memory")
      : process.platform === "win32"
        ? join(process.env.LOCALAPPDATA || join(home, "AppData/Local"), "Trajecta Work Memory")
        : join(process.env.XDG_DATA_HOME || join(home, ".local/share"), "trajecta-work-memory"));
  const result: Options = {
    root: defaultRoot(),
    releaseDir: process.cwd(),
    db: join(data, "example.sqlite3"),
    profile: "example",
    workRoot: work,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--no-user-bin") {
      result.noUserBin = true;
      continue;
    }
    if (["--rollback", "--break-lock", "--resume-uninstall"].includes(key)) {
      result[key === "--break-lock" ? "break" : key === "--resume-uninstall" ? "resumeUninstall" : "rollback"] = true;
      continue;
    }
    const fields = {
      "--root": "root",
      "--release": "releaseDir",
      "--db": "db",
      "--profile": "profile",
      "--work-root": "workRoot",
      "--staged": "staged",
      "--lock-token": "token",
      "--user-bin": "userBin",
    } as const;
    if (!(key in fields) || argv[i + 1] === undefined) throw new Error(`invalid install option: ${key}`);
    (result as any)[fields[key as keyof typeof fields]] = argv[++i];
  }
  result.explicitProfile = argv.includes("--profile");
  if (result.noUserBin && result.userBin) throw new Error("conflicting user-bin options");
  if (result.userBin && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(result.userBin))
    throw new Error("--user-bin requires an absolute path");
  if (result.profile !== "example" && !argv.includes("--db")) throw new Error("--profile requires an explicit --db");
  for (const key of ["root", "releaseDir", "db", "workRoot", "staged"] as const)
    if (result[key]) result[key] = resolve(result[key]!);
  if ([result.rollback, result.break, result.resumeUninstall, !!result.staged].filter(Boolean).length > 1)
    throw new Error("conflicting install modes");
  return result;
}
export async function confirmation(prompt: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await input.question(prompt)) === expected;
  } finally {
    input.close();
  }
}
export function pointer(root: string): [string, string] | "uninstalling" | null {
  const path = join(root, "current");
  if (!regular(path)) return null;
  const bytes = fs.readFileSync(path, "utf8");
  if (bytes === "uninstalling\n") return "uninstalling";
  const match = /^([^\n]+)\n([^\n]*)\n$/u.exec(bytes);
  if (!match) throw new Error("invalid current pointer");
  return [versionName(match[1]), match[2] ? versionName(match[2]) : ""];
}
export function assertInstalledState(root: string): void {
  if (pointer(root) === "uninstalling")
    throw new Error(
      `trajecta is being uninstalled; resume with: hash-checked installer --resume-uninstall --root ${JSON.stringify(root)}`,
    );
}
export async function doctor(folder: string, opts: Options, allowMissing = false): Promise<void> {
  verifyVersion(folder);
  if (!supported(process.versions.node)) throw new Error("need Node 22.19+ or 24 LTS");
  if (regular(opts.db)) {
    const result = await identityInstall(folder, ["--profile", opts.profile, "--db", opts.db, "doctor"], process.env);
    if (result.code !== 0)
      throw new Error(`identity doctor failed: ${result.stdout.toString().trim()} ${result.stderr.toString().trim()}`);
  } else if (!allowMissing) throw new Error("identity store missing; run install");
  await workDoctor(folder, opts.workRoot);
}
async function committed(opts: Options, node: string, metadata: any, staged: string): Promise<void> {
  const folder = join(opts.root, metadata.version),
    source = join(staged, `trajecta-${metadata.version}`);
  const stagedManifest = authenticateManifest(fs.readFileSync(join(source, "MANIFEST.json")), metadata, "extracted");
  fs.writeFileSync(join(source, "node"), node + "\n", { flag: "wx", mode: 0o600 });
  for (const name of ["release.json", "release.json.sig"])
    fs.copyFileSync(join(opts.releaseDir, name), join(source, name), fs.constants.COPYFILE_EXCL);
  checkpoint("A:node");
  await stageShared(source, opts);
  await doctor(source, opts, true);
  checkpoint("A:doctor");
  const createdDirectories = [source, ...walk(source).filter((path) => fs.lstatSync(path).isDirectory())].map((path) =>
    relative(staged, path).split(sep).join("/").replace(`trajecta-${metadata.version}`, metadata.version),
  );
  checkpoint("B:version-before-rename");
  if (fs.existsSync(folder)) {
    safeRoot(folder);
    if (
      !regular(join(folder, "MANIFEST.json")) ||
      digest(fs.readFileSync(join(folder, "MANIFEST.json"))) !== metadata.manifest_sha256
    )
      throw new Error("installed version MANIFEST differs");
    verifyVersion(folder);
  } else {
    fs.renameSync(source, folder);
    syncDir(opts.root);
  }
  checkpoint("B:version-after-rename");
  const previous = readJson(join(folder, ".planned.json"));
  const intent = previous?.bootstrap ?? { db: opts.db, absent: !fs.existsSync(opts.db) };
  if (intent.db !== opts.db || typeof intent.absent !== "boolean") throw new Error("bootstrap plan differs; retained");
  const data = ledger(opts.root);
  const manifest = verifyVersion(folder),
    plan = buildPlan(opts.root, metadata.version, manifest, createdDirectories, intent),
    bytes = jsonBytes(plan),
    planPath = join(folder, ".planned.json");
  if (regular(planPath)) {
    const receipt = data.entries[metadata.version + "/.planned.json"];
    if (receipt?.kind === "file" && digest(fs.readFileSync(planPath)) !== receipt.sha256)
      throw new Error("existing plan differs; retained");
    if (!fs.readFileSync(planPath).equals(bytes)) throw new Error("existing plan differs; retained");
  } else atomic(planPath, bytes, "plan");
  checkpoint("B:plan");
  adopt(opts.root, metadata.version, data, true);
  checkpoint("B:ownership");
  const current = pointer(opts.root);
  if (current === "uninstalling") assertInstalledState(opts.root);
  if (!current || current[0] !== metadata.version)
    atomic(join(opts.root, "current"), Buffer.from(`${metadata.version}\n${current?.[0] ?? ""}\n`), "current");
  checkpoint("B:current");
  const shared = readShared(folder);
  if (shared) publishShared(opts.root, folder, shared, data);
  if (!opts.explicitProfile) process.stdout.write("trajecta plugin --profile <name>\n");
  if (!fs.existsSync(opts.db)) {
    checkpoint("C:bootstrap-before-effect");
    const result = await identityInstall(folder, ["--profile", opts.profile, "--db", opts.db, "init"], process.env);
    if (result.code !== 0) throw new Error(`identity init failed: ${result.stderr}`);
    checkpoint("C:bootstrap-effect");
  }
  if (!data.effects["identity-bootstrap"]) {
    data.effects["identity-bootstrap"] = { db: opts.db, created: intent.absent };
    saveLedger(opts.root, data);
  }
  checkpoint("C:bootstrap-ledger");
  await doctor(folder, opts);
  checkpoint("C:doctor-effect");
  data.effects.doctor = { version: metadata.version, passed: true };
  saveLedger(opts.root, data);
  checkpoint("C:doctor-ledger");
}
/** Explicit verified-staged entry: same owner, no handoff and no nested lock acquisition. */
export async function installStaged(argv: string[]): Promise<number> {
  requireAnchor();
  const opts = options(argv);
  if (!opts.staged || !opts.token || opts.break || opts.rollback || opts.resumeUninstall)
    throw new Error("staged entry requires an explicit staging path and lock token");
  const record = regular(join(opts.root, ".lock")) && owner(fs.readFileSync(join(opts.root, ".lock")));
  if (!record || record.token !== opts.token || record.pid !== process.pid || record.hostname !== hostname())
    throw new Error("staged entry requires its own process lock");
  assertInstalledState(opts.root);
  const retained = cleanupRecovery(opts.root);
  if (retained.length) throw new Error("uninstall retained paths: " + retained.join(", "));
  if (!supported(process.versions.node)) throw new Error("need Node 22.19+ or 24 LTS");
  const { metadata } = verifyRelease(opts.releaseDir);
  await committed(opts, fs.realpathSync.native(process.execPath), metadata, opts.staged);
  return 0;
}
export async function install(argv: string[]): Promise<number> {
  const opts = options(argv);
  requireAnchor();
  if (opts.break) {
    const handoff = handoffNode(probeNode());
    if (handoff !== null) return handoff;
    await breakLock(opts.root, (prompt) => confirmation(prompt, "BREAK LOCK"));
    return 0;
  }
  if (opts.rollback) {
    assertInstalledState(opts.root);
    const handoff = handoffNode(probeNode());
    if (handoff !== null) return handoff;
    const held = acquire(opts.root);
    try {
      assertInstalledState(opts.root);
      const current = pointer(opts.root);
      if (!current || current === "uninstalling" || !current[1]) throw new Error("no verified rollback target");
      await doctor(join(opts.root, current[1]), opts);
      atomic(join(opts.root, "current"), Buffer.from(current[1] + "\n" + current[0] + "\n"), "rollback");
      return 0;
    } finally {
      release(opts.root, ".lock", held);
    }
  }
  if (opts.resumeUninstall) return (await import("./uninstall.ts")).fallback(opts);
  if (opts.staged) throw new Error("staged installation requires the internal verified entry");
  assertInstalledState(opts.root);
  const node = probeNode();
  const handoff = handoffNode(node);
  if (handoff !== null) return handoff;
  const existed = fs.existsSync(opts.root),
    held = acquire(opts.root);
  let staged: string | undefined;
  try {
    cleanupTemps(opts.root, held);
    assertInstalledState(opts.root);
    const retained = cleanupRecovery(opts.root);
    if (retained.length) throw new Error("uninstall retained paths: " + retained.join(", "));
    for (const name of fs.readdirSync(opts.root))
      if (/^\.staging-[0-9]/u.test(name)) {
        const abandoned = join(opts.root, name);
        safeRoot(abandoned);
        fs.rmSync(abandoned, { recursive: true });
      }
    checkpoint("A:cleanup");
    const { metadata, archive, extractor } = verifyRelease(opts.releaseDir);
    const checked = inspect(fs.readFileSync(archive), metadata.version);
    authenticateManifest(checked.manifestBytes, metadata, "extracted");
    checkpoint("A:inspection");
    staged = join(opts.root, `.staging-${metadata.version}-${randomBytes(16).toString("hex")}`);
    const extractorBytes = fs.readFileSync(extractor);
    if (digest(extractorBytes) !== metadata.extractor_sha256) throw new Error("extractor SHA-256 mismatch");
    await runVerifiedExtractor(extractorBytes, fs.readFileSync(archive), metadata.version, staged);
    checkpoint("A:extracted");
    const code = await runStagedInstall(staged, metadata.version, [
      "--staged",
      staged,
      "--root",
      opts.root,
      "--release",
      opts.releaseDir,
      "--db",
      opts.db,
      ...(opts.explicitProfile ? ["--profile", opts.profile] : []),
      ...(opts.userBin ? ["--user-bin", opts.userBin] : []),
      ...(opts.noUserBin ? ["--no-user-bin"] : []),
      "--work-root",
      opts.workRoot,
      "--lock-token",
      held.token,
    ]);
    if (code !== 0) throw new Error("staged install failed; rerun or rollback");
    return 0;
  } finally {
    if (staged && fs.existsSync(staged)) fs.rmSync(staged, { recursive: true });
    release(opts.root, ".lock", held);
    if (!existed && fs.existsSync(opts.root) && !fs.readdirSync(opts.root).length) fs.rmdirSync(opts.root);
  }
}
