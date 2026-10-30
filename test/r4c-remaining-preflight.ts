/** Opt-in S4/S5 characterization, not a passing M5 gate or a proposed semantic fix. */
import * as fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { posixWrapper, windowsWrapper } from "../product/src/wrappers.ts";
import { pluginFiles } from "../product/src/plugin.ts";
import { testKey, signedFixture } from "./install-fixture.ts";
import { CLI } from "./support.ts";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
console.log(
  "root-bound wrappers",
  JSON.stringify({
    posixA: digest(posixWrapper("/isolated/A", false)),
    posixB: digest(posixWrapper("/isolated/B", false)),
    windowsA: digest(windowsWrapper("C:\\A", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", false)),
    windowsB: digest(windowsWrapper("C:\\B", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", false)),
  }),
);
const f = signedFixture(testKey()),
  root = join(f.root, "install"),
  db = join(f.root, "identity", "custom.sqlite3"),
  env = { ...f.env, NODE_NO_WARNINGS: "1" };
const r = spawnSync(
  process.execPath,
  [
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
    db,
    "--no-user-bin",
  ],
  { env, encoding: "utf8" },
);
if (r.status !== 0) throw Error(r.stderr);
const servers = JSON.parse((await pluginFiles({ root, profile: "example" }))[".mcp.json"].toString()).mcpServers;
const recipe = servers["trajecta-identity-example"];
const input = Buffer.from(
  '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"identity_status","arguments":{}}}\n',
);
const status = spawnSync(recipe.command, recipe.args, { env, input, encoding: "utf8", timeout: 15000 });
console.log("bootstrap_file_exists", fs.existsSync(db));
console.log("plugin_identity_status", status.stdout.trim());
