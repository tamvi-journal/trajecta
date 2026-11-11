import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { CLI, ROOT, temporary, isolatedEnv, tree } from "./support.ts";
import { signedFixture, testKey } from "./install-fixture.ts";
import { acquire, release } from "../product/src/install-lock.ts";
import { ledger } from "../product/src/owned.ts";
import { stageShared, readShared, publishShared, publishUserStub } from "../product/src/shared-effects.ts";
import { userStub } from "../product/src/wrappers.ts";
import { registerHooks } from "node:module";

function run(f: ReturnType<typeof signedFixture>, command: string, args: string[] = [], env = {}) {
  return spawnSync(
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
    { cwd: ROOT, env: { ...f.env, ...env }, encoding: "utf8", timeout: 60000 },
  );
}
test("M3: install stages exact launchers/plugin, ledgers shared bytes, retries and uninstalls without touching stores", () => {
  const f = signedFixture(testKey()),
    root = join(f.root, "install");
  let r = run(f, "install", ["--profile", "example", "--no-user-bin"]);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(fs.readFileSync(join(root, "owned.json"), "utf8"));
  const plan = JSON.parse(fs.readFileSync(join(root, "0.5.0/.planned.json"), "utf8"));
  for (const [name, entry] of Object.entries(plan.shared.files) as Array<[string, any]>) {
    assert.deepEqual(fs.readFileSync(join(root, name)), fs.readFileSync(join(root, "0.5.0", entry.source)));
    assert.equal(data.entries[name].sha256, entry.sha256);
    assert.equal(data.entries[name].scope, "shared");
  }
  const base = "plugins/trajecta-example/g1";
  assert.equal(
    Object.values(data.entries).filter((entry: any) => entry.plugin === "trajecta-example" && entry.generation === 1)
      .length,
    4,
  );
  assert.deepEqual(
    fs.readFileSync(join(root, base, "trajecta.plugin")),
    fs.readFileSync(join(root, "0.5.0", plan.shared.plugin.archiveSource)),
  );
  assert.deepEqual(
    fs.readFileSync(join(root, base, "recipe.json")),
    fs.readFileSync(join(root, "0.5.0", plan.shared.plugin.recipeSource)),
  );
  const before = tree(root),
    stores = tree(join(f.root, "identity"));
  r = run(f, "install", ["--profile", "example", "--no-user-bin"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(tree(root), before);
  r = run(f, "doctor");
  assert.equal(r.status, 0, r.stderr);
  r = run(f, "uninstall");
  assert.equal(r.status, 0, r.stderr);
  assert(!fs.existsSync(root));
  assert.deepEqual(tree(join(f.root, "identity")), stores);
});
test("M3: no explicit profile means no plugin and a hint; a modified launcher is retained", () => {
  const f = signedFixture(testKey()),
    root = join(f.root, "install");
  const installed = run(f, "install", ["--no-user-bin"]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /trajecta plugin --profile <name>/);
  assert(!fs.existsSync(join(root, "plugins")));
  const file = join(root, "bin", process.platform === "win32" ? "trajecta.cmd" : "trajecta");
  fs.appendFileSync(file, "modified\n");
  const bytes = fs.readFileSync(file);
  const r = run(f, "uninstall");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /retained paths/);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.readFileSync(join(root, "current"), "utf8"), "uninstalling\n");
});
test("M3: launcher boundaries converge from staged bytes; plugin boundaries use the §13.6 generation gate", () => {
  const names =
    process.platform === "win32"
      ? ["bin/trajecta.cmd", "bin/trajecta-mcp.cmd"]
      : ["bin/trajecta", "bin/trajecta-mcp", "bin/.user-stub"];
  for (const point of [
    "A:shared-built",
    ...names.flatMap((name) => [
      "C:shared:" + name + ":before-rename",
      "C:shared:" + name + ":after-rename",
      "C:shared-effect:" + name,
      "C:shared-ledger:" + name,
    ]),
    "C:plugin-effect",
    "C:plugin-ledger",
  ]) {
    const f = signedFixture(testKey());
    const args = ["--profile", "example", "--no-user-bin"];
    const killed = run(f, "install", args, { TEST_KILL_AT: point });
    assert.notEqual(killed.status, 0, point);
    const r = run(f, "install", args);
    assert.equal(r.status, 0, point + ": " + r.stderr);
    const uninstalled = run(f, "uninstall");
    assert.equal(uninstalled.status, 0, point + ": " + uninstalled.stderr);
    assert(!fs.existsSync(join(f.root, "install")), point);
  }
});
test("shared plan never grants ownership to a pre-existing unreceipted equal file", async () => {
  const root = temporary(),
    source = join(root, "staging");
  fs.mkdirSync(source);
  fs.mkdirSync(join(root, "bin"));
  const before = Buffer.from("foreign\n"),
    file = join(root, "bin", process.platform === "win32" ? "trajecta.cmd" : "trajecta");
  fs.writeFileSync(file, before);
  const held = acquire(root);
  try {
    await stageShared(source, { root, profile: "example", noUserBin: true });
    const plan = readShared(source)!;
    // Even matching the planned bytes is not ownership when the file predated the plan.
    fs.writeFileSync(
      file,
      fs.readFileSync(
        join(source, plan.files["bin/" + (process.platform === "win32" ? "trajecta.cmd" : "trajecta")].source),
      ),
    );
    const data = ledger(root);
    await publishShared(root, source, plan, data);
    assert(!data.entries["bin/" + (process.platform === "win32" ? "trajecta.cmd" : "trajecta")]);
  } finally {
    release(root, ".lock", held);
  }
});
test(
  "POSIX external management is only a no-replace hard link; foreign, missing and EXDEV are untouched",
  { skip: process.platform === "win32" },
  async () => {
    const root = temporary(),
      outside = temporary(),
      dir = join(outside, "user-bin");
    fs.mkdirSync(join(root, "bin"));
    fs.writeFileSync(join(root, "bin/.user-stub"), userStub(root), { mode: 0o755 });
    const held = acquire(root),
      data = ledger(root);
    try {
      const before = tree(outside);
      publishUserStub(root, dir, data);
      assert.deepEqual(tree(outside), before);
      const ancestor = join(outside, "not-a-directory");
      fs.writeFileSync(ancestor, "foreign ancestor");
      const wrongKind = tree(outside);
      publishUserStub(root, join(ancestor, "user-bin"), data);
      assert.deepEqual(tree(outside), wrongKind);
      fs.mkdirSync(dir);
      const target = join(dir, "trajecta");
      fs.writeFileSync(target, "foreign");
      publishUserStub(root, dir, data);
      assert.equal(fs.readFileSync(target, "utf8"), "foreign");
      fs.unlinkSync(target);
      publishUserStub(root, dir, data);
      assert.equal(fs.statSync(target).ino, fs.statSync(join(root, "bin/.user-stub")).ino);
      assert.equal(fs.statSync(target).mode & 0o777, 0o755);
      assert.equal(data.entries[target].kind, "external-report");
      publishUserStub(root, dir, data);
      // Real filesystem call seam, scoped only to the one authorized link edge.
      const failing = registerHooks({
        load(url, context, next) {
          const result = next(url, context);
          if (!url.includes("shared-effects.ts?exdev")) return result;
          const source = String(result.source).replace(
            "fs.linkSync(source, target);",
            "throw Object.assign(new Error('cross-device'), {code:'EXDEV'});",
          );
          assert.notEqual(source, String(result.source));
          return { ...result, source };
        },
      });
      try {
        const fresh = await import(new URL("../product/src/shared-effects.ts?exdev", import.meta.url).href);
        const empty = join(outside, "empty");
        fs.mkdirSync(empty);
        fresh.publishUserStub(root, empty, data);
        assert.deepEqual(fs.readdirSync(empty), []);
      } finally {
        failing.deregister();
      }
    } finally {
      release(root, ".lock", held);
    }
  },
);
test(
  "POSIX install external link survives full uninstall with a precise report and refuses without product",
  { skip: process.platform === "win32" },
  () => {
    const f = signedFixture(testKey()),
      dir = join(f.root, "user-bin");
    fs.mkdirSync(dir);
    const r = run(f, "install", ["--user-bin", dir]);
    assert.equal(r.status, 0, r.stderr);
    const target = join(dir, "trajecta"),
      before = fs.readFileSync(target);
    const uninstalled = run(f, "uninstall");
    assert.equal(uninstalled.status, 0, uninstalled.stderr);
    assert.match(uninstalled.stdout, /left .* in place; remove it yourself/);
    assert.deepEqual(fs.readFileSync(target), before);
    assert(!fs.existsSync(join(f.root, "install")));
    const refused = spawnSync(target, ["version"], { env: f.env, encoding: "utf8" });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not installed at/);
  },
);

