import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { join } from "node:path";
import test from "node:test";
import { enginePath } from "../product/src/engines.ts";
import { CLI, temporary, isolatedEnv } from "./support.ts";
import { view, port, flags } from "./view-signal-support.ts";
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
