import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { enginePath } from "../product/src/engines.ts";
import { CLI, ROOT, temporary, isolatedEnv, tree } from "./support.ts";
const flags = ["--experimental-strip-types"];
function receiptFixture(root: string): string[] {
  const corpus = join(ROOT, ".isolation/upstream/identity/spec/golden-cli-v1/authority-retract-issue-only");
  fs.cpSync(join(corpus, "fixture"), root, { recursive: true });
  return JSON.parse(fs.readFileSync(join(corpus, "argv.json"), "utf8"));
}
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
async function pty(
  root: string,
  env: Record<string, string>,
  args: string[],
  input: Buffer,
  marker: string,
  completed: string,
) {
  const command = [process.execPath, ...flags, ...args].map(quote).join(" ");
  const script =
    process.platform === "darwin"
      ? ["-q", "/dev/null", "/bin/sh", "-c", command]
      : ["-q", "-e", "-c", command, "/dev/null"];
  const child = spawn("/bin/sh", ["-c", "cat | script " + script.map(quote).join(" ")], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let sent = false;
  let ended = false;
  let timedOut = false;
  child.stdout.on("data", (bytes) => {
    stdout.push(Buffer.from(bytes));
    const output = Buffer.concat(stdout);
    if (!sent && output.includes(Buffer.from(marker))) {
      sent = true;
      child.stdin.write(input);
    }
    if (sent && !ended && output.includes(Buffer.from(completed))) {
      // BSD script injects terminal EOF when its input pipe closes. Keep that
      // EOF after the observed result, never racing the confirmation bytes.
      ended = true;
      child.stdin.end();
    }
  });
  child.stderr.on("data", (bytes) => stderr.push(Buffer.from(bytes)));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 15000);
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once("close", done);
      child.once("error", reject);
    });
    assert(!timedOut, "PTY exited without forced cleanup");
    assert(sent, "PTY confirmation boundary reached");
    assert(ended, "PTY result observed before closing input");
    return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  } finally {
    clearTimeout(timer);
  }
}
test("pass-through argv/cwd/env/stdin and three pipe streams/exit exactly preserved", () => {
  const root = temporary(),
    env = isolatedEnv(root);
  env.NODE_OPTIONS = "--import=" + pathToFileURL(join(ROOT, "test/transport-probe.ts")).href;
  env.TEST_TRANSPORT_PROBE = "metadata";
  env.TEST_EXIT_CODE = "7";
  env.TEST_EXACT_VALUE = '  Unicode 💠 $HOME ~/ -- " untouched  ';
  const argv = ["-p", "a b", "--", "-x", "💠"],
    input = Buffer.from([0, 255, 10, 13]);
  const run = (args: string[]) => spawnSync(process.execPath, [...flags, ...args], { cwd: root, env, input });
  const a = run([enginePath("identity"), ...argv]),
    b = run([CLI, "identity", ...argv]);
  assert.equal(a.status, 7);
  assert.equal(b.status, 7);
  assert.deepEqual(b.stdout, a.stdout);
  assert.deepEqual(b.stderr, a.stderr);
  const proof = JSON.parse(b.stdout.toString());
  assert.deepEqual(proof.argv, argv);
  assert.equal(proof.cwd, root);
  assert.deepEqual(proof.tty, [false, false, false]);
  assert.equal(proof.env.TEST_EXACT_VALUE, env.TEST_EXACT_VALUE);
  assert.equal(proof.stdin, input.toString("hex"));
});
test("actual authority non-TTY refusal remains byte-exact and store unchanged", () => {
  const root = temporary(),
    argv = receiptFixture(root),
    env = isolatedEnv(root),
    before = tree(root);
  const run = (args: string[]) => spawnSync(process.execPath, [...flags, ...args], { cwd: root, env, input: "" });
  const a = run([enginePath("identity"), ...argv]),
    b = run([CLI, "identity", ...argv]);
  assert.equal(a.status, 1);
  assert.equal(b.status, 1);
  assert.deepEqual(b.stdout, a.stdout);
  assert.deepEqual(b.stderr, a.stderr);
  assert.equal(
    a.stderr.toString(),
    "HumanPresenceRequired: receipt issuance requires interactive TTY stdin and stdout\n",
  );
  // CLI's frozen .last-profile write occurs before the refusal; no history mutation is allowed.
  for (const [path, digest] of Object.entries(before))
    if (path.endsWith(".sqlite3")) assert.equal(tree(root)[path], digest);
});
test("real script(1) PTY: accepted and mistyped authority confirmations", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows interactive confirmation belongs to owner M8");
    return;
  }
  for (const product of [false, true])
    for (const accepted of [true, false]) {
      const root = temporary(),
        argv = receiptFixture(root),
        env = isolatedEnv(root);
      const corpus = join(ROOT, ".isolation/upstream/identity/spec/golden-cli-v1/authority-retract-issue-only");
      const input = accepted ? fs.readFileSync(join(corpus, "stdin")) : Buffer.from("MISTYPED\n");
      const args = product ? [CLI, "identity", ...argv] : [enginePath("identity"), ...argv];
      const result = await pty(
        root,
        env,
        args,
        input,
        "to issue the owner receipt: ",
        accepted ? '"receipt_id": "receipt:' : "ConfirmationMismatch:",
      );
      if (accepted) assert.match(result.stdout.toString(), /"receipt_id": "receipt:/u);
      else assert.match(result.stdout.toString(), /ConfirmationMismatch:/u);
      if (process.platform === "linux") assert.equal(result.code, accepted ? 0 : 1);
    }
});
test("real script(1) PTY: isatty preserved and Ctrl-C reaches the engine", async (t) => {
  if (process.platform === "win32") {
    t.skip("script(1) is POSIX; pipe and native-exit gates cover Windows");
    return;
  }
  for (const product of [false, true]) {
    const root = temporary(),
      env = isolatedEnv(root);
    env.NODE_OPTIONS = "--import=" + pathToFileURL(join(ROOT, "test/transport-probe.ts")).href;
    env.TEST_TRANSPORT_PROBE = "metadata";
    const args = product ? [CLI, "identity"] : [enginePath("identity")];
    const result = await pty(root, env, args, Buffer.from([4]), '"tty":', '"tty":'); // Real PTY, no TTY seam.
    assert.match(result.stdout.toString(), /"tty":\[true,true,true\]/u);
    env.TEST_TRANSPORT_PROBE = "signal";
    const interrupted = await pty(root, env, args, Buffer.from([3]), "probe ready", "probe SIGINT");
    assert.match(interrupted.stdout.toString(), /probe SIGINT/u);
    if (process.platform === "linux") assert.equal(interrupted.code, 130);
  }
});
test("PID-directed signal and terminating signal retain the direct engine outcome", async () => {
  const root = temporary(),
    env = isolatedEnv(root);
  env.NODE_OPTIONS = "--import=" + pathToFileURL(join(ROOT, "test/transport-probe.ts")).href;
  // Windows kill(SIGTERM) uses TerminateProcess, not a dispatchable signal.
  // Hosted Windows tests prove native engine termination below; console Ctrl-C is M8.
  if (process.platform !== "win32") {
    env.TEST_TRANSPORT_PROBE = "signal";
    const child = spawn(process.execPath, [...flags, CLI, "identity"], { cwd: root, env });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (bytes) => stderr.push(Buffer.from(bytes)));
    await new Promise<void>((done) => child.stdout.once("data", () => done()));
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((done) => child.once("close", done));
    assert.equal(code, 143);
    assert.equal(Buffer.concat(stderr).toString(), "probe SIGTERM\n");
  }
  env.TEST_TRANSPORT_PROBE = "self-signal";
  const run = (args: string[]) => spawnSync(process.execPath, [...flags, ...args], { cwd: root, env });
  const a = run([enginePath("identity")]),
    b = run([CLI, "identity"]);
  assert.equal(b.status, a.status);
  assert.equal(b.signal, a.signal);
  if (process.platform !== "win32") assert.equal(b.signal, "SIGTERM");
  else assert.notEqual(b.status, 0);
});
