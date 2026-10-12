/** Identical test-only preloads at the real engine entry for direct and in-process routes. */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { identityApi } from "../product/src/engines.ts";
import { beforeIdentity } from "./entry-hook.ts";
if (!import.meta.url.endsWith("?entry")) beforeIdentity(new URL("./identity-seam.ts?entry", import.meta.url));
if (import.meta.url.endsWith("?entry")) {
  const { InjectedClock, WallClock, IdentityMemory, RuntimeError, StaleAuthority } = await identityApi();
  const invocation = JSON.parse(fs.readFileSync(process.env.TEST_IDENTITY_INVOCATION!, "utf8"));
  const clock = new InjectedClock();
  WallClock.prototype.seconds = () => clock.seconds();
  WallClock.prototype.micros = () => clock.micros();
  const decay = IdentityMemory.prototype.decay;
  IdentityMemory.prototype.decay = function (at) {
    return decay.call(this, at ?? clock.micros());
  };
  if (invocation.tty) {
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
  }
  if (invocation.hook === "inline-failure") {
    const fail = () => {
      throw new StaleAuthority("target moved after issuance");
    };
    IdentityMemory.prototype.coreApply = fail;
    IdentityMemory.prototype.retract = fail;
    IdentityMemory.prototype.closeLegacyDiscussion = fail;
  }
  if (invocation.hook === "untyped-crash")
    IdentityMemory.prototype.status = () => {
      throw new RuntimeError("test internal crash");
    };
  if (invocation.hook === "p26-concurrent-parent") {
    const original = fs.mkdirSync,
      parent = resolve("external");
    let fired = false;
    fs.mkdirSync = ((path: any, ...args: any[]) => {
      if (path === parent && !fired) {
        fired = true;
        const child = spawnSync(process.execPath, ["-e", "require('node:fs').mkdirSync(process.argv[1])", parent]);
        if (child.status !== 0) throw new Error(child.stderr.toString());
      }
      return (original as any)(path, ...args);
    }) as any;
    syncBuiltinESMExports();
  }
}
