import * as fs from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export function supported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version.trim());
  return !!match && ((Number(match[1]) === 22 && Number(match[2]) >= 19) || Number(match[1]) === 24);
}
export function candidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const home = env.HOME || env.USERPROFILE || "",
    binary = platform === "win32" ? "node.exe" : "node";
  const roots = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (platform === "win32") {
    if (env.ProgramFiles) roots.push(join(env.ProgramFiles, "nodejs"));
  } else roots.push("/opt/homebrew/bin", "/usr/local/bin");
  if (home) {
    roots.push(join(home, ".volta/bin"), join(home, ".fnm/current/bin"));
    const nvm = join(home, ".nvm/versions/node");
    if (fs.existsSync(nvm))
      roots.push(
        ...fs
          .readdirSync(nvm)
          .sort()
          .reverse()
          .map((version) => join(nvm, version, "bin")),
      );
  }
  return [...new Set(roots.map((root) => resolve(root, binary)))];
}
export function probeNode(): string {
  for (const candidate of candidates()) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (result.status === 0 && supported(result.stdout)) return fs.realpathSync.native(candidate);
  }
  throw new Error("need Node 22.19+ or 24 LTS");
}
/** #47: choose the writer runtime before any lock/root/store mutation. */
export function handoffNode(node: string): number | null {
  if (fs.realpathSync.native(process.execPath) === node) return null;
  const argv = [node, ...process.execArgv, ...process.argv.slice(1)];
  if (process.platform !== "win32") {
    const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
    process.execve(node, argv, env as Record<string, string>);
    throw new Error("Node exec returned unexpectedly");
  }
  // PowerShell is a read-only bootstrap waiter; only the selected Node can become a writer.
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const command = "& " + argv.map(quote).join(" ") + "; exit $LASTEXITCODE";
  const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (child.error) throw child.error;
  return child.status ?? 1;
}
