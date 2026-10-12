/** Adapt only execution/fixture location; preserve every original corpus comparator. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./support.ts";
const upstream = join(ROOT, ".isolation/upstream/identity");
const original = fs.readFileSync(join(upstream, "node/test/cli-conformance.test.ts"), "utf8");
let source = original;
const replace = (old: string, value: string) => {
  assert.equal(source.split(old).length - 1, 1, "pinned harness transformation is unique");
  source = source.replace(old, value);
};
replace(
  'resolve(dirname(fileURLToPath(import.meta.url)), "../..")',
  'resolve(dirname(fileURLToPath(import.meta.url)), "..")',
);
replace(
  'import { heldWriter } from "./held-writer.ts";',
  `import { heldWriter } from ${JSON.stringify(pathToFileURL(join(upstream, "node/test/held-writer.ts")).href)};`,
);
const apiStart = source.indexOf("import {\n  asArray,");
const apiEnd = source.indexOf('} from "../src/index.ts";', apiStart) + '} from "../src/index.ts";'.length;
assert(apiStart >= 0 && apiEnd > apiStart);
source =
  source.slice(0, apiStart) +
  `
import { identityApi, enginePath } from "../product/src/engines.ts";
const { asArray, asString, compareCodePoint, floatHex, get, parseLossless, pyFloatRepr } = await identityApi();
type JsonValue = any;
type OrderedObject = any;
import { snapshot, tree } from "../test/support.ts";
` +
  source.slice(apiEnd);
replace(
  'import { render, type Token } from "./cli/tokens.ts";',
  `import { render, type Token } from ${JSON.stringify(pathToFileURL(join(upstream, "node/test/cli/tokens.ts")).href)};`,
);
replace(
  'CORPUS = resolve(ROOT, "spec/golden-cli-v1");',
  'CORPUS = resolve(ROOT, ".isolation/upstream/identity/spec/golden-cli-v1");',
);
replace('mkdtempSync(resolve(ROOT, ".cli-replay-"))', 'mkdtempSync(resolve(ROOT, ".isolation/tmp/.cli-replay-"))');
replace(
  "const stdout: Buffer[] = [],\n      stderr: Buffer[] = [];",
  `let candidate = false;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    env.NODE_OPTIONS = ${JSON.stringify("--import=" + pathToFileURL(join(ROOT, "test/identity-seam.ts")).href)};
    env.TEST_IDENTITY_INVOCATION = resolve(scenario, "invocation.json");`,
);
replace(
  `[
          "--experimental-strip-types",
          resolve(ROOT, "node/test/cli/child.ts"),
          resolve(scenario, "invocation.json"),
          ...argv,
        ]`,
  `[
          "--experimental-strip-types",
          candidate ? resolve(ROOT, "product/src/cli.ts") : enginePath("identity"),
          ...(candidate ? ["identity"] : []),
          ...argv,
        ]`,
);
replace(
  'const code = name === "p16-store-busy" ? await heldWriter(root, env, runVictim) : await runVictim();',
  `
    const saved = snapshot(root);
    const execute = () => name === "p16-store-busy" ? heldWriter(root, env, runVictim) : runVictim();
    const directCode = await execute();
    const directOut = Buffer.concat(stdout), directErr = Buffer.concat(stderr), directTree = tree(root);
    for (const [path, state] of before) assert.deepEqual(fileState(resolve(root, path)), state);
    saved.restore(); saved.dispose();
    for (const [path] of before) before.set(path, fileState(resolve(root, path)));
    stdout.length = 0; stderr.length = 0; candidate = true;
    const code = await execute();
    assert.equal(code, directCode, "pass-through exit exact");
    assert.deepEqual(Buffer.concat(stdout), directOut, "pass-through stdout exact");
    assert.deepEqual(Buffer.concat(stderr), directErr, "pass-through stderr exact");
    assert.deepEqual(tree(root), directTree, "differential authority: complete resulting bytes/tree exact");
    process.stdout.write("M2 identity pair " + name + "\\n");`,
);
replace('resolve(ROOT, "node/src/mcp.ts")', 'enginePath("identity", "mcp.ts")');
fs.writeFileSync(join(ROOT, ".isolation/cli-conformance.test.ts"), source);