test("install retry resumes old-generation retirement before recording an already committed plugin effect", () => {
  for (const point of ["plugin:commit:after", "plugin:retire:after-unlink:1:.planned.json"]) {
    const key = testKey(),
      f = signedFixture(key),
      next = signedFixture(key, "0.5.1"),
      root = join(f.root, "install");
    let r = run(f, "install", ["--profile", "example", "--no-user-bin"]);
    assert.equal(r.status, 0, r.stderr);
    const retry = (extra = {}) =>
      spawnSync(
        process.execPath,
        [
          CLI,
          "install",
          "--root",
          root,
          "--release",
          next.release,
          "--db",
          join(f.root, "identity/example.sqlite3"),
          "--profile",
          "example",
          "--no-user-bin",
        ],
        { env: { ...f.env, ...extra }, encoding: "utf8", timeout: 30000 },
      );
    r = retry({ TEST_KILL_AT: point });
    assert.notEqual(r.status, 0, point);
    const old = () =>
      Object.values(ledger(root).entries).filter(
        (entry: any) => entry.plugin === "trajecta-example" && entry.generation === 1,
      );
    assert.equal(old().length, 4, point);
    r = retry();
    assert.equal(r.status, 0, point + ": " + r.stderr);
    assert.equal(old().length, 0, "retry must finish retirement before declaring the install effect complete");
    assert(!fs.existsSync(join(root, "plugins/trajecta-example/g1")));
    assert.equal(
      Object.values(ledger(root).entries).filter(
        (entry: any) => entry.plugin === "trajecta-example" && entry.generation === 2,
      ).length,
      4,
    );
    r = run(f, "uninstall");
    assert.equal(r.status, 0, r.stderr);
    assert(!fs.existsSync(root));
  }
});
