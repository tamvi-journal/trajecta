import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { json, readLock, ROOT } from "./engine-lock.ts";

export function compatibility() {
  const lock = readLock();
  const pkg = JSON.parse(readFileSync(join(ROOT, "product/package.json"), "utf8"));
  return {
    schema: "trajecta.compat/v1",
    version: pkg.version,
    node: pkg.engines.node,
    operating_systems: ["darwin", "linux", "win32"],
    engines: Object.fromEntries(
      ["identity", "work"].map((name) => [
        name,
        {
          repository: lock.engines[name as "identity" | "work"].repository,
          commit: lock.engines[name as "identity" | "work"].commit,
        },
      ]),
    ),
    stores: {
      identity: { format: "sqlite", readable_schema_versions: [4, 5], writable_schema_version: 5 },
      work: { format: "json-jsonl", schema: "trajecta.state/v1" },
    },
    sqlite_certification: {
      identity_ci: 38180779195,
      work_ci: 38183173986,
      node_22: "3.51.3",
      node_24: "3.53.4",
      work_uses_sqlite: false,
    },
  };
}
export function verifyCompat(): void {
  if (readFileSync(join(ROOT, "product/compat.json"), "utf8") !== json(compatibility()))
    throw new Error("compat.json regeneration differs");
}
if (process.argv.includes("--write")) writeFileSync(join(ROOT, "product/compat.json"), json(compatibility()));
