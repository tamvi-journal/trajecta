import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pluginFiles, pluginZip, serverSlug, writePlugin, PluginInputError } from "../product/src/plugin.ts";
import { parseRecipe, applyDefaults } from "../product/src/mcp.ts";
import { ROOT, CLI, temporary, isolatedEnv, tree } from "./support.ts";

function entries(zip: Buffer) {
  const out: Record<string, { bytes: Buffer; mode: number; time: number; date: number }> = {};
  let offset = zip.readUInt32LE(zip.length - 6);
  while (zip.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = zip.readUInt16LE(offset + 28),
      extra = zip.readUInt16LE(offset + 30),
      comment = zip.readUInt16LE(offset + 32);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString();
    const local = zip.readUInt32LE(offset + 42),
      size = zip.readUInt32LE(offset + 20);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    out[name] = {
      bytes: inflateRawSync(zip.subarray(start, start + size)),
      mode: zip.readUInt32LE(offset + 38) >>> 16,
      time: zip.readUInt16LE(offset + 12),
      date: zip.readUInt16LE(offset + 14),
    };
    offset += 46 + nameLength + extra + comment;
  }
  return out;
}

test("K1/K3/K6: plugin carries only metadata and pinned skill; deterministic modes, time, version and dual recipes", async () => {
  const input = { root: "/isolated/install", profile: "hồ-sơ", house: "~/nhà", workRoot: "~/work" };
  const files = await pluginFiles(input, "posix");
  assert.deepEqual(Object.keys(files).sort(), [
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "skills/identity-continuity/SKILL.md",
  ]);
  assert.deepEqual(
    files["skills/identity-continuity/SKILL.md"],
    fs.readFileSync(join(ROOT, "product/assets/identity-continuity/SKILL.md")),
  );
  // git show identity@98313ac:skills/identity-continuity/SKILL.md; never an installed plugin.
  assert.equal(
    createHash("sha256").update(files["skills/identity-continuity/SKILL.md"]).digest("hex"),
    "1e860b5c03e2fafad512c8d8fa2862c02d74ed85a61a4c4584548f453d173db2",
  );
  const metadata = JSON.parse(files[".claude-plugin/plugin.json"].toString());
  assert.equal(metadata.version, JSON.parse(fs.readFileSync(join(ROOT, "product/package.json"), "utf8")).version);
  const mcp = JSON.parse(files[".mcp.json"].toString()).mcpServers;
  const labels = Object.keys(mcp);
  assert.equal(labels.length, 2);
  for (const label of labels) assert.match(label, /^[A-Za-z0-9._-]{1,64}$/);
  assert.deepEqual(mcp[labels[0]].args, [
    "/isolated/install/bin/trajecta-mcp",
    labels[0],
    "--engine",
    "identity",
    "--default",
    "TRAJECTA_IDENTITY_DATA_DIR",
    "~/nhà/house-data/identity",
    "--default",
    "TRAJECTA_IDENTITY_PROFILES",
    "~/nhà/private-profiles",
    "--default",
    "TRAJECTA_WORK_ROOT",
    "~/work",
    "--",
    "--profile",
    "hồ-sơ",
  ]);
  assert.deepEqual(mcp[labels[1]].args.slice(-4), ["--default", "TRAJECTA_HOME", "~/work", "--"]);
  const a = pluginZip(files),
    b = pluginZip(files);
  assert.deepEqual(a, b);
  const parsed = entries(a);
  assert.deepEqual(Object.keys(parsed), Object.keys(files).sort());
  for (const [name, entry] of Object.entries(parsed)) {
    assert.deepEqual(entry.bytes, files[name]);
    assert.equal(entry.mode, 0o100644);
    assert.equal(entry.time, 0);
    assert.equal(entry.date, 33);
  }
  const windows = JSON.parse(
    (await pluginFiles({ root: "C:\\isolated", profile: "example" }, "windows"))[".mcp.json"].toString(),
  ).mcpServers;
  assert.equal(windows["trajecta-identity-example"].command, "cmd.exe");
  assert.deepEqual(windows["trajecta-identity-example"].args.slice(0, 3), [
    "/d",
    "/c",
    "C:\\isolated\\bin\\trajecta-mcp.cmd",
  ]);
});

test("labels: Unicode, overlong ASCII and colliding transliterations retain deterministic distinct hashes", async () => {
  assert.equal(serverSlug("example"), "example");
  assert.match(serverSlug("a".repeat(48)), /^a{37}-[0-9a-f]{8}$/);
  assert.notEqual(serverSlug("hồ-sơ"), serverSlug("hố-sơ"));
  assert.match(serverSlug("Đặng"), /^dang-[0-9a-f]{8}$/);
  await assert.rejects(pluginFiles({ root: "/x", profile: "example", name: "a".repeat(60) }), PluginInputError);
});

