import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import { fork, spawnSync } from "node:child_process";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { ROOT, temporary, isolatedEnv } from "./support.ts";
test("M3: 200 rounds, four contenders, exclusive dead-lock recovery and live-holder refusal", async () => {
  // Work issue #12 remains independent: https://github.com/tamvi-journal/trajecta-work-memory/issues/12
  const base = temporary(),
    env = isolatedEnv(base);
  const probe = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { env, encoding: "utf8" });
  assert.equal(probe.status, 0);
  const deadPid = Number(probe.stdout.trim());
  const children = Array.from({ length: 4 }, () =>
    fork(join(ROOT, "test/lock-contender.ts"), [], {
      cwd: ROOT,
      env,
      execArgv: ["--experimental-strip-types"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    }),
  );
  const next = (child: (typeof children)[number]) =>
    new Promise<any>((resolve, reject) => {
      const message = (value: any) => {
        cleanup();
        resolve(value);
      };
      const exit = (code: number | null, signal: string | null) => {
        cleanup();
        reject(new Error(`contender exited ${code}/${signal}`));
      };
      const cleanup = () => {
        child.off("message", message);
        child.off("exit", exit);
      };
      child.once("message", message);
      child.once("exit", exit);
    });
  try {
    assert((await Promise.all(children.map(next))).every((value) => value.result === "ready"));
    for (let round = 0; round < 200; round++) {
      const root = join(base, String(round));
      fs.mkdirSync(root);
      fs.writeFileSync(
        join(root, ".lock"),
        JSON.stringify({
          token: randomBytes(16).toString("hex"),
          pid: deadPid,
          hostname: hostname(),
          created: new Date().toISOString(),
        }),
      );
      const pending = children.map(next);
      children.forEach((child) => child.send({ action: "acquire", root }));
      const results = await Promise.all(pending),
        winners = results.map((value, index) => ({ ...value, index })).filter((value) => value.result === "held");
      assert.equal(winners.length, 1, JSON.stringify(results));
      for (const result of results.filter((value) => value.result !== "held"))
        assert.match(result.error, /lock is busy|lock changed/u);
      const winner = winners[0];
      assert.equal(JSON.parse(fs.readFileSync(join(root, ".lock"), "utf8")).token, winner.token);
      // The losers cannot unlink this holder, even when trying again after acquisition.
      const losers = children.filter((_, index) => index !== winner.index),
        refused = losers.map(next);
      losers.forEach((child) => child.send({ action: "acquire", root }));
      for (const result of await Promise.all(refused)) assert.match(result.error, /lock is busy/u);
      const released = next(children[winner.index]);
      children[winner.index].send({ action: "release" });
      assert.equal((await released).result, "released");
      assert.deepEqual(fs.readdirSync(root), []);
    }
  } finally {
    children.forEach((child) => child.kill());
  }
});
