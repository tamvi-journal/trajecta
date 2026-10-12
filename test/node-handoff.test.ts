import * as fs from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI, ROOT, tree } from "./support.ts";
test("no supported Node refuses before creating the lock/root or a store", () => {
  const f = signedFixture(testKey()),
    before = tree(f.root);
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, "install", "--root", join(f.root, "install"), "--release", f.release],
    { cwd: ROOT, env: { ...f.env, TEST_NODE_CANDIDATES: "[]" }, encoding: "utf8" },
  );
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "trajecta: need Node 22.19+ or 24 LTS\n");
  assert.deepEqual(tree(f.root), before);
});
test("a selected different runtime takes ownership only after read-only handoff", async (t) => {
  const other = process.env.TEST_OTHER_NODE;
  if (!other) {
    assert(!process.env.CI, "every CI job must provide its alternate supported Node");
    t.skip("alternate supported Node path not supplied locally; required in every matrix job");
    return;
  }
  const f = signedFixture(testKey()),
    root = join(f.root, "install"),
    marker = join(f.root, "marker"),
    resume = join(f.root, "resume");
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", CLI, "install", "--root", root, "--release", f.release],
    {
      cwd: ROOT,
      env: {
        ...f.env,
        TEST_NODE_CANDIDATES: JSON.stringify([other]),
        TEST_PAUSE_AT: "C:bootstrap-before-effect",
        TEST_PAUSE_MARKER: marker,
        TEST_PAUSE_RELEASE: resume,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let err = "";
  child.stderr!.on("data", (bytes) => (err += bytes));
  const ended = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  try {
    for (let n = 0; !fs.existsSync(marker); n++) {
      assert(n < 750, err);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const owner = JSON.parse(fs.readFileSync(join(root, ".lock"), "utf8")),
      writer = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(owner.pid, writer.pid);
    assert.equal(child.exitCode, null, "the pre-lock handoff waiter stays alive while its owner is paused");
    if (process.platform !== "win32") assert.equal(writer.pid, child.pid, "POSIX exec preserves PID");
    assert.equal(fs.readFileSync(join(root, "0.5.0/node"), "utf8"), fs.realpathSync.native(other) + "\n");
    fs.writeFileSync(resume, "continue");
    assert.equal(await ended, 0, err);
  } finally {
    child.kill("SIGKILL");
  }
});
test("empty production anchor refuses without changing inventory", () => {
  const f = signedFixture(testKey()),
    env = { ...f.env };
  delete env.NODE_OPTIONS;
  delete env.TEST_TRUST_ANCHOR;
  const before = tree(f.root),
    r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", CLI, "install", "--root", join(f.root, "install"), "--release", f.release],
      { cwd: ROOT, env, encoding: "utf8" },
    );
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "trajecta: no trusted release key configured\n");
  assert.deepEqual(tree(f.root), before);
});

test("production trust and writer-lifetime source fence", async () => {
  const { checkInstall } = await import("../tools/install-scan.ts");
  checkInstall();
});
