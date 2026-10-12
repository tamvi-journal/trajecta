import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CLI, ROOT, temporary, isolatedEnv } from "./support.ts";
import { workApi } from "../product/src/engines.ts";
test("filesystem write trace: all histories are engine-mediated, dispatcher writes nothing", async () => {
  const root = temporary(),
    env = isolatedEnv(root),
    trace = join(root, "writes.jsonl");
  fs.writeFileSync(trace, "");
  const { TrajectaStore } = await workApi();
  const store = new TrajectaStore(env.TRAJECTA_HOME);
  const work = store.open({
    operationId: "operation:m2-open",
    topic: "Synthetic M2",
    goal: "Trace a receipt",
    surface: { kind: "local", name: "test", session: "test:trace" },
  }).work;
  env.NODE_OPTIONS = "--import=" + new URL("./write-trace.ts", import.meta.url).href;
  env.TEST_WRITE_TRACE = trace;
  env.TEST_WRITE_ROOTS = JSON.stringify([env.TRAJECTA_IDENTITY_DATA_DIR, env.TRAJECTA_HOME]);
  for (const args of [
    ["version"],
    ["identity", "init"],
    ["identity", "log-fact", "trace", "--title", "Trace", "--summary", "Synthetic fixture"],
    ["identity", "retrieve", "identity"],
    ["work", "list"],
    ["work", "approve-close", work.id, "abandoned", "--summary", "Synthetic receipt"],
  ]) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], { cwd: root, env });
    assert.equal(result.status, 0, result.stderr.toString());
  }
  const rows = fs
    .readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(rows.length > 0);
  assert(rows.every((row) => row.accepted && row.mediated));
  assert(rows.some((row) => row.path.endsWith(".sqlite3")));
  assert(rows.some((row) => row.path.endsWith(".jsonl")));
  assert(
    rows.every((row) => row.entry !== CLI),
    "dispatcher itself makes no filesystem writes",
  );
  const forbidden = join(root, "not-an-engine-store");
  const refusal = spawnSync(
    process.execPath,
    ["-e", "require('node:fs').writeFileSync(process.argv[1], 'forbidden')", forbidden],
    { cwd: root, env },
  );
  assert.notEqual(refusal.status, 0);
  assert.match(refusal.stderr.toString(), /unauthorized filesystem write/u);
  assert(!fs.existsSync(forbidden));
});
