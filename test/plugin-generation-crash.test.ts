import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI, ROOT, tree } from "./support.ts";

function fixture() {
  const f = signedFixture(testKey()),
    root = join(f.root, "install");
  const run = (verb: string, args: string[] = [], extra = {}) =>
    spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        CLI,
        verb,
        "--root",
        root,
        ...(verb === "install" ? ["--release", f.release, "--no-user-bin"] : []),
        ...args,
      ],
      { env: { ...f.env, ...extra }, encoding: "utf8", cwd: ROOT, timeout: 30000 },
    );
  const install = run("install");
  assert.equal(install.status, 0, install.stderr);
  const build = (extra = {}, db = "custom.sqlite3") =>
    run("plugin", ["--profile", "example", "--db", join(f.root, "identity", db)], extra);
  const update = () =>
    spawnSync(process.execPath, ["--experimental-strip-types", join(ROOT, "test/generation-update-helper.ts"), root], {
      env: f.env,
      encoding: "utf8",
      timeout: 30000,
    });
  const count = (n: number) =>
    Object.values(JSON.parse(fs.readFileSync(join(root, "owned.json"), "utf8")).entries).filter(
      (entry: any) => entry.plugin === "trajecta-example" && entry.generation === n,
    ).length;
  return { f, root, run, build, update, count };
}
const files = [".planned.json", "recipe.json", "trajecta.plugin"];
const buildPoints = [
  ...["plugins", "plugins/trajecta-example"].flatMap((name) => [
    "plugin:mkdir:before:" + name,
    "plugin:mkdir:after:" + name,
    "plugin:dir-ledger:before:" + name,
    "plugin:dir-ledger:after:" + name,
  ]),
  "plugin:g1:mkdir:before",
  "plugin:g1:mkdir:after",
  ...files.flatMap((file) => ["plugin:file:before-rename:" + file, "plugin:file:after-rename:" + file]),
  "plugin:commit:before",
  "plugin:commit:after",
];
test("real process kills at every generation creation boundary preserve 0-or-4 and never adopt crash leftovers", () => {
  for (const action of ["retry", "update-helper"])
    for (const point of buildPoints) {
      const f = fixture(),
        killed = f.build({ TEST_KILL_AT: point });
      assert.notEqual(killed.status, 0, point);
      assert([0, 4].includes(f.count(1)), point);
      const committedBefore = f.count(1) === 4,
        base = join(f.root, "plugins/trajecta-example/g1"),
        uncommitted = fs.existsSync(base) && !committedBefore,
        before = fs.existsSync(base) ? tree(base) : undefined;
      const subtree = tree(join(f.root, "plugins")),
        oldLedger = fs.readFileSync(join(f.root, "owned.json"));
      const r = action === "retry" ? f.build() : f.update();
      assert.equal(r.status, 0, point + ": " + r.stderr);
      if (action === "update-helper" && !committedBefore) {
        assert.deepEqual(tree(join(f.root, "plugins")), subtree, point);
        assert.deepEqual(fs.readFileSync(join(f.root, "owned.json")), oldLedger, point);
      }
      if (uncommitted) {
        assert.deepEqual(tree(base), before, point);
        assert.equal(f.count(1), 0, point);
      }
      if (action === "retry") {
        const uninstalled = f.run("uninstall");
        if (uncommitted) {
          assert.equal(uninstalled.status, 1, point);
          assert.deepEqual(tree(base), before, point);
          assert.equal(f.count(1), 0, point);
        } else {
          assert.equal(uninstalled.status, 0, point + ": " + uninstalled.stderr);
          assert(!fs.existsSync(f.root), point);
        }
      }
    }
});
test("each retirement kill resumes absent-file unlinks and atomically drops four receipts, including full uninstall of only g1", () => {
  const points = [
    ...files.flatMap((file) => ["plugin:retire:before-unlink:1:" + file, "plugin:retire:after-unlink:1:" + file]),
    "plugin:retire:before-rmdir:1",
    "plugin:retire:after-rmdir:1",
    "plugin:retire:before-ledger:1",
    "plugin:retire:after-ledger:1",
  ];
  for (const action of ["retry", "update-helper"])
    for (const point of points) {
      const f = fixture();
      let r = f.build();
      assert.equal(r.status, 0, r.stderr);
      r = f.build({ TEST_KILL_AT: point }, "second.sqlite3");
      assert.notEqual(r.status, 0, point);
      assert([0, 4].includes(f.count(1)), point);
      assert.equal(f.count(2), 4, point);
      r = action === "retry" ? f.build({}, "second.sqlite3") : f.update();
      assert.equal(r.status, 0, point + ": " + r.stderr);
      assert.equal(f.count(1), 0, point);
      const removed = f.run("uninstall");
      assert.equal(removed.status, 0, point + ": " + removed.stderr);
      assert(!fs.existsSync(f.root), point);
    }
  const f = fixture();
  assert.equal(f.build().status, 0);
  let r = f.run("uninstall", [], { TEST_KILL_AT: "plugin:retire:after-unlink:1:.planned.json" });
  assert.notEqual(r.status, 0);
  assert.equal(f.count(1), 4);
  r = f.run("uninstall", ["--resume"]);
  assert.equal(r.status, 0, r.stderr);
  assert(!fs.existsSync(f.root));
});
test("a foreign replacement after a creation kill is retained byte-for-byte through retry and full uninstall", () => {
  const f = fixture();
  assert.notEqual(f.build({ TEST_KILL_AT: "plugin:file:after-rename:recipe.json" }).status, 0);
  const path = join(f.root, "plugins/trajecta-example/g1/recipe.json");
  fs.writeFileSync(path, "foreign owner data");
  const before = fs.readFileSync(path);
  const retry = f.build();
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(fs.readFileSync(path), before);
  assert.equal(f.count(1), 0);
  const removed = f.run("uninstall");
  assert.equal(removed.status, 1);
  assert.deepEqual(fs.readFileSync(path), before);
  assert.equal(f.count(1), 0);
});
