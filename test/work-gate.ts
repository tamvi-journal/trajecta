/** Run the complete untouched work suite, pairing every public CLI invocation. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CLI, ROOT, contained, snapshot, tree } from "./support.ts";
import { enginePath } from "../product/src/engines.ts";
const original = childProcess.spawnSync;
const upstream = join(ROOT, ".isolation/upstream/work/src/cli.ts");
let invocation = 0;
childProcess.spawnSync = ((command: any, args: string[], options: any) => {
  const at = Array.isArray(args) ? args.indexOf(upstream) : -1;
  if (at < 0) return (original as any)(command, args, options);
  const inputEnv = options.env ?? process.env;
  const root = resolve(inputEnv.TRAJECTA_HOME);
  contained(root);
  const argv = args.slice(at + 1),
    roots = [root];
  if (argv[0] === "exchange-init") {
    const target = resolve(options.cwd ?? process.cwd(), argv[1]);
    contained(target);
    if (!target.startsWith(root + "/") && !target.startsWith(root + "\\") && target !== root) roots.push(target);
  }
  const saved = roots.map(snapshot),
    seed = `${process.argv[1]}:${invocation++}`;
  const env = {
    ...inputEnv,
    NODE_OPTIONS: "--import=" + pathToFileURL(join(ROOT, "test/work-determinism.ts")).href,
    TEST_WORK_SEED: seed,
    TEST_WORK_NOW: String(Date.now()),
  };
  try {
    const direct = (original as any)(command, [...args.slice(0, at), enginePath("work"), ...argv], { ...options, env });
    const states = roots.map(tree);
    saved.forEach((state) => state.restore());
    const product = (original as any)(command, [...args.slice(0, at), CLI, "work", ...argv], { ...options, env });
    for (const key of ["status", "signal", "stdout", "stderr"])
      assert.deepEqual(product[key], direct[key], `work pass-through ${key}: ${argv.join(" ")}`);
    assert.deepEqual(roots.map(tree), states, "work authority bytes/tree exact");
    process.stdout.write("M2 work pair " + argv[0] + "\n");
    return product;
  } finally {
    saved.forEach((state) => state.dispose());
  }
}) as any;
syncBuiltinESMExports();
