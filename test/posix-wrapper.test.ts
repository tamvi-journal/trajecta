import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import * as subject from "../product/src/wrappers.ts";
import { temporary, isolatedEnv, tree } from "./support.ts";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const resume =
  "trajecta is being uninstalled; resume with the command printed by 'trajecta uninstall', " +
  "or run the installer bootstrap with --resume-uninstall\n";

function fixture(name = "install") {
  const parent = temporary(),
    root = join(parent, name),
    bin = join(root, "bin"),
    ver = join(root, "0.5.0");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(join(ver, "product/src"), { recursive: true });
  fs.writeFileSync(join(ver, "product/package.json"), '{"type":"module"}\n');
  fs.writeFileSync(
    join(ver, "product/src/cli.ts"),
    "console.log(JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));\n",
  );
  const node = join(parent, "recorded-node");
  fs.writeFileSync(
    node,
    '#!/bin/sh\nif [ "$1" = --version ]; then printf "v22.23.1\\n"; exit 0; fi\nexec ' +
      quote(process.execPath) +
      ' "$@"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(join(ver, "node"), node + "\n");
  fs.writeFileSync(join(root, "current"), "0.5.0\n\n");
  return { parent, root, bin, ver, node, env: isolatedEnv(parent) };
}

test("POSIX wrappers validate bytes before execution, insert mcp and exec without a parent", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX native wrapper");
  assert.equal(typeof (subject as any).posixWrapper, "function", "POSIX renderer is not implemented");
  const f = fixture();
  for (const mcp of [false, true]) {
    const file = join(f.bin, mcp ? "trajecta-mcp" : "trajecta");
    fs.writeFileSync(file, (subject as any).posixWrapper(f.root, mcp), { mode: 0o755 });
    const args = ["label", "--engine", "identity", "--", "special ' \" $ ! ` &", "two\nlines"];
    const child = spawn(file, args, { cwd: f.parent, env: { ...f.env, PATH: "" } });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, 0, err);
    const result = JSON.parse(out);
    assert.equal(result.pid, child.pid);
    assert.deepEqual(result.args, mcp ? ["mcp", ...args] : args);
  }
});

test("POSIX current metadata precedes sentinel; malformed byte/path rows never run Node", (t) => {
  if (process.platform === "win32") return t.skip("POSIX native wrapper");
  assert.equal(typeof (subject as any).posixWrapper, "function", "POSIX renderer is not implemented");
  const f = fixture(),
    launcher = join(f.bin, "trajecta");
  fs.writeFileSync(launcher, (subject as any).posixWrapper(f.root, false), { mode: 0o755 });
  const run = (args: string[] = []) => spawnSync(launcher, args, { cwd: f.parent, env: f.env, encoding: "utf8" });
  const damaged = `trajecta: installation at ${f.root} is damaged; run the installer\n`;
  const current = join(f.root, "current");
  for (const bytes of [
    "",
    "0.5.0\n",
    "0.5.0\n\n\n",
    "0.5.0\r\n\r\n",
    "../x\n\n",
    "/absolute\n\n",
    "C:\\drive\n\n",
    "0.5.0\0\n\n",
    "uninstalling\n" + "x".repeat(256),
  ]) {
    fs.writeFileSync(current, bytes);
    const before = tree(f.parent),
      result = run();
    assert.equal(result.status, 1, bytes);
    assert.equal(result.stderr, damaged);
    assert.equal(result.stdout, "");
    assert.deepEqual(tree(f.parent), before);
  }
  fs.writeFileSync(current, "uninstalling\n");
  let result = run(["uninstall", "--status"]);
  assert.equal(result.status, 3);
  assert.equal(result.stdout, `trajecta: uninstall in progress at ${f.root}\n` + resume);
  assert.equal(run(["uninstall", "--resume"]).stderr, resume);
  const sentinel = join(f.parent, "sentinel");
  fs.writeFileSync(sentinel, "uninstalling\n");
  fs.unlinkSync(current);
  fs.symlinkSync(sentinel, current);
  result = run(["uninstall", "--status"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, damaged);
  fs.unlinkSync(current);
  fs.writeFileSync(current, "0.5.0\n\n");
  for (const ending of ["\r", "\0", "\r\n", "", "\n\n"]) {
    fs.writeFileSync(join(f.ver, "node"), f.node + ending);
    assert.equal(run().stderr, damaged);
  }
  fs.writeFileSync(join(f.ver, "node"), f.node + "\n");
  fs.unlinkSync(f.node);
  assert.equal(run().stderr, "trajecta: need Node 22.19+ or 24 LTS\n");
  fs.writeFileSync(current, "uninstalling\n");
  assert.equal(run(["uninstall", "--status"]).status, 3);
});

test("fixed external stub is literal for injection roots, executable, and refuses after root removal", (t) => {
  if (process.platform === "win32") return t.skip("POSIX stub only");
  assert.equal(typeof (subject as any).userStub, "function", "stub renderer is not implemented");
  const f = fixture("space ' \" $ $(touch CANARY) `touch BOOM`");
  const rootLauncher = join(f.bin, "trajecta"),
    stub = join(f.parent, "trajecta");
  fs.writeFileSync(rootLauncher, (subject as any).posixWrapper(f.root, false), { mode: 0o755 });
  fs.writeFileSync(stub, (subject as any).userStub(f.root), { mode: 0o755 });
  let result = spawnSync(stub, ["literal", "$(touch BAD)", "!"], { cwd: f.parent, env: f.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args, ["literal", "$(touch BAD)", "!"]);
  fs.unlinkSync(rootLauncher);
  result = spawnSync(stub, [], { cwd: f.parent, env: f.env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, `trajecta: not installed at ${f.root}; run the installer, or remove ${stub}\n`);
  for (const marker of ["CANARY", "BOOM", "BAD"]) assert(!fs.existsSync(join(f.parent, marker)));
  assert.equal(fs.statSync(stub).mode & 0o777, 0o755);
});
