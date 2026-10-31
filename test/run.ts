import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vendor, ROOT, json, readLock } from "../tools/engine-lock.ts";
import { TEMP, isolatedEnv } from "./support.ts";
import { build } from "../tools/build-release.ts";
vendor(undefined, process.argv.includes("--fetch"));
const env = { ...process.env, ...isolatedEnv(join(TEMP, "runner")) };
const run = (args: string[], cwd = ROOT) => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", ...args], { cwd, env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(["test/prepare-cli.ts"]);
run([
  "--test",
  "test/foundation.test.ts",
  "test/transport.test.ts",
  "test/signals.test.ts",
  "test/dispatcher.test.ts",
  "test/compat.test.ts",
  "test/write-trace.test.ts",
  "test/plugin.test.ts",
  "test/posix-wrapper.test.ts",
  "test/windows-wrapper.test.ts",
  "test/plugin-generations.test.ts",
]);
run([
  "--test",
  "--test-concurrency=1",
  "test/install-lock.test.ts",
  "test/lock-concurrency.test.ts",
  "test/release-trust.test.ts",
  "test/recovery.test.ts",
  "test/writer-lifetime.test.ts",
  "test/install-transaction.test.ts",
  "test/installer-adversarial.test.ts",
  "test/node-handoff.test.ts",
  "test/install-authority.test.ts",
  "test/bootstrap.test.ts",
  "test/extractor.test.ts",
  "test/templates.test.ts",
  "test/plugin-db.test.ts",
  "test/plugin-generation-crash.test.ts",
  "test/wrapper-signals.test.ts",
  "test/plugin-edges.test.ts",
  "test/shared-effects.test.ts",
  "test/mcp-wrapper.test.ts",
]);
run(["--test", ".isolation/cli-conformance.test.ts"]);
const work = join(ROOT, ".isolation/upstream/work");
const tests = readdirSync(join(work, "test"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
run(["--import", "./test/work-gate.ts", "--test", ...tests.map((name) => join(work, "test", name))]);
const a = build("release", false),
  b = build("release", false);
if (!a.equals(b)) throw new Error("two final builds differ");
mkdirSync(join(ROOT, "dist"), { recursive: true });
const version = JSON.parse(readFileSync(join(ROOT, "product/package.json"), "utf8")).version;
writeFileSync(join(ROOT, "dist", `trajecta-${version}.tar.gz`), a);
writeFileSync(
  join(ROOT, "dist/runtime.json"),
  json({
    node: process.versions.node,
    sqlite: process.versions.sqlite,
    os: process.platform,
    arch: process.arch,
    engines: Object.fromEntries(Object.entries(readLock().engines).map(([name, pin]) => [name, pin.commit])),
  }),
);
