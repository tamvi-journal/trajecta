import * as fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI, ROOT, tree } from "./support.ts";
test("install bootstrap matches direct public init; doctor reads only; every writer has the lock-owner PID", () => {
  const f = signedFixture(testKey()),
    root = join(f.root, "install"),
    db = join(f.root, "identity/example.sqlite3"),
    trace = join(f.root, "trace.jsonl");
  fs.writeFileSync(trace, "");
  const env = {
    ...f.env,
    TEST_INSTALL_ROOT: root,
    TEST_WRITE_TRACE: trace,
    TEST_WRITE_ROOTS: JSON.stringify([f.env.TRAJECTA_IDENTITY_DATA_DIR, f.env.TRAJECTA_HOME]),
    TEST_FIXED_IDENTITY: "1",
    NODE_OPTIONS: f.env.NODE_OPTIONS + " --import=" + new URL("./write-trace.ts", import.meta.url).href,
  };
  const args = ["--root", root, "--release", f.release, "--db", db, "--work-root", f.env.TRAJECTA_HOME];
  let r = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "install", ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const actual = fs.readFileSync(db),
    direct = join(f.root, "direct.sqlite3");
  r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(ROOT, "engines/identity/src/cli.ts"),
      "--profile",
      "example",
      "--db",
      direct,
      "init",
    ],
    { cwd: ROOT, env: { ...f.env, TEST_FIXED_IDENTITY: "1" }, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert(fs.readFileSync(direct).equals(actual), "byte-exact engine bootstrap");
  const rows = fs
    .readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
  assert(rows.length > 0);
  assert(rows.every((row) => row.accepted));
  assert.equal(new Set(rows.map((row) => row.pid)).size, 1, "only lock-owner process writes");
  const holder = rows.find((row) => row.method === "sqlite.open" && row.mediated)?.installOwner;
  assert(holder);
  for (const selected of [
    rows.filter((row) => row.path.includes(".staging-") && /write|open/u.test(row.method)),
    rows.filter((row) => row.method.startsWith("sqlite.")),
    rows.filter((row) => row.path.endsWith("owned.json") || row.path.endsWith("owned.json.tmp")),
  ]) {
    assert(selected.length);
    assert(selected.every((row) => row.pid === holder && row.installOwner === holder));
  }
  assert(!fs.existsSync(f.env.TRAJECTA_HOME));
  const before = tree(f.root);
  fs.writeFileSync(trace, "");
  r = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "doctor", ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(trace, "utf8"), "", "doctor has no filesystem or SQLite writes");
  const after = tree(f.root);
  delete before["trace.jsonl"];
  delete after["trace.jsonl"];
  assert.deepEqual(after, before);
});
