import * as fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI, ROOT, tree } from "./support.ts";
function run(
  f: ReturnType<typeof signedFixture>,
  command: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  const root = join(f.root, "install");
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      CLI,
      command,
      "--root",
      root,
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
}
test("real install, idempotent retry, read-only doctor and full uninstall keep stores and profiles", () => {
  const f = signedFixture(testKey());
  let r = run(f, "install");
  assert.equal(r.status, 0, r.stderr);
  const root = join(f.root, "install"),
    before = tree(root),
    data = tree(join(f.root, "identity")),
    profiles = tree(join(f.root, "profiles"));
  r = run(f, "install");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(tree(root), before);
  r = run(f, "doctor");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(tree(join(f.root, "identity")), data);
  r = run(f, "uninstall");
  assert.equal(r.status, 0, r.stderr);
  assert(!fs.existsSync(root));
  assert.deepEqual(tree(join(f.root, "identity")), data);
  assert.deepEqual(tree(join(f.root, "profiles")), profiles);
  assert(!fs.existsSync(join(f.root, "work")));
});
test("real kills at commit and phase C boundaries converge", () => {
  for (const point of [
    "A:signature",
    "A:tar-digest",
    "A:extractor-digest",
    "A:inspection",
    "A:extracted",
    "A:node",
    "A:doctor",
    "B:version-before-rename",
    "B:version-after-rename",
    "plan:before-rename",
    "plan:after-rename",
    "B:plan",
    "ledger:before-rename",
    "ledger:after-rename",
    "B:ownership",
    "current:before-rename",
    "current:after-rename",
    "C:bootstrap-before-effect",
    "C:bootstrap-effect",
    "C:bootstrap-ledger",
    "C:doctor-effect",
    "C:doctor-ledger",
  ]) {
    const f = signedFixture(testKey());
    const killed = run(f, "install", [], { TEST_KILL_AT: point });
    assert.notEqual(killed.status, 0, point);
    const retry = run(f, "install");
    assert.equal(retry.status, 0, point + ": " + retry.stderr);
    assert(!fs.existsSync(join(f.root, "install/.lock")));
    assert(fs.existsSync(join(f.root, "identity/example.sqlite3")));
  }
});
test("full uninstall terminal kills converge through fallback without the printed command", () => {
  const payload = Object.keys(signedFixture(testKey()).payload);
  const everyProduct = payload.filter((name) => name.startsWith("product/"));
  for (const point of [
    ...everyProduct.map((name) => "U:recovery-after-unlink:" + name),
    ...[...everyProduct, "node", "MANIFEST.json", "release.json.sig", "release.json"].map(
      (name) => "U:recovery-copy:" + name,
    ),
    ...[...payload, "node", ".planned.json", "MANIFEST.json", "release.json.sig", "release.json"].map(
      (name) => "U:after-unlink:0.5.0/" + name,
    ),
    "U:resume-printed",
    "U:sentinel",
    "U:versions",
    "U:shared",
    "U:update-state",
    "U:temps",
    "U:claims",
    "U:owned",
    "U:current",
    "U:recovery-after-unlink:node",
    "U:recovery-after-unlink:DIGESTS.json",
    "U:recovery-after-unlink:product/src/cli.ts",
    "U:recovery-after-unlink:MANIFEST.json",
    "U:recovery-after-unlink:release.json.sig",
    "U:recovery-after-unlink:release.json",
    "U:recovery-directory",
    "U:lock-released",
  ]) {
    const f = signedFixture(testKey());
    let r = run(f, "install");
    assert.equal(r.status, 0, r.stderr);
    const data = tree(join(f.root, "identity"));
    r = run(f, "uninstall", [], { TEST_KILL_AT: point });
    assert.notEqual(r.status, 0, point);
    r = run(f, "install", ["--resume-uninstall"]);
    assert.equal(r.status, 0, point + ": " + r.stderr);
    assert(!fs.existsSync(join(f.root, "install")), point);
    assert.deepEqual(tree(join(f.root, "identity")), data);
  }
});
