import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapSource, bootstrapFiles } from "../tools/bootstrap-build.ts";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI, ROOT, tree } from "./support.ts";
function bootstrap(f: ReturnType<typeof signedFixture>, args: string[] = []) {
  const url =
    "data:text/javascript;base64," + Buffer.from(bootstrapSource()).toString("base64") + "#trajecta-bootstrap";
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      "await import(process.env.TEST_BOOTSTRAP_URL)",
      "--",
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
    { cwd: ROOT, env: { ...f.env, TEST_BOOTSTRAP_URL: url }, encoding: "utf8" },
  );
}
test("committed bootstrap scripts exactly match the reviewed kernel on this Node", () => {
  for (const [name, source] of Object.entries(bootstrapFiles()))
    assert.equal(fs.readFileSync(join(ROOT, "product/install", name), "utf8"), source, name);
});
test("bootstrap verifies, imports and commits under its own lock; fallback converges after current removal", () => {
  const f = signedFixture(testKey());
  let r = bootstrap(f);
  assert.equal(r.status, 0, r.stderr);
  const data = tree(join(f.root, "identity"));
  r = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "uninstall", "--root", join(f.root, "install")], {
    cwd: ROOT,
    env: { ...f.env, TEST_KILL_AT: "U:current" },
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  r = bootstrap(f, ["--resume-uninstall"]);
  assert.equal(r.status, 0, r.stderr);
  assert(!fs.existsSync(join(f.root, "install")));
  assert.deepEqual(tree(join(f.root, "identity")), data);
});
test("real POSIX bootstrap with empty production anchor changes nothing", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX script; Windows script is tested separately");
    return;
  }
  const f = signedFixture(testKey()),
    env = { ...f.env };
  delete env.NODE_OPTIONS;
  const before = tree(f.root),
    r = spawnSync(
      "/bin/sh",
      [join(ROOT, "product/install/install.sh"), "--root", join(f.root, "install"), "--release", f.release],
      { cwd: ROOT, env, encoding: "utf8" },
    );
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "trajecta: no trusted release key configured\n");
  assert.deepEqual(tree(f.root), before);
});
test("real Windows bootstrap with empty production anchor changes nothing", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows acceptance runs on Windows");
    return;
  }
  const f = signedFixture(testKey()),
    env = { ...f.env };
  delete env.NODE_OPTIONS;
  const before = tree(f.root),
    r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(ROOT, "product/install/install.ps1"),
        "--root",
        join(f.root, "install"),
        "--release",
        f.release,
      ],
      { cwd: ROOT, env, encoding: "utf8" },
    );
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "trajecta: no trusted release key configured\n");
  assert.deepEqual(tree(f.root), before);
});

test("printed external anchor verifies every recovery byte before importing anything", () => {
  const f = signedFixture(testKey());
  let r = bootstrap(f);
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "uninstall", "--root", join(f.root, "install")], {
    cwd: ROOT,
    env: { ...f.env, TEST_KILL_AT: "U:sentinel" },
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  const command = r.stdout.replace(/^Resume command: /u, "").trimEnd();
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh",
    args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-c", command];
  const folder = join(f.root, "install/.uninstall"),
    list = join(folder, "DIGESTS.json"),
    file = join(folder, "product/src/cli.ts");
  const originalList = fs.readFileSync(list),
    originalFile = fs.readFileSync(file);
  fs.appendFileSync(file, "\n// co-tamper\n");
  const data = JSON.parse(originalList.toString());
  data.files["product/src/cli.ts"] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(list, JSON.stringify(data));
  const before = tree(folder);
  let refusal = spawnSync(shell, args, { cwd: ROOT, env: f.env, encoding: "utf8" });
  assert.notEqual(refusal.status, 0);
  assert.match(refusal.stderr, /recovery digest list mismatch/);
  assert.deepEqual(tree(folder), before);
  refusal = bootstrap(f, ["--resume-uninstall"]);
  assert.notEqual(refusal.status, 0);
  assert.match(refusal.stderr, /recovery product mismatch/);
  assert.deepEqual(tree(folder), before);
  fs.writeFileSync(list, originalList);
  fs.writeFileSync(file, originalFile);
  r = spawnSync(shell, args, { cwd: ROOT, env: f.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert(!fs.existsSync(join(f.root, "install")));
});
