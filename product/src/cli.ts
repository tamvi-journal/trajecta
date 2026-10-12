#!/usr/bin/env -S node --experimental-strip-types
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { engineMetadata, passThrough } from "./engines.ts";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command] = argv;
  if (command === "version") {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const compat = JSON.parse(readFileSync(new URL("../compat.json", import.meta.url), "utf8"));
    process.stdout.write(`trajecta ${pkg.version}\n`);
    for (const engine of ["identity", "work"] as const)
      process.stdout.write(`${engine} engine ${engineMetadata(engine).version} ${compat.engines[engine].commit}\n`);
    return 0;
  }
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write("Usage: trajecta {version|identity|work} ...\n");
    return 0;
  }
  process.stderr.write(`trajecta: unknown command '${command}'\n`);
  return 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "identity" || command === "work") {
    await passThrough(command, args);
  } else {
    main()
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error) => {
        process.stderr.write(`trajecta: ${error.message}\n`);
        process.exitCode = 1;
      });
  }
}
