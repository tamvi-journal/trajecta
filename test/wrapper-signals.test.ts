import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI } from "./support.ts";
import { view, port } from "./view-signal-support.ts";
test("M5 real view through installed bin has exact direct transcript, status and one engine PID for every POSIX signal topology", async (t) => {
  if (process.platform === "win32")
    return t.skip("real POSIX script(1) gate; Windows console evidence has its own native gate");
  const f = signedFixture(testKey()),
    root = join(f.root, "install"),
    env = { ...f.env, NODE_NO_WARNINGS: "1" };
  const installed = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, "install", "--root", root, "--release", f.release, "--no-user-bin"],
    { env, encoding: "utf8" },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const entry = join(root, "0.5.0/engines/identity/src/cli.ts");
  for (const kind of ["ctrl-c", "tty-pid", "tty-group", "pipe-int", "pipe-term"] as const) {
    const bound = await port(),
      direct = await view(false, bound, kind, { entry, env }),
      wrapped = await view(true, bound, kind, { entry, env, wrapper: join(root, "bin/trajecta") });
    assert.equal(wrapped.observedEntry, entry, "the real installed engine must be observed, not a repo-only probe");
    assert.deepEqual(wrapped, direct);
    if (["ctrl-c", "tty-pid", "pipe-int"].includes(kind)) assert.equal(wrapped.code, 0);
    else assert.equal(wrapped.signal, "SIGTERM");
  }
});
