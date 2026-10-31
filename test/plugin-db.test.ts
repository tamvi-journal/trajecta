import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import test from "node:test";
import { pluginFiles, PluginInputError } from "../product/src/plugin.ts";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI, ROOT, tree } from "./support.ts";

function mcpFromZip(path: string): any {
  const bytes = fs.readFileSync(path);
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18),
      length = bytes.readUInt16LE(offset + 26),
      extra = bytes.readUInt16LE(offset + 28),
      name = bytes.subarray(offset + 30, offset + 30 + length).toString(),
      start = offset + 30 + length + extra;
    if (name === ".mcp.json")
      return JSON.parse(inflateRawSync(bytes.subarray(start, start + size)).toString()).mcpServers;
    offset = start + size;
  }
  throw new Error("archive lacks MCP recipe");
}
test("S5 explicit database reaches the identity recipe; profile-only keeps runtime default resolution", async () => {
  const files = await pluginFiles({ root: "/isolated", profile: "example", db: "/isolated/custom.sqlite3" }, "posix");
  const servers = JSON.parse(files[".mcp.json"].toString()).mcpServers;
  assert.deepEqual(servers["trajecta-identity-example"].args.slice(-4), [
    "--profile",
    "example",
    "--db",
    "/isolated/custom.sqlite3",
  ]);
  for (const char of [...'%!^&|<>"()', "\n"])
    await assert.rejects(
      pluginFiles({ root: "C:\\isolated", profile: "example", db: "C:\\custom" + char }, "windows"),
      (e) => e instanceof PluginInputError && /db/u.test(e.message),
    );
  // Safety is applied to the mandated absolute recipe value. A drive root retains
  // its trailing backslash after resolution and must be refused.
  await assert.rejects(
    pluginFiles({ root: "C:\\isolated", profile: "example", db: "C:\\" }, "windows"),
    (e) => e instanceof PluginInputError && /db/u.test(e.message),
  );
});
test("install custom DB and later standalone second DB stay bound through real archived MCP recipes", () => {
  const f = signedFixture(testKey()),
    root = join(f.root, "install"),
    custom = join(f.root, "identity/custom.sqlite3"),
    second = join(f.root, "identity/second.sqlite3"),
    env = { ...f.env, NODE_NO_WARNINGS: "1" };
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], {
      env,
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30000,
    });
  const installed = run([
    "install",
    "--root",
    root,
    "--release",
    f.release,
    "--profile",
    "example",
    "--db",
    custom,
    "--no-user-bin",
  ]);
  assert.equal(installed.status, 0, installed.stderr);
  const status = (g: number, expected: string) => {
    const servers = mcpFromZip(join(root, `plugins/trajecta-example/g${g}/trajecta.plugin`)),
      entry = servers["trajecta-identity-example"];
    const before = tree(join(f.root, "identity"));
    const input =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"identity_status","arguments":{}}}\n';
    const r = spawnSync(entry.command, entry.args, { env, input, encoding: "utf8", timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout.trim().split("\n")[1]).result.structuredContent;
    assert.equal(result.db, expected);
    assert.equal(result.store, "ready");
    assert.deepEqual(tree(join(f.root, "identity")), before);
    assert(!fs.existsSync(join(f.root, "identity/example.sqlite3")));
  };
  status(1, custom);
  const init = run(["identity", "--profile", "example", "--db", second, "init"]);
  assert.equal(init.status, 0, init.stderr);
  const built = run(["plugin", "--root", root, "--profile", "example", "--db", second]);
  assert.equal(built.status, 0, built.stderr);
  status(2, second);
  const before = tree(root),
    doctor = run(["doctor", "--root", root, "--db", custom]);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /g2/);
  assert.deepEqual(tree(root), before);
  const removed = run(["uninstall", "--root", root, "--db", custom]);
  assert.equal(removed.status, 0, removed.stderr);
  assert(!fs.existsSync(root));
  assert(fs.existsSync(custom));
  assert(fs.existsSync(second));
});
