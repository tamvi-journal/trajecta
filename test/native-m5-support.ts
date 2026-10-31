import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, win32 } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
export function nativeCanary(): string {
  const home = temporary(),
    env = isolatedEnv(home),
    locator = join(process.env["ProgramFiles(x86)"]!, "Microsoft Visual Studio/Installer/vswhere.exe");
  for (const key of [
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "SystemDrive",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_ARCHITEW6432",
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  const locate = raw(
    locator,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-find",
      "VC/Auxiliary/Build/vcvars64.bat",
      "-utf8",
    ],
    env,
  );
  receipt("canary-compiler", { locate });
  assert.equal(locate.status, 0, JSON.stringify(locate));
  const setup = text(locate).trim();
  assert(fs.existsSync(setup), "native Microsoft C++ toolchain required");
  const exe = join(home, "powershell.exe"),
    script = join(home, "compile.cmd");
  fs.writeFileSync(
    script,
    '@echo off\r\ncall "' +
      setup +
      '" >nul\r\nif errorlevel 1 exit /b %errorlevel%\r\n' +
      'cl.exe /nologo /MT /O2 /EHsc /Fe:"' +
      exe +
      '" /Fo:"' +
      join(home, "canary.obj") +
      '" /Fd:"' +
      join(home, "canary.pdb") +
      '" "' +
      join(ROOT, "test/windows-powershell-canary.cpp") +
      '" /link /SUBSYSTEM:CONSOLE\r\nexit /b %errorlevel%\r\n',
  );
  const compile = raw(systemPath("System32/cmd.exe"), ["/d", "/q", "/c", script], env, undefined, 60000);
  receipt("canary-compiler", { locate, compile });
  assert.equal(compile.status, 0, JSON.stringify(compile));
  assert(fs.existsSync(exe));
  return exe;
}
/** A causal, test-only intervention: exit is observed before killing the pipe holder. */
export async function pipeExitDiagnostic(source: string, env: Record<string, string>, pidFile: string) {
  const started = performance.now(),
    events: Array<Record<string, unknown>> = [],
    out: Buffer[] = [],
    err: Buffer[] = [];
  const child = spawn(powershell(), [...HOST_FLAGS, encodePowerShell(source)], { env, cwd: ROOT });
  child.stdin.end();
  child.stdout.on("data", (b) => {
    out.push(Buffer.from(b));
    events.push({ kind: "stdout", t_ms: performance.now() - started, hex: b.toString("hex") });
  });
  child.stderr.on("data", (b) => {
    err.push(Buffer.from(b));
    events.push({ kind: "stderr", t_ms: performance.now() - started, hex: b.toString("hex") });
  });
  child.on("exit", (code, signal) => events.push({ kind: "exit", t_ms: performance.now() - started, code, signal }));
  const intervention = setTimeout(() => {
    const file = pidFile + ".child";
    if (!fs.existsSync(file)) {
      events.push({ kind: "no-descendant-receipt", t_ms: performance.now() - started });
      return;
    }
    const pid = Number(fs.readFileSync(file, "utf8"));
    events.push({ kind: "kill-owned-descendant", t_ms: performance.now() - started, pid });
    try {
      process.kill(pid);
    } catch (e) {
      events.push({ kind: "kill-error", message: String(e) });
    }
  }, 8000);
  const deadline = setTimeout(() => {
    events.push({ kind: "diagnostic-timeout", t_ms: performance.now() - started });
    child.kill();
  }, 15000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    events.push({ kind: "close", t_ms: performance.now() - started, ...result });
    return {
      ...result,
      pid: child.pid,
      events,
      stdout_hex: Buffer.concat(out).toString("hex"),
      stderr_hex: Buffer.concat(err).toString("hex"),
    };
  } finally {
    clearTimeout(intervention);
    clearTimeout(deadline);
    for (const file of [pidFile, pidFile + ".child"])
      if (fs.existsSync(file)) {
        const pid = Number(fs.readFileSync(file, "utf8"));
        try {
          process.kill(pid);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        }
      }
  }
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
