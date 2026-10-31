/** Settled §13.7 host pre-warm. This never changes a wrapper or its comparator. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ROOT } from "./support.ts";
import { resolve, join } from "node:path";
import { encodePowerShell } from "../product/src/templates.ts";

export const HOST_FLAGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"];
export const NOOP_ENCODED = encodePowerShell("exit 0");

export function coldHostInventory(env: Record<string, string>): Map<string, "dir" | "file"> {
  assert(env.USERPROFILE && env.LOCALAPPDATA, "inventory roots must come from the test environment");
  const profile = resolve(env.USERPROFILE),
    local = resolve(env.LOCALAPPDATA);
  return new Map([
    ...[
      "AppData",
      "AppData/Local",
      "AppData/Local/Microsoft",
      "AppData/Local/Microsoft/Windows",
      "AppData/Local/Microsoft/Windows/PowerShell",
      "AppData/Roaming",
    ].map((p) => [join(profile, p), "dir"] as const),
    [join(profile, "AppData/Local/Microsoft/Windows/PowerShell/StartupProfileData-NonInteractive"), "file"],
    ...["", "Microsoft", "Microsoft/Windows", "Microsoft/Windows/Caches"].map((p) => [join(local, p), "dir"] as const),
  ]);
}

export function prewarmWindowsHost(powershell: string, env: Record<string, string>, cwd = ROOT): void {
  if (process.platform !== "win32") return;
  // Direct argv invocation, not a FOR /F command string. No shell reparsing.
  const result = spawnSync(powershell, [...HOST_FLAGS, NOOP_ENCODED], { cwd, env, timeout: 20000 });
  assert.equal(
    result.status,
    0,
    JSON.stringify({
      powershell,
      flags: HOST_FLAGS,
      encoded: NOOP_ENCODED,
      error: result.error?.message,
      signal: result.signal,
      stdout_hex: result.stdout?.toString("hex"),
      stderr_hex: result.stderr?.toString("hex"),
    }),
  );
}
