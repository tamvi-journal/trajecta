import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { engineFiles, readLock, sha } from "../tools/engine-lock.ts";
import { build } from "../tools/build-release.ts";
import { unpack, verifyManifest } from "../tools/archive.ts";
import { compatibility, verifyCompat } from "../tools/compat.ts";
import { checkAuthority, lintSource, sourceScan } from "../tools/authority-lint.ts";
import { CLI, ROOT, temporary, isolatedEnv, tree } from "./support.ts";
import { enginePath } from "../product/src/engines.ts";

test("version, certified runtime, lock and compatibility are pinned", () => {
  const pkg = JSON.parse(fs.readFileSync(join(ROOT, "product/package.json"), "utf8"));
  assert.equal(pkg.version, "0.5.0");
  assert.equal(pkg.engines.node, ">=22.19 <23 || >=24 <25");
  assert.deepEqual(Object.keys(pkg.bin), ["trajecta"]);
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert((major === 22 && minor >= 19) || major === 24);
  const lock = readLock();
  assert.equal(lock.engines.identity.commit, "98313ac335a533732630b2ba7039180e4bb89dcf");
  assert.equal(lock.engines.work.commit, "5c696187eb5df5be7341f88296c5462488a5ae27");
  verifyCompat();
  assert.equal(compatibility().stores.work.schema, "trajecta.state/v1");
  process.stdout.write(
    JSON.stringify({
      node: process.versions.node,
      sqlite: process.versions.sqlite,
      os: process.platform,
      arch: process.arch,
    }) + "\n",
  );
});
test("all runtime and supplemental bytes authenticated; bad/missing/extra digest refuses", () => {
  const lock = readLock();
  assert(Object.keys(engineFiles(lock, false)).some((p) => p.endsWith("profiles/example/profile.json")));
  for (const kind of ["digest", "missing", "extra"]) {
    const bad = structuredClone(lock),
      files = bad.engines.identity.files;
    if (kind === "digest") files["src/cli.ts"] = "0".repeat(64);
    if (kind === "missing") delete files["src/cli.ts"];
    if (kind === "extra") files["src/extra.ts"] = "0".repeat(64);
    assert.throws(() => engineFiles(bad, false), /mismatch/);
  }
  const bad = structuredClone(lock);
  bad.engines.identity.supplemental!.files["trajecta_identity/profiles/example/profile.json"] = "0".repeat(64);
  assert.throws(() => engineFiles(bad, false), /digest mismatch/);
});
test("two builds exact, MANIFEST path set exact and self excluded; release refuses without wrappers", () => {
  const a = build("foundation", false),
    b = build("foundation", false);
  assert.deepEqual(a, b);
  const files = unpack(a, "trajecta-0.5.0");
  verifyManifest(files);
  const m = JSON.parse(files["MANIFEST.json"].toString());
  assert.equal(m.artifact, "foundation");
  assert(!("MANIFEST.json" in m.files));
  assert(!Object.keys(files).some((p) => p.startsWith("bin/")));
  assert(!("index_sequence" in m));
  for (const change of ["delete", "extra", "digest"]) {
    const damaged = { ...files };
    if (change === "delete") delete damaged["engines/identity/tables/version-sensitive.json"];
    if (change === "extra") damaged["extra"] = Buffer.from("valid");
    if (change === "digest") damaged["product/src/cli.ts"] = Buffer.from("changed");
    assert.throws(() => verifyManifest(damaged), /mismatch/);
  }
  assert.throws(() => build("release", false), /complete bin/);
  process.stdout.write("M2 foundation tarball " + sha(a) + "\n");
});
test("lint and independent scan reject engine/sqlite bypasses including dynamic imports", () => {
  checkAuthority();
  for (const source of [
    'import { MemoryStore } from "../../engines/identity/src/store.ts";',
    'export * from "../../engines/work/src/index.ts";',
    'const db = await import("node:sqlite");',
    'const engine = await import("../../engines/identity/src/index.ts");',
    'const db = require("node:sqlite");',
    "const db = await import(moduleName);",
    'const db = await import("node:" + "sqlite");',
  ]) {
    assert.throws(() => lintSource("product/src/bypass.ts", source), /authority/);
    assert.throws(() => sourceScan("product/src/bypass.ts", source), /authority/);
  }
});
test("default example works offline without profile env; external cwd and no Git/npm executable", () => {
  const archive = unpack(build("foundation", false), "trajecta-0.5.0"),
    root = temporary();
  for (const [file, bytes] of Object.entries(archive)) {
    const full = join(root, "artifact", file);
    fs.mkdirSync(join(full, ".."), { recursive: true });
    fs.writeFileSync(full, bytes);
  }
  const env = isolatedEnv(root);
  delete env.TRAJECTA_IDENTITY_PROFILES;
  delete env.TRAJECTA_IDENTITY_PROFILE;
  env.PATH = join(root, "empty-path");
  env.NODE_OPTIONS = "--import=" + new URL("./offline-hook.ts", import.meta.url).href;
  const cli = join(root, "artifact/product/src/cli.ts");
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { cwd: root, env, encoding: "utf8" });
  const version = run(["version"]);
  assert.equal(version.status, 0, version.stderr);
  assert(version.stdout.includes(readLock().engines.identity.commit));
  assert(version.stdout.includes(readLock().engines.work.commit));
  const init = run(["identity", "init"]);
  assert.equal(init.status, 0, init.stderr);
  const retrieve = run(["identity", "retrieve", "identity"]);
  assert.equal(retrieve.status, 0, retrieve.stderr);
  const work = run(["work", "list"]);
  assert.equal(work.status, 0, work.stderr);
  assert.equal(work.stdout, "[]\n");
  // This is a checked-in synthetic engine fixture, never a user's LWM root.
  const fixture = join(root, "synthetic-lifecycle");
  fs.cpSync(join(ROOT, ".isolation/upstream/work/test/fixtures/lifecycle-source"), fixture, { recursive: true });
  const imported = run(["work", "import-lwm", fixture]);
  assert.equal(imported.status, 0, imported.stderr);
  const listed = run(["work", "list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /Move memory to the shared backbone/u);
  const routed = run(["work", "route", "memory"]);
  assert.equal(routed.status, 0, routed.stderr);
  assert.match(routed.stdout, /Move memory to the shared backbone/u);
  const denied = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "-e", 'require("node:net").connect(443, "example.invalid")'],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /network disabled/u);
  for (const command of ["git", "npm"]) {
    const missing = spawnSync(command, ["--version"], { cwd: root, env });
    assert.equal((missing.error as NodeJS.ErrnoException)?.code, "ENOENT");
  }
});
