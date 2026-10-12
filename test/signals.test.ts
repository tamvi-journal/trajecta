import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { join } from "node:path";
import test from "node:test";
import { enginePath } from "../product/src/engines.ts";
import { CLI, temporary, isolatedEnv } from "./support.ts";
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const flags = ["--experimental-strip-types"];
async function port(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const value = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return value;
}
async function view(
  product: boolean,
  bound: number,
  kind: "ctrl-c" | "tty-pid" | "tty-group" | "pipe-int" | "pipe-term",
) {
  const root = temporary(),
    env = isolatedEnv(root),
    pidFile = join(root, "pid.json");
  env.NODE_OPTIONS = "--import=" + new URL("./view-observe.ts", import.meta.url).href;
  env.TEST_PID_FILE = pidFile;
  env.TEST_PRODUCT_ROUTE = product ? "1" : "0";
  env.TEST_BIND_PORT = String(bound);
  // Fresh isolated default profile; no clock is consulted for the printed view transcript.
  delete env.TRAJECTA_IDENTITY_PROFILES;
  const args = [
    ...flags,
    ...(product ? [CLI, "identity"] : [enginePath("identity")]),
    "view",
    "--no-browser",
    "--port",
    "0",
  ];
  const tty = kind.startsWith("tty") || kind === "ctrl-c";
  const statusFile = join(root, "exit");
  const config = join(root, "pty.json"),
    observedPid = join(root, "launched-pid");
  fs.writeFileSync(config, JSON.stringify({ args, pidFile: observedPid, statusFile }));
  const wrapped =
    "exec " +
    [process.execPath, ...flags, new URL("./pty-observer.ts", import.meta.url).pathname, config].map(quote).join(" ");
  const script =
    process.platform === "darwin"
      ? ["-q", "/dev/null", "/bin/sh", "-c", wrapped]
      : ["-q", "-e", "-c", wrapped, "/dev/null"];
  const scriptDone = join(root, "script-done");
  const child = tty
    ? spawn(
        "/bin/sh",
        [
          "-c",
          "cat | (script " +
            script.map(quote).join(" ") +
            "; result=$?; printf done > " +
            quote(scriptDone) +
            '; exit "$result")',
        ],
        { cwd: root, env },
      )
    : spawn(process.execPath, args, { cwd: root, env });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let sent = false;
  let enginePid = 0;
  child.stderr.on("data", (b) => stderr.push(Buffer.from(b)));
  child.stdout.on("data", (b) => {
    stdout.push(Buffer.from(b));
    if (sent || !Buffer.concat(stdout).includes(Buffer.from("(Ctrl+C to stop)"))) return;
    const proof = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    enginePid = proof.pid;
    assert.equal(proof.tty, tty);
    assert.equal(enginePid, Number(fs.readFileSync(pidFile + ".launch", "utf8")));
    assert.equal(
      enginePid,
      tty ? Number(fs.readFileSync(observedPid, "utf8")) : child.pid,
      "real engine pid is the launched product pid",
    );
    assert.equal(proof.argv.at(-1), "0", "real CLI receives --port 0");
    sent = true;
    if (kind === "ctrl-c") child.stdin.write(Buffer.from([3]));
    else if (kind === "tty-group") {
      const pgid = Number(
        spawnSync("ps", ["-o", "pgid=", "-p", String(enginePid)], { encoding: "utf8" }).stdout.trim(),
      );
      assert.equal(
        pgid,
        Number(fs.readFileSync(observedPid + ".supervisor", "utf8")),
        "only the owned PTY process group is signalled",
      );
      process.kill(-pgid, "SIGTERM");
    } else process.kill(enginePid, kind === "pipe-term" ? "SIGTERM" : "SIGINT");
  });
  const poll = setInterval(() => {
    if (tty && sent && fs.existsSync(scriptDone)) child.stdin.end();
  }, 25);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert(sent, "real view ready before signal");
    assert.notEqual(result.signal, "SIGKILL", "no timeout cleanup");
    // The PTY supervisor records the actual engine outcome, independently of
    // BSD script's exit-code handling, and never forwards terminal/group signals.
    const outcome = tty ? JSON.parse(fs.readFileSync(statusFile, "utf8")) : result;
    return { ...outcome, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
  }
}
for (const kind of ["ctrl-c", "tty-pid", "tty-group", "pipe-int", "pipe-term"] as const) {
  test(`real identity view direct/product exact: ${kind}`, async (t) => {
    if (process.platform === "win32" && !kind.startsWith("pipe")) {
      t.skip("POSIX PTY; native PID signals and real-engine pid remain tested on Windows");
      return;
    }
    const bound = await port();
    const direct = await view(false, bound, kind),
      product = await view(true, bound, kind);
    assert.deepEqual(product, direct);
    if (process.platform !== "win32" && ["ctrl-c", "tty-pid", "pipe-int"].includes(kind)) assert.equal(product.code, 0);
    if (process.platform !== "win32" && (kind === "pipe-term" || kind === "tty-group"))
      assert.equal(product.signal, "SIGTERM");
  });
}
test("both real engine entries observe the launched product PID on every OS", async () => {
  for (const engine of ["identity", "work"] as const) {
    const root = temporary(),
      env = isolatedEnv(root),
      file = join(root, "pid.json");
    env.NODE_OPTIONS = "--import=" + new URL("./view-observe.ts", import.meta.url).href;
    env.TEST_PID_FILE = file;
    const child = spawn(process.execPath, [...flags, CLI, engine, engine === "identity" ? "--help" : "list"], {
      cwd: root,
      env,
    });
    child.stdout.resume();
    child.stderr.resume();
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    assert.equal(code, 0);
    const proof = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(proof.pid, child.pid);
    assert.equal(proof.argv[1], enginePath(engine));
  }
});
