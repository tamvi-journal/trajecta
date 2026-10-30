import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { ROOT, temporary, isolatedEnv, tree } from "./support.ts";
const checkpointUrl = new URL("../product/src/checkpoint.ts", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url !== checkpointUrl) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export function checkpoint(point) { globalThis.__lockCheckpoint?.(point); }",
    };
  },
});
const { acquire, breakLock, cleanupClaims, release, identity, owner } = await import("../product/src/install-lock.ts");
const deadProbe = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
  env: isolatedEnv(temporary()),
  encoding: "utf8",
});
assert.equal(deadProbe.status, 0);
const deadPid = Number(deadProbe.stdout.trim());
const dead = (token = "0".repeat(32), host = hostname()) =>
  Buffer.from(JSON.stringify({ token, pid: deadPid, hostname: host, created: new Date().toISOString() }));
function deadRoot() {
  const root = temporary();
  fs.writeFileSync(join(root, ".lock"), dead());
  return root;
}
test("publication is complete; ready live lock cannot be recovered or human-broken", async () => {
  const root = temporary(),
    held = acquire(root),
    before = tree(root);
  assert.equal(owner(fs.readFileSync(join(root, ".lock")))?.token, held.token);
  assert.throws(() => acquire(root), /lock is busy/u);
  await assert.rejects(
    breakLock(root, async () => true),
    /live lock/u,
  );
  assert.deepEqual(tree(root), before);
  release(root, ".lock", held);
  assert.deepEqual(tree(root), {});
});
test("a disappearing or unreadable lock during the read refuses without claiming or writing", () => {
  for (const code of ["ENOENT", "EPERM", "EACCES"]) {
    const root = deadRoot(),
      before = tree(root);
    (globalThis as any).__lockCheckpoint = (point: string) => {
      if (point === "lock-read:before-read:" + join(root, ".lock"))
        throw Object.assign(new Error("forced concurrent open failure"), { code });
    };
    try {
      assert.throws(() => acquire(root), /lock is busy/u);
      assert.deepEqual(tree(root), before);
    } finally {
      delete (globalThis as any).__lockCheckpoint;
    }
  }
});
test("readable dead recovery claims once and acquisition/release clean stale claims", () => {
  const root = deadRoot(),
    held = acquire(root);
  assert.notEqual(held.token, "0".repeat(32));
  assert.deepEqual(fs.readdirSync(root), [".lock"]);
  fs.writeFileSync(join(root, `.lock.claim.${"a".repeat(32)}.1`), dead());
  release(root, ".lock", held);
  assert.deepEqual(tree(root), {});
});
test("unreadable locks fail closed automatically, human claim uses exact-byte SHA", async () => {
  for (const content of [Buffer.alloc(0), Buffer.from("{truncated"), Buffer.from([0xff, 0x00])]) {
    const root = temporary();
    fs.writeFileSync(join(root, ".lock"), content);
    assert.throws(() => acquire(root), /break-lock/u);
    const id = identity(content);
    await breakLock(root, async (prompt) => {
      assert(prompt.includes(id));
      assert(prompt.includes(content.toString("hex")));
      return true;
    });
    assert(fs.existsSync(join(root, `.lock.claim.${id}.1`)));
    const held = acquire(root);
    release(root, ".lock", held);
    assert.deepEqual(tree(root), {});
  }
});
test("reproduced delayed-breaker schedule preserves the live acquirer's fresh token", async () => {
  const root = deadRoot();
  let unblock!: (value: boolean) => void;
  const delayed = breakLock(
    root,
    () =>
      new Promise((resolve) => {
        unblock = resolve;
      }),
  );
  await breakLock(root, async () => true);
  const held = acquire(root),
    current = fs.readFileSync(join(root, ".lock"));
  unblock(true);
  await assert.rejects(delayed, /lock changed/u);
  assert.deepEqual(fs.readFileSync(join(root, ".lock")), current);
  release(root, ".lock", held);
});
test("two confirmed human breakers and breaker versus automatic recovery share one claim", async () => {
  const root = deadRoot();
  const results = await Promise.allSettled([breakLock(root, async () => true), breakLock(root, async () => true)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const held = acquire(root);
  release(root, ".lock", held);
  const another = deadRoot();
  let unblock!: (value: boolean) => void;
  const human = breakLock(
    another,
    () =>
      new Promise((resolve) => {
        unblock = resolve;
      }),
  );
  const automatic = acquire(another);
  unblock(true);
  await assert.rejects(human, /lock changed/u);
  assert.equal(owner(fs.readFileSync(join(another, ".lock")))?.token, automatic.token);
  release(another, ".lock", automatic);
});
test("after the winner re-read, another remover cannot advance past its live claim", async () => {
  const root = deadRoot();
  let sawBlocked = false;
  (globalThis as any).__lockCheckpoint = (point: string) => {
    if (point === "claim:before-unlink") {
      assert.throws(() => acquire(root), /busy/u);
      sawBlocked = true;
    }
  };
  try {
    await breakLock(root, async () => true);
  } finally {
    delete (globalThis as any).__lockCheckpoint;
  }
  assert(sawBlocked);
  const held = acquire(root);
  release(root, ".lock", held);
});
test("dead claimant killed before unlink is recovered through claim n+1", () => {
  const root = deadRoot(),
    env = { ...isolatedEnv(root), TEST_KILL_AT: "claim:held" };
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      new URL("./lock-crash-hook.ts", import.meta.url).href,
      "--input-type=module",
      "-e",
      `import {acquire} from ${JSON.stringify(new URL("../product/src/install-lock.ts", import.meta.url).href)}; acquire(${JSON.stringify(root)});`,
    ],
    { cwd: ROOT, env, encoding: "utf8" },
  );
  assert.notEqual(child.status, 0, child.stderr);
  assert(fs.existsSync(join(root, `.lock.claim.${"0".repeat(32)}.1`)));
  let second = false;
  (globalThis as any).__lockCheckpoint = (point: string) => {
    if (point === `.lock.claim.${"0".repeat(32)}.2:after-link`) second = true;
  };
  const held = acquire(root);
  delete (globalThis as any).__lockCheckpoint;
  assert(second);
  release(root, ".lock", held);
  assert.deepEqual(tree(root), {});
});
test("remote owners and remote claimants require the explicit human assertion", async () => {
  const root = temporary();
  fs.writeFileSync(join(root, ".lock"), dead("0".repeat(32), "other-host"));
  fs.writeFileSync(join(root, `.lock.claim.${"0".repeat(32)}.1`), dead("a".repeat(32), "other-host"));
  assert.throws(() => acquire(root), /break-lock/u);
  await breakLock(root, async (prompt) => {
    assert.match(prompt, /asserting.*remote process/u);
    return true;
  });
  const held = acquire(root);
  release(root, ".lock", held);
});
test("cleanup preserves live-identity claims, nonmatching names and directories", () => {
  const root = temporary(),
    held = acquire(root),
    ownClaim = `.lock.claim.${held.token}.1`;
  fs.writeFileSync(join(root, ownClaim), dead());
  fs.writeFileSync(join(root, ".lock.claim.not-an-identity.1"), "keep");
  fs.mkdirSync(join(root, `.lock.claim.${"b".repeat(32)}.1`));
  cleanupClaims(root, held);
  assert(fs.existsSync(join(root, ownClaim)));
  assert(fs.existsSync(join(root, ".lock.claim.not-an-identity.1")));
  assert(fs.statSync(join(root, `.lock.claim.${"b".repeat(32)}.1`)).isDirectory());
  release(root, ".lock", held);
  assert(fs.existsSync(join(root, ownClaim)));
});
test("each claim-cleanup unlink crash converges at the next acquisition", () => {
  for (const side of ["before", "after"])
    for (const index of [0, 1]) {
      const root = temporary(),
        names = ["a", "b"].map((char) => `.lock.claim.${char.repeat(32)}.1`);
      for (const name of names) fs.writeFileSync(join(root, name), dead());
      const env = { ...isolatedEnv(root), TEST_KILL_AT: `claim-cleanup:${side}-unlink:${names[index]}` };
      const child = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--import",
          new URL("./lock-crash-hook.ts", import.meta.url).href,
          "--input-type=module",
          "-e",
          `import {acquire} from ${JSON.stringify(new URL("../product/src/install-lock.ts", import.meta.url).href)}; acquire(${JSON.stringify(root)});`,
        ],
        { cwd: ROOT, env },
      );
      assert.notEqual(child.status, 0);
      const held = acquire(root);
      release(root, ".lock", held);
      assert.deepEqual(tree(root), {});
    }
});
