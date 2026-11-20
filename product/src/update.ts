import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { TRUST_ANCHOR } from "./trust.ts";
import { requireAnchor } from "./release.ts";
import { fetchIndex } from "./update-fetch.ts";
import { decideIndex, resetIndex, readState, writeState } from "./update-state.ts";
import { defaultRoot, assertInstalledState, confirmation, pointer } from "./installer.ts";
import { acquire, release } from "./install-lock.ts";
import { safeRoot } from "./install-fs.ts";
import { verifyVersion } from "./owned.ts";

export const RESET_LIMIT =
  "This human trust reset cannot reconstruct a higher sequence previously seen but never installed. It can lower replay protection and allow replay until a newer index is accepted. This trusts the published rotation history as it stands.";
export async function update(argv: string[]): Promise<number> {
  let root = defaultRoot(),
    from: string | undefined,
    version: string | undefined,
    check = false,
    reset = false;
  // Preserve sentinel precedence before validating the remaining command inputs.
  const rootAt = argv.indexOf("--root");
  if (rootAt >= 0 && argv[rootAt + 1]) root = resolve(argv[rootAt + 1]);
  assertInstalledState(root);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--check") {
      check = true;
      continue;
    }
    if (flag === "--reset-state") {
      reset = true;
      continue;
    }
    if (!["--root", "--from", "--version"].includes(flag) || argv[i + 1] === undefined)
      throw new Error("invalid update option: " + flag);
    const value = argv[++i];
    if (flag === "--root") root = resolve(value);
    else if (flag === "--from") from = resolve(value);
    else version = value;
  }
  requireAnchor();
  if (check && reset) throw new Error("conflicting update modes");
  safeRoot(root);
  if (reset && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("--reset-state requires a terminal");
  if (reset) {
    process.stdout.write(RESET_LIMIT + "\n");
    if (!(await confirmation("Type RESET UPDATE STATE: ", "RESET UPDATE STATE")))
      throw new Error("update state reset declined");
  } else readState(root, TRUST_ANCHOR);
  if (!check && !reset) throw new Error("update installation is not available in this build; use update --check");
  const fetched = await fetchIndex(from);
  if (check) {
    const decision = decideIndex(fetched.bytes, fetched.signature, readState(root, TRUST_ANCHOR), TRUST_ANCHOR);
    const target = version ?? decision.index.latest;
    if (!decision.index.releases.some((r) => r.version === target)) throw new Error("update version is not listed");
    const active = pointer(root);
    process.stdout.write(
      "active " +
        (active && active !== "uninstalling" ? active[0] : "none") +
        "\nlatest " +
        decision.index.latest +
        "\nupdate " +
        (active && active !== "uninstalling" && active[0] === target ? "none" : target) +
        "\n",
    );
    return 0;
  }
  const held = acquire(root);
  try {
    assertInstalledState(root);
    const rebuilt = resetIndex(fetched.bytes, fetched.signature, 0, TRUST_ANCHOR);
    let floor = 0;
    for (const name of fs.readdirSync(root).sort())
      if (/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(name))
        floor = Math.max(floor, verifyVersion(join(root, name), rebuilt.keys).index_sequence);
    const decision = resetIndex(fetched.bytes, fetched.signature, floor, TRUST_ANCHOR);
    writeState(root, decision.state);
    return 0;
  } finally {
    release(root, ".lock", held);
  }
}
