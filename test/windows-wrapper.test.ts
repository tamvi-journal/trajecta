import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ROOT, temporary, isolatedEnv } from "./support.ts";

const path = new URL("../product/src/wrappers.ts", import.meta.url);
const subject = fs.existsSync(path) ? await import(path.href) : null;
const systemPS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

test("Windows encoded validator fits the 240-character non-ASCII root without truncation", () => {
  assert(subject, "native wrapper renderer is not implemented");
  const root = "C:\\" + "界".repeat(237);
  assert.equal(root.length, 240);
  const wrapper = subject.windowsWrapper(root, systemPS, false);
  const line = wrapper.split(/\r?\n/u).find((line: string) => line.includes("-EncodedCommand"));
  assert(line);
  assert(line.length <= 8000, `encoded invocation is ${line.length} characters`);
  const source = Buffer.from(line.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)![1], "base64").toString("utf16le");
  assert.equal(source.split(root).length - 1, 1, "root appears once in the embedded script");
  assert(wrapper.includes('set "TRAJECTA_WRAPPER_DIR=%~dp0"'));
  assert(!wrapper.includes("%SystemRoot%"));
  assert(!wrapper.includes("%PATH%"));
  assert.throws(() => subject.windowsWrapper("C:\\" + "界".repeat(4000), systemPS, false), /8000/u);
});

test("Windows wrapper rejects current reparse before sentinel, preserves LF byte grammar and inserts mcp", (t) => {
  if (process.platform !== "win32") return t.skip("real Windows native contract job");
  assert(subject, "native wrapper renderer is not implemented");
  const root = temporary(), bin = join(root, "bin"), version = join(root, "0.5.0");
  fs.mkdirSync(bin);
  fs.mkdirSync(version);
  fs.writeFileSync(join(root, "current"), "0.5.0\n\n");
  fs.writeFileSync(join(version, "node"), process.execPath + "\n");
  fs.mkdirSync(join(version, "product/src"), { recursive: true });
  fs.writeFileSync(join(version, "product/package.json"), '{"type":"module"}\n');
  fs.writeFileSync(join(version, "product/src/cli.ts"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const ps = win32.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  for (const mcp of [false, true]) {
    const file = join(bin, mcp ? "trajecta-mcp.cmd" : "trajecta.cmd");
    fs.writeFileSync(file, subject.windowsWrapper(root, ps, mcp));
    const args = mcp ? ["label", "--engine", "identity", "--", "--profile", "example"] : ["version"];
    const run = () => spawnSync("cmd.exe", ["/d", "/q", "/c", file, ...args], {
      cwd: root, env: isolatedEnv(root), encoding: "utf8", timeout: 20000,
    });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), mcp ? ["mcp", ...args] : args);
    for (const end of ["\r", "\0", "\r\n", ""]) {
      fs.writeFileSync(join(version, "node"), process.execPath + end);
      result = run();
      assert.equal(result.status, 1, JSON.stringify(result));
      assert.equal(result.stderr, `${mcp ? "label" : "trajecta"}: installation at ${root} is damaged; run the installer\r\n`);
      assert.equal(result.stdout, "");
    }
    fs.writeFileSync(join(version, "node"), process.execPath + "\n");
    fs.writeFileSync(join(root, "sentinel"), "uninstalling\n");
    fs.unlinkSync(join(root, "current"));
    fs.symlinkSync(join(root, "sentinel"), join(root, "current"), "file");
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is damaged/u);
    fs.unlinkSync(join(root, "current"));
    fs.writeFileSync(join(root, "current"), "0.5.0\n\n");
  }
});
