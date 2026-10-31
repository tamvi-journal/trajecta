import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ROOT, temporary, isolatedEnv } from "./support.ts";
import { HOST_FLAGS } from "./windows-host-a.ts";
import { encodePowerShell } from "../product/src/templates.ts";

export function raw(executable: string, args: string[], env: Record<string, string>, input?: Buffer, timeout = 30000) {
  const start = performance.now();
  const r = spawnSync(executable, args, { env, input, cwd: ROOT, timeout, maxBuffer: 16 * 1024 * 1024 });
  return {
    executable,
    args,
    status: r.status,
    signal: r.signal,
    error: r.error?.message ?? null,
    stdout_hex: r.stdout?.toString("hex") ?? "",
    stderr_hex: r.stderr?.toString("hex") ?? "",
    elapsed_ms: performance.now() - start,
  };
}
export function text(r: ReturnType<typeof raw>, stream = "stdout") {
  return Buffer.from(stream === "stdout" ? r.stdout_hex : r.stderr_hex, "hex").toString("utf8");
}
export function systemPath(...parts: string[]) {
  return win32.join(process.env.SystemRoot ?? process.env.SYSTEMROOT!, ...parts);
}
export function powershell() {
  return systemPath("System32/WindowsPowerShell/v1.0/powershell.exe");
}
export function ps(source: string, env: Record<string, string>, timeout = 30000) {
  return raw(powershell(), [...HOST_FLAGS, encodePowerShell(source)], env, undefined, timeout);
}
export const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
let nativeTool: string | undefined;
export function helper() {
  if (nativeTool) return nativeTool;
  const home = temporary(),
    out = join(home, "native-m5.exe");
  const r = raw(
    systemPath("Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
    [
      "/nologo",
      "/target:exe",
      "/reference:System.Web.Extensions.dll",
      "/out:" + out,
      join(ROOT, "test/windows-m5-native.cs"),
    ],
    isolatedEnv(home),
  );
  receipt("compiler", { result: r });
  assert.equal(r.status, 0, JSON.stringify(r));
  assert(fs.existsSync(out));
  nativeTool = out;
  return out;
}
export function receipt(name: string, data: unknown) {
  fs.mkdirSync(join(ROOT, "dist"), { recursive: true });
  fs.writeFileSync(
    join(ROOT, "dist", `native-m5-${name}.json`),
    JSON.stringify(
      {
        schema: "trajecta.native-m5/v1",
        head: process.env.GITHUB_SHA ?? null,
        run_id: process.env.GITHUB_RUN_ID ?? null,
        node: process.versions.node,
        image: process.env.ImageVersion ?? null,
        os: process.platform,
        data,
      },
      null,
      2,
    ) + "\n",
  );
}
export function jsonResult(r: ReturnType<typeof raw>) {
  assert.equal(r.status, 0, JSON.stringify(r));
  return JSON.parse(text(r));
}
export function digest(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function sameResult(a: ReturnType<typeof raw>, b: ReturnType<typeof raw>) {
  assert.equal(b.status, a.status, JSON.stringify(b));
  assert.equal(b.error, a.error);
  assert.equal(b.stdout_hex, a.stdout_hex);
  assert.equal(b.stderr_hex, a.stderr_hex);
}
