import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI, ROOT, temporary, isolatedEnv, tree } from "./support.ts";
import { pluginFiles } from "../product/src/plugin.ts";

test("M5: real identity/work initialize stdout is byte-exact directly and through each OS-native wrapper", async () => {
  const f = signedFixture(testKey()),
    root = join(f.root, "install");
  const env = { ...f.env, NODE_NO_WARNINGS: "1" };
  const installed = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      CLI,
      "install",
      "--root",
      root,
      "--release",
      f.release,
      "--db",
      join(f.root, "identity/example.sqlite3"),
      "--no-user-bin",
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const before = tree(root),
    stores = tree(join(f.root, "identity"));
  const servers = JSON.parse((await pluginFiles({ root, profile: "example" }))[".mcp.json"].toString()).mcpServers;
  const input = Buffer.from(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}\n',
  );
  for (const [label, entry] of Object.entries(servers) as Array<[string, any]>) {
    const identity = label.startsWith("trajecta-identity");
    const direct = spawnSync(
      process.execPath,
      [
        join(root, "0.5.0/engines", identity ? "identity/src/mcp.ts" : "work/src/mcp-server.ts"),
        ...(identity ? ["--profile", "example"] : []),
      ],
      { env, input, timeout: 15000 },
    );
    const wrapped = spawnSync(entry.command, entry.args, { env, input, timeout: 15000 });
    assert.equal(direct.status, 0, direct.stderr.toString());
    assert.equal(wrapped.status, direct.status, wrapped.stderr.toString());
    assert.deepEqual(wrapped.stdout, direct.stdout);
    assert.deepEqual(wrapped.stderr, direct.stderr);
    assert.equal(wrapped.stdout.toString().split("\n").length, 2);
    assert.equal(JSON.parse(wrapped.stdout.toString()).id, 1);
  }
  assert.deepEqual(tree(root), before);
  assert.deepEqual(tree(join(f.root, "identity")), stores);
});

test("product plugin --out is independent of cwd, atomic and unledgered; default output is shared-owned", () => {
  const folder = temporary(),
    env = isolatedEnv(folder),
    root = join(folder, "install"),
    out = join(folder, "out.plugin");
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", CLI, "plugin", "--root", root, "--profile", "example", ...args],
      { cwd: folder, env, encoding: "utf8" },
    );
  let result = run(["--out", out]);
  assert.equal(result.status, 0, result.stderr);
  assert(fs.existsSync(out));
  assert(!fs.existsSync(root));
  result = run([]);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(fs.readFileSync(join(root, "owned.json"), "utf8"));
  assert.equal(data.entries["plugins/trajecta-example.plugin"].scope, "shared");
  assert(!Object.keys(data.entries).includes(out));
  fs.writeFileSync(join(root, "plugins/trajecta-example.plugin"), "owner-edited");
  result = run([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /retained/);
  assert.equal(fs.readFileSync(join(root, "plugins/trajecta-example.plugin"), "utf8"), "owner-edited");
  const before = tree(folder);
  result = run(["--name", "x".repeat(60)]);
  assert.equal(result.status, 1);
  assert.deepEqual(tree(folder), before);
});
