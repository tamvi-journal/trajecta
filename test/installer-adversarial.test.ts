import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI, ROOT, tree } from "./support.ts";
const run = (
  f: ReturnType<typeof signedFixture>,
  command: string,
  args: string[] = [],
  env: Record<string, string> = {},
) =>
  spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      CLI,
      command,
      "--root",
      join(f.root, "install"),
      "--release",
      f.release,
      "--db",
      join(f.root, "identity/example.sqlite3"),
      "--work-root",
      join(f.root, "work"),
      ...args,
    ],
    { cwd: ROOT, env: { ...f.env, ...env }, encoding: "utf8" },
  );
function installed() {
  const f = signedFixture(testKey());
  const r = run(f, "install");
  assert.equal(r.status, 0, r.stderr);
  return f;
}
test("altered controls and unowned nested paths are retained; signed MANIFEST/ledger co-tamper refuses", () => {
  for (const name of ["MANIFEST.json", ".planned.json", "unreceipted control", "unowned nested"]) {
    const f = installed(),
      folder = join(f.root, "install/0.5.0");
    if (name === "unreceipted control") {
      const p = join(f.root, "install/owned.json"),
        data = JSON.parse(fs.readFileSync(p, "utf8"));
      delete data.entries["0.5.0/release.json.sig"];
      fs.writeFileSync(p, JSON.stringify(data));
      const planned = join(folder, ".planned.json"),
        plan = JSON.parse(fs.readFileSync(planned, "utf8"));
      delete plan.files["0.5.0/release.json.sig"];
      fs.writeFileSync(planned, JSON.stringify(plan));
    } else if (name === "unowned nested") {
      fs.mkdirSync(join(folder, "extra/deep"), { recursive: true });
      fs.writeFileSync(join(folder, "extra/deep/unowned"), "owner content");
    } else fs.appendFileSync(join(folder, name), " ");
    const bytes = name.includes(" ") ? undefined : fs.readFileSync(join(folder, name));
    const r = run(f, "uninstall");
    assert.notEqual(r.status, 0, name);
    assert(fs.existsSync(folder), name);
    if (bytes) assert(fs.readFileSync(join(folder, name)).equals(bytes));
  }
  const f = installed(),
    folder = join(f.root, "install/0.5.0"),
    manifest = join(folder, "MANIFEST.json"),
    owned = join(f.root, "install/owned.json");
  const bytes = fs.readFileSync(manifest);
  fs.writeFileSync(manifest, Buffer.concat([bytes, Buffer.from(" ")]));
  const data = JSON.parse(fs.readFileSync(owned, "utf8"));
  data.entries["0.5.0/MANIFEST.json"].sha256 = createHash("sha256").update(fs.readFileSync(manifest)).digest("hex");
  fs.writeFileSync(owned, JSON.stringify(data));
  const before = tree(folder),
    r = run(f, "uninstall");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MANIFEST digest mismatch/);
  assert.deepEqual(tree(folder), before);
});
test("rollback swaps exactly two lines and preserves both stores", () => {
  const key = testKey(),
    f = signedFixture(key),
    next = signedFixture(key, "0.5.1");
  let r = run(f, "install");
  assert.equal(r.status, 0, r.stderr);
  const root = join(f.root, "install");
  r = run(f, "install", ["--release", next.release]);
  assert.equal(r.status, 0, r.stderr);
  const before = tree(join(f.root, "identity"));
  assert.equal(fs.readFileSync(join(root, "current"), "utf8"), "0.5.1\n0.5.0\n");
  r = run(f, "install", ["--rollback"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(join(root, "current"), "utf8"), "0.5.0\n0.5.1\n");
  assert.deepEqual(tree(join(f.root, "identity")), before);
  r = run(f, "uninstall", ["--version", "0.5.1"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /rollback-protected/);
});
test("non-TTY update state is preserved after full uninstall, and sentinel refuses install/update/rollback", () => {
  const f = installed(),
    root = join(f.root, "install"),
    state = join(root, "update-state.json");
  fs.writeFileSync(state, "owner replay protection\n");
  let r = run(f, "uninstall", [], { TEST_KILL_AT: "U:sentinel" });
  assert.notEqual(r.status, 0);
  for (const [command, args] of [
    ["install", []],
    ["install", ["--rollback"]],
    ["update", []],
  ] as const) {
    const before = tree(root);
    r = run(f, command, [...args]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /being uninstalled/);
    assert.deepEqual(tree(root), before);
  }
  r = run(f, "uninstall", ["--resume", "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(tree(root)), ["update-state.json"]);
  assert.equal(fs.readFileSync(state, "utf8"), "owner replay protection\n");
});
test("a lost-anchor terminal crash converges by fresh install", () => {
  const f = installed();
  let r = run(f, "uninstall", [], { TEST_KILL_AT: "U:current" });
  assert.notEqual(r.status, 0);
  r = run(f, "install");
  assert.equal(r.status, 0, r.stderr);
  assert(!fs.existsSync(join(f.root, "install/.uninstall")));
  assert.equal(fs.readFileSync(join(f.root, "install/current"), "utf8"), "0.5.0\n\n");
});

test("a frozen legacy-v4 store makes the readonly doctor refuse without any store change", () => {
  const f = signedFixture(testKey()),
    db = join(f.root, "identity/example.sqlite3");
  fs.mkdirSync(join(f.root, "identity"), { recursive: true });
  fs.copyFileSync(join(ROOT, ".isolation/upstream/identity/spec/golden/packet/store.sqlite3"), db);
  const before = tree(join(f.root, "identity")),
    mtime = fs.statSync(db, { bigint: true }).mtimeNs;
  const r = run(f, "install");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /doctor failed/);
  assert.deepEqual(tree(join(f.root, "identity")), before);
  assert.equal(fs.statSync(db, { bigint: true }).mtimeNs, mtime);
  assert(!fs.existsSync(join(f.root, "install/current")));
});

test("changed shared bytes stop before update-state or controls; clearing them makes resume converge", () => {
  const f = installed(),
    root = join(f.root, "install"),
    folder = join(root, "bin"),
    path = join(folder, "owned-launcher"),
    state = join(root, "update-state.json");
  // 4c install now creates bin itself; retain the same altered-shared-file assertions.
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path, "original");
  fs.writeFileSync(state, "keep replay state");
  const ledgerPath = join(root, "owned.json"),
    data = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  data.entries.bin = { kind: "directory", scope: "shared" };
  data.entries["bin/owned-launcher"] = {
    kind: "file",
    scope: "shared",
    sha256: createHash("sha256").update("original").digest("hex"),
  };
  fs.writeFileSync(ledgerPath, JSON.stringify(data));
  fs.writeFileSync(path, "modified");
  let r = run(f, "uninstall");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /owned-launcher/);
  assert.equal(fs.readFileSync(state, "utf8"), "keep replay state");
  assert(fs.existsSync(join(root, "owned.json")));
  assert.equal(fs.readFileSync(join(root, "current"), "utf8"), "uninstalling\n");
  fs.unlinkSync(path);
  r = run(f, "uninstall", ["--resume"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(tree(root)), ["update-state.json"]);
});

test("stale lock recovery then real install then full uninstall leaves an empty root", () => {
  const f = signedFixture(testKey()),
    root = join(f.root, "install");
  fs.mkdirSync(root);
  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { env: f.env, encoding: "utf8" });
  assert.equal(dead.status, 0);
  const record = {
    token: "4".repeat(32),
    pid: Number(dead.stdout.trim()),
    hostname: hostname(),
    created: "2026-10-12T00:00:00.000Z",
  };
  fs.writeFileSync(join(root, ".lock"), JSON.stringify(record));
  let r = run(f, "install");
  assert.equal(r.status, 0, r.stderr);
  assert(!fs.readdirSync(root).some((name) => name.startsWith(".lock.claim.")));
  r = run(f, "uninstall");
  assert.equal(r.status, 0, r.stderr);
  assert(!fs.existsSync(root));
});

test("refusing an unowned empty root never removes that directory", () => {
  const f = signedFixture(testKey()),
    root = join(f.root, "install");
  fs.mkdirSync(root);
  const r = run(f, "uninstall");
  assert.notEqual(r.status, 0);
  assert(fs.statSync(root).isDirectory());
  assert.deepEqual(tree(root), {});
});

test("public CLI cannot invoke the internal staged writer path", () => {
  const f = signedFixture(testKey()),
    before = tree(f.root),
    r = run(f, "install", ["--staged", join(f.root, "unverified"), "--lock-token", "4".repeat(32)]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /internal verified entry/);
  assert.deepEqual(tree(f.root), before);
});
