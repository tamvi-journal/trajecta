import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI, ROOT, temporary, isolatedEnv, tree } from "./support.ts";
import { pluginFiles } from "../product/src/plugin.ts";
import { prewarmWindowsHost } from "./windows-host-a.ts";
import { receipt } from "./native-m5-support.ts";
import { pathToFileURL } from "node:url";

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
  if (process.platform === "win32")
    prewarmWindowsHost(win32.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"), env);
  const before = tree(root),
    stores = tree(join(f.root, "identity"));
  const servers = JSON.parse((await pluginFiles({ root, profile: "example" }))[".mcp.json"].toString()).mcpServers;
  const input = Buffer.from(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}\n',
  );
  const evidence: unknown[] = [];
  for (const [label, entry] of Object.entries(servers) as Array<[string, any]>) {
    const identity = label.startsWith("trajecta-identity");
    const observed = join(f.root, "mcp-entry.json");
    const runEnv =
      process.platform === "win32"
        ? env
        : {
            ...env,
            NODE_OPTIONS: "--import=" + pathToFileURL(join(ROOT, "test/native-m5-entry-observer.ts")).href,
            TEST_M5_ENTRY_RECEIPT: observed,
          };
    const direct = spawnSync(
      process.execPath,
      [
        join(root, "0.5.0/engines", identity ? "identity/src/mcp.ts" : "work/src/mcp-server.ts"),
        ...(identity ? ["--profile", "example"] : []),
      ],
      { env: runEnv, input, timeout: 15000 },
    );
    const directEntry =
      process.platform === "win32" || !fs.existsSync(observed) ? null : JSON.parse(fs.readFileSync(observed, "utf8"));
    if (fs.existsSync(observed)) fs.unlinkSync(observed);
    const wrapped = spawnSync(entry.command, entry.args, { env: runEnv, input, timeout: 15000 });
    const wrappedEntry =
      process.platform === "win32" || !fs.existsSync(observed) ? null : JSON.parse(fs.readFileSync(observed, "utf8"));
    evidence.push({
      label,
      command: entry.command,
      args: entry.args,
      input_hex: input.toString("hex"),
      direct: {
        pid: direct.pid,
        status: direct.status,
        stdout_hex: direct.stdout?.toString("hex"),
        stderr_hex: direct.stderr?.toString("hex"),
        entry: directEntry,
      },
      wrapped: {
        pid: wrapped.pid,
        status: wrapped.status,
        stdout_hex: wrapped.stdout?.toString("hex"),
        stderr_hex: wrapped.stderr?.toString("hex"),
        entry: wrappedEntry,
      },
    });
    receipt("mcp-framing-posix-and-cmd", { root, results: evidence });
    assert.equal(direct.status, 0, direct.stderr.toString());
    assert.equal(wrapped.status, direct.status, wrapped.stderr.toString());
    assert.deepEqual(wrapped.stdout, direct.stdout);
    assert.deepEqual(wrapped.stderr, direct.stderr);
    assert.equal(wrapped.stdout.toString().split("\n").length, 2);
    assert.equal(JSON.parse(wrapped.stdout.toString()).id, 1);
    if (process.platform !== "win32") {
      assert(wrappedEntry && directEntry);
      assert.equal(wrappedEntry.pid, wrapped.pid, "real engine PID equals /bin/sh wrapper PID");
      assert.deepEqual(wrappedEntry.argv, directEntry.argv);
      assert.equal(wrappedEntry.tree_status, 0);
      assert.equal(wrappedEntry.tree_stderr, "");
      const ancestors = JSON.parse(wrappedEntry.tree_stdout);
      assert.equal(ancestors[0].pid, wrapped.pid);
      assert(!ancestors.some((p: any) => /powershell|pwsh/iu.test(p.name)));
    }
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
  const archive = "plugins/trajecta-example/g1/trajecta.plugin";
  assert.equal(data.entries[archive].scope, "shared");
  assert(!Object.keys(data.entries).includes(out));
  fs.writeFileSync(join(root, archive), "owner-edited");
  const protectedTree = tree(root);
  result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /was modified/);
  assert.equal(fs.readFileSync(join(root, archive), "utf8"), "owner-edited");
  assert.deepEqual(tree(root), protectedTree);
  const before = tree(folder);
  result = run(["--name", "x".repeat(60)]);
  assert.equal(result.status, 1);
  assert.deepEqual(tree(folder), before);
});
test("a symlinked plugin root is rejected before interpreting an external ownership ledger", () => {
  const folder = temporary(),
    outside = temporary(),
    root = join(folder, "alias");
  fs.writeFileSync(join(outside, "owned.json"), "foreign non-JSON marker");
  fs.symlinkSync(outside, root, process.platform === "win32" ? "junction" : "dir");
  const before = tree(outside),
    r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", CLI, "plugin", "--root", root, "--profile", "example"],
      { env: isolatedEnv(folder), encoding: "utf8" },
    );
  assert.equal(r.status, 1);
  assert.equal(
    r.stderr,
    `trajecta: plugin directory ${root} is not a product-owned real directory; nothing was written\n`,
  );
  assert.deepEqual(tree(outside), before);
});

