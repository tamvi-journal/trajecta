/** The only engine adapter. Child CLIs are public interfaces, never reimplemented here. */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Engine = "identity" | "work";
export function enginePath(engine: Engine, entry = "cli.ts"): string {
  return fileURLToPath(new URL(`../../engines/${engine}/src/${entry}`, import.meta.url));
}
export function engineMetadata(engine: Engine): { name: string; version: string } {
  return JSON.parse(readFileSync(new URL(`../../engines/${engine}/package.json`, import.meta.url), "utf8"));
}
export async function identityApi() {
  return import("../../engines/identity/src/index.ts");
}
/** Public CLI module, also initializes its frozen diagnostic handling. */
export async function prepareIdentityCli() {
  return import("../../engines/identity/src/cli.ts");
}
export async function workApi() {
  return import("../../engines/work/src/index.ts");
}
export function spawnEngine(engine: Engine, argv: string[]): ChildProcess {
  return spawn(process.execPath, ["--experimental-strip-types", enginePath(engine), ...argv], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: false,
  });
}
export async function passThrough(engine: Engine, argv: string[]): Promise<number> {
  const child = spawnEngine(engine, argv);
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const handlers = new Map(signals.map((signal) => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        for (const [name, handler] of handlers) process.removeListener(name, handler);
        if (signal && process.platform !== "win32") {
          process.kill(process.pid, signal);
          return;
        }
        // Windows supplies the native termination status as the child's exit code.
        if (code === null) {
          reject(new Error("engine exited without a status"));
          return;
        }
        resolve(code);
      });
    });
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}
