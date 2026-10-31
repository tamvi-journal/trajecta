/** B-only diagnostics. No pre-warm law or unchanged-tree assertion is implemented here. */
import * as fs from "node:fs";
import { join, win32 } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { temporary, isolatedEnv, ROOT } from "./support.ts";
import { windowsWrapper } from "../product/src/wrappers.ts";

function receipt(value: SpawnSyncReturns<Buffer>) {
  return {
    status: value.status,
    signal: value.signal,
    error: value.error ? { name: value.error.name, message: value.error.message } : null,
    stdout_hex: value.stdout?.toString("hex") ?? null,
    stderr_hex: value.stderr?.toString("hex") ?? null,
  };
}
export function captureWindowsBoundaryB() {
  if (process.platform !== "win32") throw new Error("native Windows diagnostic only");
  const results = [];
  for (const mcp of [false, true])
    for (const reason of ["NOTINSTALLED", "NODEPATH"]) {
      const root = temporary(),
        bin = join(root, "bin"),
        ps = win32.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        label = mcp ? "exact-server" : "trajecta",
        expected = Buffer.from(`TRJ1|ERR|${reason}|END\r\n`),
        script = "[Console]::Out.Write('" + expected.toString("ascii") + "');[Environment]::Exit(0)",
        source = windowsWrapper(root, ps, mcp).replace(
          /(-EncodedCommand )[A-Za-z0-9+/=]+/u,
          "$1" + Buffer.from(script, "utf16le").toString("base64"),
        ),
        encoded = source.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)![1],
        args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        env = { ...isolatedEnv(root), TRAJECTA_WRAPPER_DIR: bin + win32.sep };
      fs.mkdirSync(bin);
      const file = join(bin, mcp ? "trajecta-mcp.cmd" : "trajecta.cmd");
      fs.writeFileSync(file, source);
      // This is the SAME encoded command extracted from the failing fixture's wrapper,
      // run directly. Its host effects are diagnostic data, never a baseline exclusion.
      const direct = spawnSync(ps, args, { cwd: ROOT, env, timeout: 20000 });
      const argv = mcp ? [label, "--engine", "identity", "--"] : ["version"];
      const wrapped = spawnSync("cmd.exe", ["/d", "/q", "/c", file, ...argv], {
        cwd: ROOT,
        env,
        timeout: 20000,
      });
      // A literal-file control feeds identical, verified bytes to the unmodified cmd
      // parser. No PowerShell host runs here; this distinguishes a parser rejection.
      const frame = join(root, "frame.bin"),
        control = join(bin, "frame-control.cmd"),
        commandLine = source.split("\n").find((line) => line.startsWith('for /f "usebackq'))!;
      fs.writeFileSync(frame, expected);
      const controlLine = 'for /f "usebackq delims= eol=`" %%L in ("' + frame + '") do (';
      fs.writeFileSync(control, source.replace(commandLine, controlLine));
      const parsed = spawnSync("cmd.exe", ["/d", "/q", "/c", control, ...argv], {
        cwd: ROOT,
        env,
        timeout: 20000,
      });
      // Observe the actual FOR /F capture before any record validation. These two
      // writes are diagnostic-only and do not enter an unchanged-tree assertion.
      const countFile = join(root, "capture-count.bin"),
        wireFile = join(root, "capture-wire.bin"),
        observedFile = join(bin, "capture-observer.cmd");
      fs.writeFileSync(
        observedFile,
        source.replace(
          "setlocal EnableDelayedExpansion\n",
          `setlocal EnableDelayedExpansion\n1>"${countFile}" echo(!count!\n1>"${wireFile}" echo(!wire!\n`,
        ),
      );
      const observed = spawnSync("cmd.exe", ["/d", "/q", "/c", observedFile, ...argv], {
        cwd: ROOT,
        env,
        timeout: 20000,
      });
      const capture = {
        count_hex: fs.existsSync(countFile) ? fs.readFileSync(countFile).toString("hex") : null,
        wire_hex: fs.existsSync(wireFile) ? fs.readFileSync(wireFile).toString("hex") : null,
      };
      const message =
        reason === "NOTINSTALLED"
          ? `${label}: not installed at ${root}; run the installer\r\n`
          : `${label}: the recorded Node path has no usable short form on this system; reinstall with Node at an ASCII path\r\n`;
      const accepted = (value: SpawnSyncReturns<Buffer>) =>
        !value.error && value.status === 1 && value.stdout?.length === 0 && value.stderr?.equals(Buffer.from(message));
      const raw = direct.stdout ?? Buffer.alloc(0);
      let classification: string;
      if (
        direct.error ||
        direct.status !== 0 ||
        direct.stderr?.length ||
        !/^TRJ1\|[^\r\n]*\|END\r\n$/u.test(raw.toString("ascii"))
      )
        classification = "b: host failure or extra output";
      else if (!raw.equals(expected)) classification = "a: validator emits a different record";
      else if (!accepted(parsed)) classification = "c: cmd parser rejects a correct record";
      else if (!accepted(wrapped))
        classification = "unclassified: direct record and file-parser control pass; inspect host-command capture";
      else classification = "not reproduced: direct record, file parser and wrapped result agree";
      results.push({
        wrapper: mcp ? "mcp" : "cli",
        reason,
        root,
        powershell: ps,
        flags: args.slice(0, -1),
        encoded_command: encoded,
        decoded_script_utf16le_hex: Buffer.from(encoded, "base64").toString("hex"),
        expected_record_hex: expected.toString("hex"),
        expected_message_hex: Buffer.from(message).toString("hex"),
        same_environment: true,
        direct: receipt(direct),
        wrapped: receipt(wrapped),
        file_parser_control: receipt(parsed),
        observed_capture: { ...capture, result: receipt(observed) },
        file_parser_record_sha256: createHash("sha256").update(fs.readFileSync(frame)).digest("hex"),
        classification,
      });
    }
  return { schema: "trajecta.windows-boundary-b/v1", node: process.versions.node, results };
}
