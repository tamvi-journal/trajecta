/** Test-only PTY supervisor: observe native status without forwarding any signal. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
fs.writeFileSync(config.pidFile + ".supervisor", String(process.pid));
const child = spawn(process.execPath, config.args, { stdio: "inherit" });
fs.writeFileSync(config.pidFile, String(child.pid));
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  fs.writeFileSync(config.statusFile, JSON.stringify({ code, signal }));
  process.exitCode = code ?? 128 + os.constants.signals[signal!];
});
