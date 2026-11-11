// The terminal hosted Windows job calls this before and after applying its EXE policy.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { windowsWrapper } from "../product/src/wrappers.ts";
import { ROOT, contained, isolatedEnv, temporary, tree } from "./support.ts";
import { powershell, raw, receipt, systemPath, text } from "./native-m5-support.ts";
import { prewarmWindowsHost } from "./windows-host-a.ts";

assert.equal(process.platform, "win32");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.env.GITHUB_REPOSITORY, "tamvi-journal/trajecta");
const major = process.versions.node.split(".")[0];
const [phase, config] = process.argv.slice(2);
contained(config);

function setup() {
  const home = temporary();
  const root = join(home, "install");
  const version = join(root, "0.5.0");
  const marker = join(temporary(), "node-starts.jsonl");
  const env = {
    ...isolatedEnv(home),
    NODE_OPTIONS: "--import=" + pathToFileURL(join(ROOT, "test/windows-m5-node-start.mjs")).href,
    TEST_M5_NODE_START: marker,
  };
  fs.mkdirSync(join(root, "bin"), { recursive: true });
  fs.mkdirSync(join(version, "product/src"), { recursive: true });
  fs.writeFileSync(join(root, "current"), "0.5.0\n\n");
  fs.writeFileSync(join(version, "node"), process.execPath + "\n");
  fs.writeFileSync(join(version, "product/package.json"), '{"type":"module"}\n');
  fs.writeFileSync(join(version, "product/src/cli.ts"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const host = powershell();
  const wrappers = [false, true].map((mcp) => {
    const file = join(root, "bin", mcp ? "trajecta-mcp.cmd" : "trajecta.cmd");
    fs.writeFileSync(file, windowsWrapper(root, host, mcp));
    return { mcp, file, args: mcp ? ["m5-server", "--engine", "identity", "--", "--profile", "example"] : ["version"] };
  });
  prewarmWindowsHost(host, env);
  fs.writeFileSync(config, JSON.stringify({ home, host, marker, env, wrappers }));
}

if (phase === "prepare") {
  setup();
} else {
  assert.equal(phase, "blocked");
  const { home, host, marker, env, wrappers } = JSON.parse(fs.readFileSync(config, "utf8"));
  contained(home);
  contained(marker);
  assert.equal(host, powershell());
  const before = tree(home);
  const rows = [];
  try {
    for (const { mcp, file, args } of wrappers) {
      const result = raw(systemPath("System32/cmd.exe"), ["/d", "/q", "/c", file, ...args], env);
      const after = tree(home);
      const nodeStarts = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
      rows.push({ mcp, file, args, result, node_starts: nodeStarts, tree_after: after });
      assert.equal(result.error, null, JSON.stringify(result));
      assert.equal(result.status, 1, JSON.stringify(result));
      assert.equal(result.stdout_hex, "");
      assert.equal(
        text(result, "stderr"),
        (mcp ? "m5-server" : "trajecta") +
          ": cannot validate the installation (Windows PowerShell unavailable or blocked)\r\n",
      );
      assert(!fs.existsSync(marker), "no Node process may start when the pinned host is blocked");
      assert.deepEqual(after, before);
    }
  } finally {
    receipt("applocker-wrapper-node" + major, { host, tree_before: before, rows });
  }
}
