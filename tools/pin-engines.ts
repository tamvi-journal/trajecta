/** Explicit, reviewed pin update: node --experimental-strip-types tools/pin-engines.ts identity|work FULL_SHA. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, json, order, readLock, ROOT, selected, sha, type Lock } from "./engine-lock.ts";
const [name, commit] = process.argv.slice(2);
if (!["identity", "work"].includes(name) || !/^[0-9a-f]{40}$/.test(commit ?? ""))
  throw new Error("usage: pin-engines.ts identity|work FULL_SHA");
let lock: Lock;
try {
  lock = readLock();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  lock = {
    schema: "trajecta.engines-lock/v1",
    engines: {
      identity: {
        repository: "https://github.com/tamvi-journal/trajecta-identity-memory.git",
        commit: "98313ac335a533732630b2ba7039180e4bb89dcf",
        subdirectory: "node",
        paths: ["src", "schema.sql", "tables", "assets", "package.json"],
        files: {},
      },
      work: {
        repository: "https://github.com/tamvi-journal/trajecta-work-memory.git",
        commit: "5c696187eb5df5be7341f88296c5462488a5ae27",
        subdirectory: ".",
        paths: ["src", "assets", "package.json"],
        files: {},
      },
    },
  };
}
const pin = lock.engines[name as "identity" | "work"];
pin.commit = commit;
const root = checkout(name, pin);
const digests = (files: Record<string, Buffer>) =>
  Object.fromEntries(
    Object.entries(files)
      .sort(([a], [b]) => order(a, b))
      .map(([p, b]) => [p, sha(b)]),
  );
pin.files = digests(selected(join(root, pin.subdirectory), pin.paths));
if (name === "identity")
  pin.supplemental = {
    paths: ["trajecta_identity/profiles"],
    destination: "engines/trajecta_identity/profiles",
    files: digests(selected(root, ["trajecta_identity/profiles"])),
  };
writeFileSync(join(ROOT, "engines.lock.json"), json(lock));
