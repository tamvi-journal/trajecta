import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { canonical } from "../product/src/update-json.ts";
import { decideIndex, decodeState, encodeState } from "../product/src/update-state.ts";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI, ROOT, tree } from "./support.ts";

const key = testKey();
function fixture(sequence = 10) {
  return signedFixture(key, "0.5.0", false, "release", sequence);
}
function run(f: ReturnType<typeof fixture>, command: string, args: string[] = [], extra: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, command, "--root", join(f.root, "install"), ...args],
    { env: { ...f.env, ...extra }, encoding: "utf8" },
  );
}
function install(f: ReturnType<typeof fixture>, extra: Record<string, string> = {}, release = f.release) {
  return run(
    f,
    "install",
    [
      "--release",
      release,
      "--db",
      join(f.root, "identity/example.sqlite3"),
      "--work-root",
      join(f.root, "work"),
      "--no-user-bin",
    ],
    extra,
  );
}
function publish(f: ReturnType<typeof fixture>, sequence: number, rotations: any[] = [], signer = key) {
  const directory = join(f.root, "index");
  fs.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(
    canonical({
      schema: "trajecta.index/v1",
      sequence,
      expires: "2099-01-01T00:00:00Z",
      latest: "0.5.0",
      releases: [{ version: "0.5.0", release_sha256: "a".repeat(64) }],
      rotations,
    }),
  );
  fs.writeFileSync(join(directory, "index.json"), bytes);
  fs.writeFileSync(join(directory, "index.json.sig"), signer.sign(bytes));
  return { directory, bytes, signature: signer.sign(bytes) };
}
function state(f: ReturnType<typeof fixture>) {
  return decodeState(fs.readFileSync(join(f.root, "install/update-state.json")), key.anchor);
}
test("check is byte-pure, reset enforces TTY, manifest floor and signer point", () => {
  const f = fixture();
  assert.equal(install(f).status, 0);
  const i = publish(f, 20),
    before = tree(join(f.root, "install"));
  let r = run(f, "update", ["--check", "--from", i.directory]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /active 0.5.0/);
  assert.deepEqual(tree(join(f.root, "install")), before);
  r = run(f, "update", ["--reset-state", "--from", i.directory]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /terminal/);
  assert.deepEqual(tree(join(f.root, "install")), before);
  r = run(f, "update", ["--reset-state", "--from", i.directory], { TEST_CONFIRM_RESET: "yes" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /previously seen but never installed/);
  assert.equal(state(f).floor, 20);
  assert.equal(state(f).accepted!.sequence, 20);
  const after = tree(join(f.root, "install"));
  r = run(f, "update", ["--check", "--from", i.directory]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(tree(join(f.root, "install")), after);
  publish(f, 19);
  r = run(f, "update", ["--check", "--from", i.directory]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /replay/);
  assert.deepEqual(tree(join(f.root, "install")), after);
  publish(f, 9);
  r = run(f, "update", ["--reset-state", "--from", i.directory], { TEST_CONFIRM_RESET: "yes" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /manifest floor/);
  assert.deepEqual(tree(join(f.root, "install")), after);
});
test("lost/corrupt state refuses install, update and check without protected-tree changes", () => {
  for (const damaged of ["missing", "checksum", "symlink", "directory"]) {
    const f = fixture();
    assert.equal(install(f).status, 0);
    const path = join(f.root, "install/update-state.json"),
      original = fs.readFileSync(path);
    fs.unlinkSync(path);
    if (damaged === "checksum") fs.writeFileSync(path, Buffer.concat([original, Buffer.from("x")]));
    if (damaged === "directory") fs.mkdirSync(path);
    if (damaged === "symlink") {
      fs.writeFileSync(join(f.root, "target"), original);
      fs.symlinkSync(join(f.root, "target"), path);
    }
    const i = publish(f, 10),
      before = tree(join(f.root, "install"));
    for (const mode of ["install", "check", "update"]) {
      const r =
        mode === "install"
          ? install(f)
          : run(f, "update", [...(mode === "check" ? ["--check"] : []), "--from", i.directory]);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /reset-state/);
      assert.deepEqual(tree(join(f.root, "install")), before);
    }
  }
});
test("fresh state write crashes converge; reserved temp is cleared only under lock", () => {
  for (const point of ["update-state:before-rename", "update-state:after-rename"]) {
    const f = fixture(),
      r = install(f, { TEST_KILL_AT: point });
    assert.notEqual(r.status, 0);
    const root = join(f.root, "install");
    assert(!fs.readdirSync(root).some((n) => n.startsWith(".staging-")));
    const retry = install(f);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(state(f).floor, 10);
  }
  for (const kind of ["directory", "symlink"]) {
    const f = fixture(),
      root = join(f.root, "install"),
      tmp = join(root, "update-state.json.tmp");
    fs.mkdirSync(root);
    if (kind === "directory") fs.mkdirSync(tmp);
    else {
      fs.symlinkSync(join(f.root, "missing"), tmp);
    }
    const before = tree(root),
      r = install(f);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /update-state.json.tmp/);
    assert.deepEqual(tree(root), before);
  }
});
test("install raises floor only; uninstall preserves replay state unless live typed reset", () => {
  const f = fixture();
  assert.equal(install(f).status, 0);
  const i = publish(f, 10),
    accepted = decideIndex(i.bytes, i.signature, state(f), key.anchor).state;
  fs.writeFileSync(join(f.root, "install/update-state.json"), encodeState(accepted));
  const next = signedFixture(key, "0.5.1", false, "release", 20);
  let r = install(f, {}, next.release);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state(f).floor, 20);
  assert.deepEqual(state(f).accepted, accepted.accepted);
  r = run(f, "update", ["--check", "--from", i.directory]);
  assert.match(r.stderr, /replay/);
  publish(f, 21);
  r = run(f, "update", ["--reset-state", "--from", i.directory], { TEST_CONFIRM_RESET: "yes" });
  assert.equal(r.status, 0, r.stderr);
  const before = fs.readFileSync(join(f.root, "install/update-state.json"));
  r = run(f, "install", [
    "--rollback",
    "--db",
    join(f.root, "identity/example.sqlite3"),
    "--work-root",
    join(f.root, "work"),
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert(fs.readFileSync(join(f.root, "install/update-state.json")).equals(before));
  r = run(f, "uninstall", ["--yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(tree(join(f.root, "install"))), ["update-state.json"]);
  assert(fs.readFileSync(join(f.root, "install/update-state.json")).equals(before));
  const older = signedFixture(key, "0.5.0", false, "release", 5);
  r = install(f, {}, older.release);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state(f).floor, 21);
  r = run(f, "uninstall", [], { TEST_CONFIRM_RESET: "yes" });
  assert.equal(r.status, 0, r.stderr);
  assert(!fs.existsSync(join(f.root, "install")));
  r = install(f, {}, older.release);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state(f).floor, 5);
});
test("forged reset markers are reported and never authorize deletion", () => {
  const f = fixture();
  assert.equal(install(f).status, 0);
  let r = run(f, "uninstall");
  assert.equal(r.status, 0, r.stderr);
  const root = join(f.root, "install"),
    before = fs.readFileSync(join(root, "update-state.json"));
  fs.writeFileSync(join(root, "update-state.reset"), "");
  const older = signedFixture(key, "0.5.0", false, "release", 5);
  r = install(f, {}, older.release);
  assert.equal(r.status, 0, r.stderr);
  assert(fs.readFileSync(join(root, "update-state.json")).equals(before));
  assert.match(r.stdout, /Retained unexpected path: .*update-state.reset/);
  assert(fs.existsSync(join(root, "update-state.reset")));
});

test("reset state write crashes are atomic and known-index rechecks never rewrite state", () => {
  for (const point of ["update-state:before-rename", "update-state:after-rename"]) {
    const f = fixture();
    assert.equal(install(f).status, 0);
    const i = publish(f, 20);
    const killed = run(f, "update", ["--reset-state", "--from", i.directory], {
      TEST_CONFIRM_RESET: "yes",
      TEST_KILL_AT: point,
    });
    assert.notEqual(killed.status, 0);
    const persisted = state(f);
    assert.equal(persisted.floor, point.endsWith("before-rename") ? 10 : 20);
    const retry = run(f, "update", ["--reset-state", "--from", i.directory], { TEST_CONFIRM_RESET: "yes" });
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(state(f).floor, 20);
    const before = tree(join(f.root, "install"));
    const checked = run(f, "update", ["--check", "--from", i.directory]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(tree(join(f.root, "install")), before);
  }
});

test("normal index acceptance persists paired sequence/digest; known rotation-bearing replay survives each state-write crash", () => {
  const nextKey = testKey();
  const body = { schema: "trajecta.rotation/v1", from: key.anchor, to: nextKey.anchor, sequence: 20 };
  const rotation = { ...body, signature: key.sign(Buffer.from(canonical(body))).trim() };
  for (const point of ["update-state:before-rename", "update-state:after-rename"]) {
    const f = fixture();
    assert.equal(install(f).status, 0);
    const i = publish(f, 20, [rotation]),
      worker = join(f.root, "accept.mjs");
    fs.writeFileSync(
      worker,
      `import fs from "node:fs";
      import {acceptIndex} from ${JSON.stringify(new URL("../product/src/update-state.ts", import.meta.url).href)};
      import {acquire,release} from ${JSON.stringify(new URL("../product/src/install-lock.ts", import.meta.url).href)};
      const [root,source]=process.argv.slice(2),held=acquire(root);
      try{acceptIndex(root,fs.readFileSync(source+"/index.json"),fs.readFileSync(source+"/index.json.sig","utf8"));}
      finally{release(root,".lock",held);}`,
    );
    const root = join(f.root, "install");
    let r = spawnSync(process.execPath, ["--experimental-strip-types", worker, root, i.directory], {
      env: { ...f.env, TEST_KILL_AT: point },
      encoding: "utf8",
    });
    assert.notEqual(r.status, 0);
    const persisted = state(f);
    if (point.endsWith("before-rename")) {
      assert(fs.existsSync(join(root, "update-state.json.tmp")));
      const orphanTree = tree(root);
      const check = run(f, "update", ["--check", "--from", i.directory]);
      assert.equal(check.status, 0, check.stderr);
      assert.deepEqual(tree(root), orphanTree);
    }
    if (point.endsWith("before-rename")) assert.equal(persisted.accepted, null);
    else {
      assert.equal(persisted.accepted!.sequence, 20);
      assert.equal(persisted.rotations.length, 1);
    }
    r = spawnSync(process.execPath, ["--experimental-strip-types", worker, root, i.directory], {
      env: f.env,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(state(f).rotations.length, 1);
    const before = tree(root),
      stamp = fs.statSync(join(root, "update-state.json"), { bigint: true }).mtimeNs;
    // Known K0-signed I20 is accepted after K1 became newest, without rechecking its signature.
    fs.writeFileSync(join(i.directory, "index.json.sig"), "invalid");
    r = spawnSync(process.execPath, ["--experimental-strip-types", worker, root, i.directory], {
      env: f.env,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(tree(root), before);
    assert.equal(fs.statSync(join(root, "update-state.json"), { bigint: true }).mtimeNs, stamp);
  }
});

test("unsequenced release refuses before seeding; malformed state survives a typed uninstall", async () => {
  const { tarball } = await import("../tools/archive.ts"),
    { releaseMetadata } = await import("../tools/build-release.ts");
  const f = fixture(),
    manifest = { ...f.manifest };
  delete (manifest as any).index_sequence;
  const archive = tarball(
    { ...f.payload, "MANIFEST.json": Buffer.from(JSON.stringify(manifest, null, 2) + "\n") },
    "trajecta-0.5.0",
  );
  const metadata = Buffer.from(JSON.stringify(releaseMetadata(archive, "0.5.0"), null, 2) + "\n");
  fs.writeFileSync(join(f.release, "trajecta-0.5.0.tar.gz"), archive);
  fs.writeFileSync(join(f.release, "release.json"), metadata);
  fs.writeFileSync(join(f.release, "release.json.sig"), key.sign(metadata));
  const refused = install(f);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, "trajecta: release has no index_sequence\n");
  assert(!fs.existsSync(join(f.root, "install")));
  const other = fixture();
  assert.equal(install(other).status, 0);
  const path = join(other.root, "install/update-state.json"),
    bad = Buffer.concat([fs.readFileSync(path), Buffer.from("x")]);
  fs.writeFileSync(path, bad);
  const removed = run(other, "uninstall", [], { TEST_CONFIRM_RESET: "yes" });
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(Object.keys(tree(join(other.root, "install"))), ["update-state.json"]);
  assert(fs.readFileSync(path).equals(bad));
  assert.match(removed.stdout, /Retained invalid update-state/);
});

test("only a live reset can lower a previously seen but uninstalled sequence", () => {
  const f = fixture();
  assert.equal(install(f).status, 0);
  const i = publish(f, 30);
  let r = run(f, "update", ["--reset-state", "--from", i.directory], { TEST_CONFIRM_RESET: "yes" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state(f).floor, 30);
  publish(f, 20);
  r = run(f, "update", ["--check", "--from", i.directory]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /replay/);
  r = run(f, "update", ["--reset-state", "--from", i.directory], { TEST_CONFIRM_RESET: "yes" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state(f).floor, 20);
  assert.match(r.stdout, /previously seen but never installed/);
});
