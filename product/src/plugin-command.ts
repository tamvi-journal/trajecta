import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquire, release } from "./install-lock.ts";
import { digest, regular, safeRoot } from "./install-fs.ts";
import { ledger, saveLedger } from "./owned.ts";
import { pluginFiles, pluginName, pluginZip, writePlugin, PluginInputError, type PluginOptions } from "./plugin.ts";
import { checkpoint } from "./checkpoint.ts";

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
  } as const;
  const opts = { root: defaultRoot() } as PluginOptions & { out?: string };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!(key in fields) || argv[i + 1] === undefined) throw new PluginInputError("invalid plugin option: " + key);
    (opts as any)[fields[key as keyof typeof fields]] = argv[i + 1];
  }
  opts.root = resolve(opts.root);
  const files = await pluginFiles(opts);
  if (opts.out !== undefined) {
    const out = resolve(opts.out);
    writePlugin(out, files);
    process.stdout.write(out + "\n");
    return 0;
  }
  assertInstalledState(opts.root);
  const held = acquire(opts.root);
  try {
    assertInstalledState(opts.root);
    const data = ledger(opts.root);
    const name = "plugins/" + (await pluginName(opts.profile)),
      out = join(opts.root, name),
      bytes = pluginZip(files);
    safeRoot(dirname(out));
    if (!fs.existsSync(dirname(out))) {
      fs.mkdirSync(dirname(out));
      data.entries.plugins = { kind: "directory", scope: "shared" };
      saveLedger(opts.root, data);
    }
    const receipt = data.entries[name];
    const eligible =
      !fs.existsSync(out) ||
      (receipt?.kind === "file" && regular(out) && digest(fs.readFileSync(out)) === receipt.sha256);
    if (!eligible) {
      process.stdout.write(`trajecta: retained ${out}\n`);
      return 0;
    }
    writePlugin(out, files);
    checkpoint("plugin:effect");
    if (digest(fs.readFileSync(out)) !== digest(bytes)) throw new Error("plugin differs from plan");
    data.entries[name] = { kind: "file", sha256: digest(bytes), scope: "shared" };
    saveLedger(opts.root, data);
    checkpoint("plugin:ledger");
    process.stdout.write(out + "\n");
    return 0;
  } finally {
    release(opts.root, ".lock", held);
  }
}