test("Windows K4 safety refuses every forbidden argument/default before writing", async () => {
  for (const char of [...'%!^&|<>"()', "\n", "\r", "\0", "\u007f", "\\"]) {
    await assert.rejects(
      pluginFiles({ root: "C:\\x", profile: "p" + char }, "windows"),
      (e) => e instanceof PluginInputError && /profile/.test(e.message),
    );
    await assert.rejects(
      pluginFiles({ root: "C:\\x", profile: "p", dataDir: "x" + char }, "windows"),
      (e) => e instanceof PluginInputError && /TRAJECTA_IDENTITY_DATA_DIR/.test(e.message),
    );
  }
});

test("K2: EXDEV and partial writes rethrow original error, preserve old output, and leave no temp", async () => {
  const folder = temporary(),
    out = join(folder, "test.plugin"),
    sentinel = Buffer.from("existing good archive");
  const files = await pluginFiles({ root: folder, profile: "example" });
  for (const existing of [false, true])
    for (const point of ["write", "rename"]) {
      if (existing) fs.writeFileSync(out, sentinel);
      else fs.rmSync(out, { force: true });
      const original = Object.assign(new Error("injected failure"), { code: point === "rename" ? "EXDEV" : "EIO" });
      const hook = registerHooks({
        load(url, context, next) {
          if (!new URL(url).pathname.endsWith("/product/src/plugin.ts")) return next(url, context);
          const loaded = next(url, context);
          const originalSource =
            typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source!).toString();
          const source = originalSource.replace(
            point === "write" ? "fs.writeFileSync(fd, bytes);" : "fs.renameSync(tmp, out);",
            point === "write"
              ? "fs.writeFileSync(fd, bytes.subarray(0, 7)); throw globalThis.__pluginFailure;"
              : "throw globalThis.__pluginFailure;",
          );
          assert.notEqual(source, originalSource);
          return { ...loaded, source };
        },
      });
      (globalThis as any).__pluginFailure = original;
      try {
        const fresh = await import(
          new URL(`../product/src/plugin.ts?failure=${existing}-${point}`, import.meta.url).href
        );
        assert.throws(
          () => fresh.writePlugin(out, files),
          (error) => error === original,
        );
        assert.deepEqual(fs.readdirSync(folder), existing ? ["test.plugin"] : []);
        if (existing) assert.deepEqual(fs.readFileSync(out), sentinel);
      } finally {
        hook.deregister();
        delete (globalThis as any).__pluginFailure;
      }
    }
  writePlugin(out, files);
  assert.deepEqual(fs.readFileSync(out), pluginZip(files));
});

test("MCP grammar refuses unknown/duplicate defaults and missing separator; defaults are independent and absent-only", () => {
  for (const argv of [
    ["server", "--engine", "identity"],
    ["server", "--engine", "no", "--"],
    ["server", "--engine", "work", "--default", "PATH", "x", "--"],
    ["server", "--engine", "work", "--default", "TRAJECTA_HOME", "x", "--default", "TRAJECTA_HOME", "y", "--"],
  ])
    assert.throws(() => parseRecipe(argv));
  const keys = ["TRAJECTA_IDENTITY_DATA_DIR", "TRAJECTA_IDENTITY_PROFILES", "TRAJECTA_WORK_ROOT", "TRAJECTA_HOME"];
  const recipe = parseRecipe(["server", "--engine", "work", ...keys.flatMap((k) => ["--default", k, "~/" + k]), "--"]);
  for (const preset of keys) {
    const env: Record<string, string | undefined> = { [preset]: "$HOME/preset~" };
    applyDefaults(recipe, env, () => "/home/example");
    for (const key of keys) assert.equal(env[key], key === preset ? "$HOME/preset~" : "/home/example/" + key);
  }
  const empty = { TRAJECTA_HOME: "" };
  applyDefaults(recipe, empty, () => "/h");
  assert.equal(empty.TRAJECTA_HOME, "/h/TRAJECTA_HOME");
  assert.throws(
    () => applyDefaults(recipe, {}, () => ""),
    /server: cannot resolve home folder for TRAJECTA_IDENTITY_DATA_DIR/,
  );
  const literal = parseRecipe(["s", "--engine", "work", "--default", "TRAJECTA_HOME", "~user/$HOME/x", "--"]);
  const env = {};
  applyDefaults(literal, env, () => "");
  assert.equal((env as any).TRAJECTA_HOME, "~user/$HOME/x");
});

test("MCP recipe usage errors exit 2 before touching any store", () => {
  const folder = temporary(),
    env = isolatedEnv(folder),
    before = tree(folder);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "mcp", "server", "--engine", "work"], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /missing --/);
  assert.deepEqual(tree(folder), before);
});
