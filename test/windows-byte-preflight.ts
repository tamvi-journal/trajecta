/** Characterization only: these native readers are not a production validator. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, temporary, isolatedEnv, tree } from "./support.ts";

if (process.platform !== "win32") throw new Error("this proof requires a real Windows runner");
const root = temporary();
const fixtures: Record<string, Buffer> = {
  "pointer-lf": Buffer.from("0.5.0\n\n"),
  "pointer-crlf-one": Buffer.from("0.5.0\r\n"),
  "pointer-crlf-two": Buffer.from("0.5.0\r\n\r\n"),
  "pointer-no-final-lf": Buffer.from("0.5.0\n"),
  "pointer-extra-blank": Buffer.from("0.5.0\n\n\n"),
  "pointer-nul-final": Buffer.from("0.5.0\n\0"),
  "pointer-bare-cr": Buffer.from("0.5.0\r1.0.0\n"),
  "pointer-two-versions": Buffer.from("0.5.0\n1.0.0\n"),
  "node-lf": Buffer.from("C:\\fixture\\node.exe\n"),
  "node-bare-cr": Buffer.from("C:\\fixture\\node.exe\r"),
  "node-nul-final": Buffer.from("C:\\fixture\\node.exe\0"),
  "node-crlf": Buffer.from("C:\\fixture\\node.exe\r\n"),
  "node-unicode": Buffer.from("C:\\hồ-sơ\\node.exe\n"),
};
for (const [name, bytes] of Object.entries(fixtures)) fs.writeFileSync(join(root, name), bytes);
const before = tree(root);
const records = Object.entries(fixtures).map(([name, bytes]) => {
  const result = spawnSync(
    "cmd.exe",
    ["/d", "/q", "/c", join(ROOT, "test/windows-byte-reader.cmd"), join(root, name)],
    {
      cwd: root,
      env: { ...isolatedEnv(root), TEST_OBSERVER_NODE: process.execPath },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(
    result.status,
    0,
    JSON.stringify({ fixture: name, error: result.error?.message, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr }),
  );
  const fieldText = result.stdout.match(/FIELDS\r?\n([^\r\n]+)/u)?.[1];
  assert(fieldText, result.stdout);
  return {
    name,
    hex: bytes.toString("hex"),
    size: bytes.length,
    fields: JSON.parse(fieldText),
    forFile: JSON.parse(result.stdout.match(/FOR_FILE\r?\n([^\r\n]+)/u)![1]),
    forFindstr: JSON.parse(result.stdout.match(/FOR_FINDSTR\r?\n([^\r\n]+)/u)![1]),
    stdout: result.stdout,
    stderr: result.stderr,
  };
});
assert.deepEqual(tree(root), before, "native observations do not change fixture bytes or inventory");
fs.mkdirSync(join(ROOT, "dist"), { recursive: true });
fs.writeFileSync(
  join(ROOT, "dist/windows-byte-preflight.json"),
  JSON.stringify({ node: process.versions.node, records }, null, 2) + "\n",
);
for (const record of records) process.stdout.write(JSON.stringify(record) + "\n");
