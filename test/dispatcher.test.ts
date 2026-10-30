import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { scanDispatcher, checkDispatcher } from "../tools/dispatcher-scan.ts";
import { ROOT } from "./support.ts";
test("dispatcher source: argv and import only; engine never enters the product exit/error wrapper", () => {
  checkDispatcher();
  const cli = fs.readFileSync(join(ROOT, "product/src/cli.ts"), "utf8");
  const adapter = fs.readFileSync(join(ROOT, "product/src/engines.ts"), "utf8");
  for (const effect of [
    'process.on("SIGINT", () => {});',
    'process.on("exit", () => {});',
    "process.stdin.read();",
    'process.stdout.write("x");',
    'process.stderr.write("x");',
    'process.chdir("/");',
    'process.env.FOO = "x";',
    "process.umask(0);",
    "process.exitCode = 0;",
    "process.exit(0);",
    "readFileSync(0);",
    'spawn("node");',
  ]) {
    assert.throws(
      () =>
        scanDispatcher(
          cli,
          adapter.replace("  const entry = enginePath(engine);", effect + "\n  const entry = enginePath(engine);"),
        ),
      /observable/,
    );
    assert.throws(() => scanDispatcher(cli, adapter + effect), /observable/);
    assert.throws(() => scanDispatcher(cli + effect, adapter), /observable/);
    assert.throws(
      () => scanDispatcher(cli.replace("if (process.argv[1]", effect + "\nif (process.argv[1]"), adapter),
      /observable/,
    );
  }
  assert.throws(
    () =>
      scanDispatcher(
        cli.replace(
          "await passThrough(command, args);",
          "await passThrough(command, args).catch(() => process.exit(1));",
        ),
        adapter,
      ),
    /observable/,
  );
  assert.throws(() => scanDispatcher(cli, 'import "./hidden-effects.ts";\n' + adapter), /observable/);
});

test("pure recovery verifier source is separately pinned; extra effects remain forbidden", () => {
  const cli = fs.readFileSync(join(ROOT, "product/src/cli.ts"), "utf8");
  const adapter = fs.readFileSync(join(ROOT, "product/src/engines.ts"), "utf8");
  assert.throws(
    () =>
      scanDispatcher(
        cli,
        adapter.replace(
          "export function recoveryVerifierSource(root: string, anchor: string): string {",
          "export function recoveryVerifierSource(root: string, anchor: string): string {\n  process.stdout.write('effect');",
        ),
      ),
    /observable/,
  );
});
