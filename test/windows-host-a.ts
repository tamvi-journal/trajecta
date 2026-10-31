/** Settled §13.7 host pre-warm. This never changes a wrapper or its comparator. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ROOT } from "./support.ts";

export const HOST_FLAGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"];
export const NOOP_ENCODED = Buffer.from("exit 0", "utf16le").toString("base64");

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
