/** #47 regression from the actual orphan-harness.ts STOP schedule. */
import * as fs from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { testKey, signedFixture } from "./install-fixture.ts";
import { CLI, ROOT, tree } from "./support.ts";
import { acquire, release } from "../product/src/install-lock.ts";

test("killing the owner kills the real staged writer; fresh lock survives and retry converges", async () => {
  const fixture = signedFixture(testKey()),
    root = join(fixture.root, "install"),
    db = join(fixture.root, "identity/example.sqlite3");
  const marker = join(fixture.root, "pause.json"),
    resume = join(fixture.root, "resume");
  const args = [
    "--experimental-strip-types",
    CLI,
    "install",
    "--root",
    root,
    "--release",
    fixture.release,
    "--db",
    db,
    "--work-root",
    join(fixture.root, "work"),
  ];
  const parent = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...fixture.env,
      TEST_PAUSE_AT: "C:bootstrap-before-effect",
      TEST_PAUSE_MARKER: marker,
      TEST_PAUSE_RELEASE: resume,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  parent.stderr!.on("data", (bytes) => (stderr += bytes));
  const ended = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
  let held: ReturnType<typeof acquire> | undefined;
  try {
    for (let n = 0; !fs.existsSync(marker); n++) {
      assert(n < 750, "gate timed out: " + stderr);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const writer = JSON.parse(fs.readFileSync(marker, "utf8")).pid;
    assert.equal(writer, parent.pid, "staged writer must be the actual owner, never a child");
    assert.equal(JSON.parse(fs.readFileSync(join(root, ".lock"), "utf8")).pid, writer);
    assert(!fs.existsSync(db));
    const ledgerBefore = fs.readFileSync(join(root, "owned.json"));
    parent.kill("SIGKILL");
    await ended;
    assert.throws(() => process.kill(writer, 0), { code: "ESRCH" });
    held = acquire(root);
    const before = tree(root);
    fs.writeFileSync(resume, "continue old gate");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(tree(root), before, "dead run writes nothing");
    assert(!fs.existsSync(db));
    assert(fs.readFileSync(join(root, "owned.json")).equals(ledgerBefore));
    assert.equal(JSON.parse(fs.readFileSync(join(root, ".lock"), "utf8")).token, held.token);
    release(root, ".lock", held);
    held = undefined;
    const retry = spawnSync(process.execPath, args, { cwd: ROOT, env: fixture.env, encoding: "utf8" });
    assert.equal(retry.status, 0, retry.stderr);
    assert(fs.existsSync(db));
    assert.equal(
      JSON.parse(fs.readFileSync(join(root, "owned.json"), "utf8")).effects["identity-bootstrap"].created,
      true,
    );
    assert(!fs.existsSync(join(root, ".lock")));
    assert(!fs.existsSync(join(fixture.root, "work")), "work remains lazy-empty");
  } finally {
    parent.kill("SIGKILL");
    if (held) release(root, ".lock", held);
  }
});
