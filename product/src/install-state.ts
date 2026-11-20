import * as fs from "node:fs";
import { join } from "node:path";
import { TRUST_ANCHOR } from "./trust.ts";
import { clearStateTemp, readState, stateKeys, writeState, STATE_RECOVERY } from "./update-state.ts";
import { regular, safeRoot, syncDir } from "./install-fs.ts";

export const RESET_WARNING =
  "Removing update-state.json resets replay protection and the key-rotation chain. Type RESET UPDATE STATE: ";
export const LOST_UNINSTALL =
  "a previous uninstall ended without update state; run trajecta install on a terminal and confirm RESET UPDATE STATE, or restore update-state.json";
export function trustedKeys(root: string): string[] {
  try {
    return stateKeys(readState(root, TRUST_ANCHOR), TRUST_ANCHOR);
  } catch {
    return [TRUST_ANCHOR];
  }
}
export function lockArtifact(name: string): boolean {
  return (
    name === ".lock" ||
    /^\.lock\.[a-f0-9]{32}\.tmp$/u.test(name) ||
    /^\.lock\.claim\.(?:[a-f0-9]{32}|[a-f0-9]{64})\.[1-9][0-9]*$/u.test(name)
  );
}
export function postUninstall(root: string): boolean {
  safeRoot(root);
  if (!fs.existsSync(root)) return false;
  const current = join(root, "current");
  if (!regular(current) || !fs.readFileSync(current).equals(Buffer.from("uninstalling\n"))) return false;
  for (const name of fs.readdirSync(root)) {
    if (lockArtifact(name)) {
      regular(join(root, name));
      continue;
    }
    if (!["current", "update-state.json", "update-state.json.tmp"].includes(name)) return false;
    regular(join(root, name));
  }
  if (regular(join(root, "update-state.json"))) readState(root, TRUST_ANCHOR);
  return true;
}
/** No sentinel or protected payload write occurs before a new live decision. */
export async function completeUninstall(
  root: string,
  confirm: (prompt: string, expected: string) => Promise<boolean>,
): Promise<void> {
  if (!postUninstall(root)) return;
  const state = join(root, "update-state.json"),
    present = regular(state);
  const consent = await confirm(RESET_WARNING, "RESET UPDATE STATE");
  if (!present && !consent) throw new Error(LOST_UNINSTALL);
  clearStateTemp(root);
  if (present && consent) {
    fs.unlinkSync(state);
    syncDir(root);
  }
  fs.unlinkSync(join(root, "current"));
  syncDir(root);
}
export function requireInstallState(root: string): void {
  if (fs.readdirSync(root).includes("update-state.json")) {
    readState(root, TRUST_ANCHOR);
    return;
  }
  if (fs.readdirSync(root).some((name) => !lockArtifact(name) && name !== "update-state.json.tmp"))
    throw new Error(STATE_RECOVERY);
}
export function seedInstallState(root: string, sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("release has no index_sequence");
  const exists = regular(join(root, "update-state.json"));
  if (!exists) requireInstallState(root);
  const previous = exists ? readState(root, TRUST_ANCHOR) : null;
  if (!previous || previous.floor < sequence)
    writeState(
      root,
      previous
        ? { ...previous, floor: sequence }
        : { schema: "trajecta.update-state/v2", floor: sequence, accepted: null, rotations: [] },
    );
}
/** Missing local history cannot distinguish a rotated release from an unknown signer. */
export function versionTrustFailure(root: string, error: unknown): never {
  if ((error as Error).message === "release signature mismatch") {
    try {
      readState(root, TRUST_ANCHOR);
    } catch {
      throw new Error("needs --reset-state");
    }
  }
  throw error;
}
