import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { enginePath } from "../product/src/engines.ts";
import { compatibility } from "../tools/compat.ts";
import { CLI, ROOT, temporary, isolatedEnv, tree } from "./support.ts";
test("compat identity v4: real status/timeline/core-proposals/default/readonly retrieval read without migration", () => {
  const root = temporary();
  const fixture = join(ROOT, ".isolation/upstream/identity/spec/golden-cli-v1/status-legacy-v4/fixture");
  fs.cpSync(fixture, root, { recursive: true });
  const env = isolatedEnv(root);
  env.TRAJECTA_IDENTITY_DATA_DIR = join(root, "data");
  env.NODE_OPTIONS = "--import=" + new URL("./identity-seam.ts", import.meta.url).href;
  env.TEST_IDENTITY_INVOCATION = join(fixture, "../invocation.json");
  const argv = JSON.parse(fs.readFileSync(join(fixture, "../argv.json"), "utf8"));
  assert.deepEqual(compatibility().stores.identity.readable_schema_versions, [4, 5]);
  // Use the frozen fixture's explicit --db path/profile arguments.
  const before = tree(root),
    store = join(root, "store.sqlite3"),
    mtime = fs.statSync(store, { bigint: true }).mtimeNs;
  assert.equal(fs.readFileSync(store).readUInt32BE(60), 4);
  const sidecars = () =>
    fs
      .readdirSync(root)
      .filter((p) => p.startsWith("store.sqlite3"))
      .sort();
  const inventory = sidecars();
  for (const command of [
    ["status"],
    ["timeline"],
    ["core-proposals"],
    ["retrieve", "identity", "--readonly"],
    ["retrieve", "identity"],
  ]) {
    const args = argv.map((a: string) => (a === "{{ROOT}}/store.sqlite3" ? join(root, "store.sqlite3") : a));
    const at = args.indexOf("status");
    assert(at >= 0);
    args.splice(at, 1, ...command);
    const run = (prefix: string[]) =>
      spawnSync(process.execPath, ["--experimental-strip-types", ...prefix, ...args], { cwd: root, env });
    const direct = run([enginePath("identity")]),
      product = run([CLI, "identity"]);
    assert.equal(direct.status, 0, direct.stderr.toString());
    assert.equal(product.status, 0, product.stderr.toString());
    assert.deepEqual(product.stdout, direct.stdout);
    assert.deepEqual(product.stderr, direct.stderr);
    assert.equal(fs.statSync(store, { bigint: true }).mtimeNs, mtime);
    assert.equal(fs.readFileSync(store).readUInt32BE(60), 4);
    assert.deepEqual(sidecars(), inventory);
    const after = tree(root);
    for (const [path, digest] of Object.entries(before))
      if (path.endsWith(".sqlite3")) assert.equal(after[path], digest);
  }
});
