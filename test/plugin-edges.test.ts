import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, delimiter } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI, ROOT, tree } from "./support.ts";
function fixture() {
  const f = signedFixture(testKey()),
    root = join(f.root, "install"),
    dir = join(f.root, "user-bin");
  fs.mkdirSync(dir);
  const args = [
    "--experimental-strip-types",
    CLI,
    "install",
    "--root",
    root,
    "--release",
    f.release,
    "--profile",
    "example",
    "--db",
    join(f.root, "identity/example.sqlite3"),
    ...(process.platform === "win32" ? [] : ["--user-bin", dir]),
  ];
  const run = (extra = {}) =>
    spawnSync(process.execPath, args, { env: { ...f.env, ...extra }, encoding: "utf8", timeout: 30000 });
  return { f, root, dir, args, run };
}
test(
  "external no-replace link keeps a concurrently created foreign file unchanged",
  { skip: process.platform === "win32" },
  async () => {
    const p = fixture(),
      marker = join(p.f.root, "paused"),
      resume = join(p.f.root, "continue");
    const child = spawn(process.execPath, p.args, {
      env: { ...p.f.env, TEST_PAUSE_AT: "C:user-link-before", TEST_PAUSE_MARKER: marker, TEST_PAUSE_RELEASE: resume },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b));
    child.stdout.resume();
    const ended = new Promise<number | null>((resolve) => child.once("close", resolve));
    try {
      for (let n = 0; !fs.existsSync(marker); n++) {
        assert(n < 750, stderr);
        await new Promise((r) => setTimeout(r, 20));
      }
      const path = join(p.dir, "trajecta"),
        bytes = Buffer.from("concurrent owner file");
      fs.writeFileSync(path, bytes);
      fs.writeFileSync(resume, "resume");
      assert.equal(await ended, 0, stderr);
      assert.deepEqual(fs.readFileSync(path), bytes);
      const data = JSON.parse(fs.readFileSync(join(p.root, "owned.json"), "utf8"));
      assert(!data.entries[path]);
    } finally {
      child.kill("SIGKILL");
    }
  },
);
test(
  "kills on both sides of the external link converge; direct PATH stub retains the real engine PID",
  { skip: process.platform === "win32" },
  () => {
    for (const point of ["C:user-link-before", "C:user-link-effect", "C:user-link-ledger"]) {
      const p = fixture();
      assert.notEqual(p.run({ TEST_KILL_AT: point }).status, 0, point);
      const retry = p.run();
      assert.equal(retry.status, 0, point + ": " + retry.stderr);
      const proof = join(p.f.root, "pid.json"),
        entry = join(p.root, "0.5.0/engines/identity/src/cli.ts");
      const child = spawnSync("trajecta", ["identity", "--help"], {
        env: {
          ...p.f.env,
          PATH: p.dir + delimiter + p.f.env.PATH,
          NODE_OPTIONS: "--import=" + new URL("./view-observe.ts", import.meta.url).href,
          TEST_PID_FILE: proof,
          TEST_PRODUCT_ROUTE: "1",
          TEST_ENGINE_ENTRIES: JSON.stringify([entry]),
        },
        encoding: "utf8",
      });
      assert.equal(child.status, 0, child.stderr);
      const observed = JSON.parse(fs.readFileSync(proof, "utf8"));
      assert.equal(observed.pid, child.pid);
      assert.equal(observed.argv[1], entry);
      assert.equal(fs.statSync(join(p.dir, "trajecta")).mode & 0o777, 0o755);
    }
  },
);
test(
  "editing the external hard link retains the changed root stub and never deletes the external name",
  { skip: process.platform === "win32" },
  () => {
    const p = fixture(),
      r = p.run();
    assert.equal(r.status, 0, r.stderr);
    const target = join(p.dir, "trajecta"),
      bytes = Buffer.from("owner modified shared inode\n");
    fs.writeFileSync(target, bytes);
    const removed = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "uninstall", "--root", p.root], {
      env: p.f.env,
      encoding: "utf8",
    });
    assert.equal(removed.status, 1);
    assert.deepEqual(fs.readFileSync(target), bytes);
    assert.deepEqual(fs.readFileSync(join(p.root, "bin/.user-stub")), bytes);
    assert.match(removed.stdout, /left .* in place/);
  },
);
test("write trace binds generation files and ledger to owner PID, permits only the single outside link and explicit --out", () => {
  const p = fixture(),
    trace = join(p.f.root, "trace.jsonl");
  fs.writeFileSync(trace, "");
  const env = {
    TEST_WRITE_TRACE: trace,
    TEST_WRITE_ROOTS: JSON.stringify([p.f.env.TRAJECTA_IDENTITY_DATA_DIR, p.f.env.TRAJECTA_HOME]),
    TEST_INSTALL_ROOT: p.root,
    TEST_EXTERNAL_LINK: join(p.dir, "trajecta"),
    NODE_OPTIONS: p.f.env.NODE_OPTIONS + " --import=" + new URL("./write-trace.ts", import.meta.url).href,
  };
  const installed = p.run(env);
  assert.equal(installed.status, 0, installed.stderr);
  const rows = fs
    .readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
  assert(rows.every((row) => row.accepted));
  const generation = rows.filter((row) => /plugins[/\\]trajecta-example[/\\]g1/.test(row.path));
  assert(generation.length);
  assert(generation.every((row) => row.pid === row.installOwner));
  assert.equal(new Set(rows.map((row) => row.pid)).size, 1);
  if (process.platform !== "win32") {
    const external = rows.filter((row) => row.externalLink);
    assert.equal(external.length, 1);
    assert.equal(external[0].method, "linkSync");
    assert.equal(external[0].path, join(p.dir, "trajecta"));
  }
  const out = join(p.f.root, "user-owned.plugin"),
    before = tree(p.root);
  fs.writeFileSync(trace, "");
  const built = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, "plugin", "--root", p.root, "--profile", "example", "--out", out],
    { env: { ...p.f.env, ...env, TEST_PLUGIN_OUTPUT: out }, encoding: "utf8" },
  );
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual(tree(p.root), before);
  const writes = fs
    .readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
  assert(writes.length);
  assert(writes.every((row) => row.accepted && row.pluginArtifact));
});
