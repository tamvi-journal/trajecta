import * as fs from "node:fs";
import { resolve } from "node:path";
import { acquire, release } from "./install-lock.ts";
import { ledger } from "./owned.ts";
import { pluginFiles, writePlugin, PluginInputError, type PluginOptions } from "./plugin.ts";
import { preparePlugin, preflightPlugin, preflightPluginRoot, buildGeneration } from "./plugin-generations.ts";

export async function pluginCommand(argv: string[]): Promise<number> {
  const { defaultRoot, assertInstalledState } = await import("./installer.ts");
  const fields = {
    "--root": "root",
    "--profile": "profile",
    "--name": "name",
    "--house": "house",
    "--data-dir": "dataDir",
    "--profiles-dir": "profilesDir",
    "--work-root": "workRoot",
    "--out": "out",
    "--db": "db",
  } as const;
  const opts = { root: defaultRoot() } as PluginOptions & { out?: string };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!(key in fields) || argv[i + 1] === undefined) throw new PluginInputError("invalid plugin option: " + key);
    (opts as any)[fields[key as keyof typeof fields]] = argv[i + 1];
  }
  opts.root = resolve(opts.root);
  if (opts.db !== undefined) opts.db = resolve(opts.db);
  if (opts.out !== undefined) {
    const files = await pluginFiles(opts);
    const out = resolve(opts.out);
    writePlugin(out, files);
    process.stdout.write(out + "\n");
    return 0;
  }
  const prepared = await preparePlugin(opts);
  preflightPluginRoot(opts.root);
  assertInstalledState(opts.root);
  if (fs.existsSync(opts.root)) await preflightPlugin(opts.root, prepared.name, ledger(opts.root));
  const held = acquire(opts.root);
  try {
    assertInstalledState(opts.root);
    const data = ledger(opts.root);
    await buildGeneration(opts.root, prepared, data);
    return 0;
  } finally {
    release(opts.root, ".lock", held);
  }
}
