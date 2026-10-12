/** Cross-matrix deterministic artifact gate, independent of the builder. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, sha } from "./engine-lock.ts";
const root = resolve(process.argv[2]);
const expected = ["macos-latest", "ubuntu-latest", "windows-latest"]
  .flatMap((os) => [22, 24].map((node) => `foundation-${os}-node${node}`))
  .sort();
assert.deepEqual(readdirSync(root).sort(), expected, "all six exact-head artifacts present");
const version = JSON.parse(readFileSync(join(ROOT, "product/package.json"), "utf8")).version;
let reference: Buffer | undefined;
for (const name of expected) {
  const bytes = readFileSync(join(root, name, `trajecta-${version}.tar.gz`));
  if (reference) assert.deepEqual(bytes, reference, `cross-OS/runtime archive exact: ${name}`);
  else reference = bytes;
}
process.stdout.write(`Six byte-identical foundation artifacts: ${sha(reference!)}\n`);
