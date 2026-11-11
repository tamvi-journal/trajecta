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
      join(ROOT, "test/windows-console-observe.cs"),
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
export function startNative(executable: string, args: string[], env: Record<string, string>) {
  const started = performance.now();
  const child = spawn(executable, args, { env, cwd: ROOT, stdio: "pipe" });
  const out: Buffer[] = [],
    err: Buffer[] = [];
  let status: number | null = null,
    signal: NodeJS.Signals | null = null,
    error: string | null = null;
  let exited = false,
    closed = false;
  child.stdout.on("data", (b: Buffer) => out.push(b));
  child.stderr.on("data", (b: Buffer) => err.push(b));
  child.stdin.on("error", (e) => {
    error = e.message;
  });
  child.on("error", (e) => {
    error = e.message;
  });
  child.once("exit", () => {
    exited = true;
  });
  child.once("close", (code, sig) => {
    status = code;
    signal = sig;
    closed = true;
  });
  return {
    child,
    get exited() {
      return exited;
    },
    get closed() {
      return closed;
    },
    snapshot() {
      return {
        executable,
        args,
        status,
        signal,
        error,
        stdout_hex: Buffer.concat(out).toString("hex"),
        stderr_hex: Buffer.concat(err).toString("hex"),
        elapsed_ms: performance.now() - started,
      };
    },
  };
}
export async function until(check: () => boolean, timeout: number, description: string) {
  const end = performance.now() + timeout;
  while (!check()) {
    assert(performance.now() < end, description);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
let pidQueryEnv: Record<string, string> | undefined;
export function pidState(pid: number, wait = 0) {
  assert(Number.isSafeInteger(pid) && pid > 0);
  pidQueryEnv ??= isolatedEnv(temporary());
  return jsonResult(raw(helper(), ["--pid-state", String(pid), String(wait)], pidQueryEnv));
}
export function pidAlive(pid: number): boolean {
  return !pidState(pid).exited;
}
export async function stopOwned(pid: number) {
  try {
    if (pidAlive(pid)) process.kill(pid);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
  await until(() => !pidAlive(pid), 3000, "owned test PID must be gone: " + pid);
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