test("K4 concurrent actual MCP entries observe independent same-key home defaults", async () => {
  const { spawn } = await import("node:child_process");
  const f = signedFixture(testKey()),
    root = join(f.root, "install");
  const setup = spawnSync(
    process.execPath,
    [CLI, "install", "--root", root, "--release", f.release, "--db", join(f.root, "store.sqlite3"), "--no-user-bin"],
    { env: f.env, encoding: "utf8" },
  );
  assert.equal(setup.status, 0, setup.stderr);
  const runs = await Promise.all(
    ["a", "b"].map(async (profile) => {
      fs.mkdirSync(join(f.env.TRAJECTA_IDENTITY_PROFILES, profile), { recursive: true });
      fs.copyFileSync(
        join(ROOT, "engines/trajecta_identity/profiles/example/profile.json"),
        join(f.env.TRAJECTA_IDENTITY_PROFILES, profile, "profile.json"),
      );
      const servers = JSON.parse(
        (await pluginFiles({ root, profile, dataDir: "~/" + profile }))[".mcp.json"].toString(),
      ).mcpServers;
      const entry = servers["trajecta-identity-" + profile];
      const receipt = join(f.root, profile + ".json"),
        env = {
          ...f.env,
          NODE_NO_WARNINGS: "1",
          NODE_OPTIONS: `--import=${new URL("./mcp-env-observer.ts", import.meta.url).href}`,
          TEST_RECIPE_RECEIPT: receipt,
        };
      delete env.TRAJECTA_IDENTITY_DATA_DIR;
      if (process.platform === "win32") env.HOME = join(f.root, "ignored-home-sentinel");
      const child = spawn(entry.command, entry.args, { env, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [],
        err: Buffer[] = [];
      child.stdout.on("data", (part) => out.push(part));
      child.stderr.on("data", (part) => err.push(part));
      const done = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          try {
            assert.equal(code, 0, Buffer.concat(err).toString());
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
      child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
      await done;
      assert.equal(JSON.parse(Buffer.concat(out).toString()).id, 1);
      assert.equal(Buffer.concat(err).toString(), "");
      const observed = JSON.parse(fs.readFileSync(receipt, "utf8"));
      // P24/§13.2 substitute the home prefix; the remaining slash is verbatim.
      const home = process.platform === "win32" ? env.USERPROFILE : env.HOME;
      assert.equal(observed.value, home + "/" + profile);
      assert(!fs.existsSync(observed.value), "initialize cannot bootstrap the default path");
      return observed;
    }),
  );
  assert.notEqual(runs[0].pid, runs[1].pid);
  assert.notEqual(runs[0].value, runs[1].value);
});
