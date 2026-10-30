import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { testKey, useTestKey, signedFixture, recoveryFixture } from "./install-fixture.ts";
import { ROOT, tree } from "./support.ts";
const key = testKey();
useTestKey(key);
const { cleanupRecovery } = await import("../product/src/recovery.ts");
test("R46-1: signed remaining PRODUCT authenticates; node/list are never read or executed", () => {
  const f = signedFixture(key, "0.5.0", true),
    folder = recoveryFixture(f);
  const native = createRequire(import.meta.url)("node:fs"),
    read = native.readFileSync;
  native.readFileSync = (path: any, ...args: any[]) => {
    if (path === join(folder, "node") || path === join(folder, "DIGESTS.json")) throw new Error("inert data read");
    return read(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.deepEqual(cleanupRecovery(dirname(folder)), []);
  } finally {
    native.readFileSync = read;
    syncBuiltinESMExports();
  }
  assert(!fs.existsSync(folder));
});
test("R46-1 A: co-tampered product/list, unknown product and invalid signed controls retain EVERYTHING", () => {
  for (const kind of ["tamper", "unknown", "signature", "manifest", "missing-metadata"]) {
    const f = signedFixture(key, "0.5.0", true),
      folder = recoveryFixture(f);
    if (kind === "tamper") {
      fs.writeFileSync(join(folder, "product/src/a.ts"), "modified");
      fs.writeFileSync(join(folder, "DIGESTS.json"), JSON.stringify({ files: { "product/src/a.ts": "forged" } }));
    }
    if (kind === "unknown") fs.writeFileSync(join(folder, "product/unknown.ts"), "unknown");
    if (kind === "signature") fs.writeFileSync(join(folder, "release.json.sig"), Buffer.alloc(64).toString("base64"));
    if (kind === "manifest") fs.appendFileSync(join(folder, "MANIFEST.json"), " ");
    if (kind === "missing-metadata") fs.unlinkSync(join(folder, "release.json"));
    const before = tree(dirname(folder));
    assert.throws(
      () => cleanupRecovery(dirname(folder)),
      /recovery product|signature|MANIFEST|signed recovery control/u,
    );
    assert.deepEqual(tree(dirname(folder)), before);
  }
});
test("R46-1: every B/C/D unlink crash, including zero products, converges with a lost printed anchor", () => {
  const names = [
    "node",
    "DIGESTS.json",
    "product/deep/b.ts",
    "product/src/a.ts",
    "product/trajecta-extract.mjs",
    "MANIFEST.json",
    "release.json.sig",
    "release.json",
  ];
  for (const name of names) {
    const f = signedFixture(key, "0.5.0", true),
      folder = recoveryFixture(f),
      env = { ...f.env, TEST_KILL_AT: "U:recovery-after-unlink:" + name };
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(new URL("./recovery-worker.ts", import.meta.url)), dirname(folder)],
      { cwd: ROOT, env, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, `${name}: ${result.stderr}`);
    assert(!fs.existsSync(join(folder, name)), name);
    assert.deepEqual(cleanupRecovery(dirname(folder)), []);
    assert(!fs.existsSync(folder), name);
  }
});
test("R46-1 E: unrelated names and non-MANIFEST directories are retained and reported", () => {
  const f = signedFixture(key, "0.5.0", true),
    folder = recoveryFixture(f);
  fs.writeFileSync(join(folder, "owner-note"), "keep");
  fs.mkdirSync(join(folder, "owner-dir"));
  const kept = cleanupRecovery(dirname(folder));
  assert(kept.includes(join(folder, "owner-note")));
  assert(kept.includes(join(folder, "owner-dir")));
  assert.equal(fs.readFileSync(join(folder, "owner-note"), "utf8"), "keep");
});
test("R46-1: no products permits deletion of inert signed-control remnants without trusting them", () => {
  for (const name of ["MANIFEST.json", "release.json.sig", "release.json"]) {
    const f = signedFixture(key, "0.5.0", true),
      folder = join(f.root, "install/.uninstall");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(join(folder, name), "untrusted remnant");
    assert.deepEqual(cleanupRecovery(dirname(folder)), []);
    assert(!fs.existsSync(folder));
  }
});
test("R46-1: inert-name links are kept; PRODUCT links fail A without any unlink", () => {
  for (const name of ["node", "DIGESTS.json", "product/src/a.ts"]) {
    const f = signedFixture(key, "0.5.0", true),
      folder = recoveryFixture(f),
      target = join(f.root, "link-target");
    fs.mkdirSync(target);
    fs.unlinkSync(join(folder, name));
    fs.symlinkSync(target, join(folder, name), "junction");
    if (name.startsWith("product/")) {
      const before = tree(dirname(folder));
      assert.throws(() => cleanupRecovery(dirname(folder)), /regular file/u);
      assert.deepEqual(tree(dirname(folder)), before);
    } else {
      const kept = cleanupRecovery(dirname(folder));
      assert(kept.includes(join(folder, name)));
      assert(fs.lstatSync(join(folder, name)).isSymbolicLink());
    }
  }
});
