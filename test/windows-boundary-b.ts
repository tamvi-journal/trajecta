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
    status_hex: value.status === null ? null : "0x" + (value.status >>> 0).toString(16).padStart(8, "0"),
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
        realSource = windowsWrapper(root, ps, mcp),
        realEncoded = realSource.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)![1],
        expected = Buffer.from(`TRJ1|ERR|${reason}|END\r\n`),
        script = "[Console]::Out.Write('" + expected.toString("ascii") + "');[Environment]::Exit(0)",
        source = realSource.replace(
          /(-EncodedCommand )[A-Za-z0-9+/=]+/u,
          "$1" + Buffer.from(script, "utf16le").toString("base64"),
        ),
        encoded = source.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)![1],
        args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        env = isolatedEnv(root);
      fs.mkdirSync(bin);
      const file = join(bin, mcp ? "trajecta-mcp.cmd" : "trajecta.cmd");
      // Measure %~dp0 at the REAL wrapper path, without running PowerShell. Keep
      // the exact UTF-16 value rather than inferring its spelling/case from Node.
      const directoryReceipt = join(root, "wrapper-directory.utf16le");
      fs.writeFileSync(
        file,
        `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "TRAJECTA_WRAPPER_DIR=%~dp0"\r\n"${process.execPath}" -e "require('node:fs').writeFileSync(process.argv[1],Buffer.from(process.env.TRAJECTA_WRAPPER_DIR,'utf16le'))" "${directoryReceipt}"\r\nexit /b %errorlevel%\r\n`,
      );
      const directoryProbe = spawnSync("cmd.exe", ["/d", "/q", "/c", file], { cwd: ROOT, env, timeout: 20000 });
      if (directoryProbe.error || directoryProbe.status !== 0 || !fs.existsSync(directoryReceipt))
        throw new Error(
          "cannot measure the real wrapper's TRAJECTA_WRAPPER_DIR: " + JSON.stringify(receipt(directoryProbe)),
        );
      const wrapperDirectoryBytes = fs.readFileSync(directoryReceipt);
      env.TRAJECTA_WRAPPER_DIR = wrapperDirectoryBytes.toString("utf16le");
      fs.writeFileSync(file, realSource);
      // Preserve the failing controlled-row fixture: neither current nor a node
      // record exists. Real validation consequently stops at NOTINSTALLED even
      // for the row whose STUB was instructed to emit NODEPATH. Do not invent a
      // different Node/8.3 setup and call it the same failing fixture.
      const fixture = {
        current_exists: fs.existsSync(join(root, "current")),
        node_record_exists: fs.existsSync(join(root, "0.5.0/node")),
        current_hex: fs.existsSync(join(root, "current"))
          ? fs.readFileSync(join(root, "current")).toString("hex")
          : null,
      };
      const realDirect = spawnSync(ps, [...args.slice(0, -1), realEncoded], { cwd: ROOT, env, timeout: 20000 });
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
      // A TEST-ONLY binary tee observes the host's complete stdout and forwards
      // each Buffer unchanged into FOR /F. Keep the original invocation/result
      // above as a control: a changed outcome means this instrumentation is not
      // evidence for the original failing host-command path.
      const teeScript = join(root, "wire-tee.cjs"),
        rawWireFile = join(root, "parser-received-wire.bin"),
        teeWrapper = join(bin, "wire-tee.cmd");
      fs.writeFileSync(
        teeScript,
        "const fs=require('node:fs');const fd=fs.openSync(process.argv[2],'wx');" +
          "process.stdin.on('data',b=>{fs.writeSync(fd,b);process.stdout.write(b)});" +
          "process.stdin.on('end',()=>fs.closeSync(fd));\n",
      );
      const teeLine = commandLine.replace(
        " 2^>nul`",
        ` 2^>nul ^| "${process.execPath}" "${teeScript}" "${rawWireFile}"\``,
      );
      if (teeLine === commandLine) throw new Error("test tee did not match the original host command");
      fs.writeFileSync(teeWrapper, source.replace(commandLine, teeLine));
      const teeResult = spawnSync("cmd.exe", ["/d", "/q", "/c", teeWrapper, ...argv], {
        cwd: ROOT,
        env,
        timeout: 20000,
      });
      const rawWire = fs.existsSync(rawWireFile) ? fs.readFileSync(rawWireFile) : null;
      // Isolate argument transport: a test-only host stand-in records argv[5]
      // (the Base64 payload) through direct cmd and the identical FOR command.
      // This never substitutes a host in production or any conformance assertion.
      // Batch %~5 expansion is not native executable argv: this shim alone cannot
      // establish what powershell.exe received (both probe paths can lose '=').
      const argHost = join(bin, "argument-observer.cmd"),
        argFile = join(root, "encoded-argument.bin"),
        argWrapper = join(bin, "argument-wrapper.cmd");
      fs.writeFileSync(argHost, `@echo off\r\n1>"${argFile}" echo(%~5\r\nexit /b 0\r\n`);
      const argDirect = spawnSync("cmd.exe", ["/d", "/q", "/c", argHost, ...args], {
        cwd: ROOT,
        env,
        timeout: 20000,
      });
      const directArg = fs.existsSync(argFile) ? fs.readFileSync(argFile).toString("hex") : null;
      if (fs.existsSync(argFile)) fs.unlinkSync(argFile);
      fs.writeFileSync(
        argWrapper,
        source.replace(ps, () => argHost),
      );
      const argViaFor = spawnSync("cmd.exe", ["/d", "/q", "/c", argWrapper, ...argv], {
        cwd: ROOT,
        env,
        timeout: 20000,
      });
      const forArg = fs.existsSync(argFile) ? fs.readFileSync(argFile).toString("hex") : null;
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
      else if (capture.count_hex !== "310d0a" || capture.wire_hex !== expected.toString("hex"))
        classification = "b: command-host path emitted extra/different output before record validation";
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
        fixture,
        wrapper_directory: {
          measured_at: file,
          cmd_percent_dp0_utf16le_hex: wrapperDirectoryBytes.toString("hex"),
          direct_env_utf16le_hex: Buffer.from(env.TRAJECTA_WRAPPER_DIR, "utf16le").toString("hex"),
          directory_probe: receipt(directoryProbe),
        },
        real_validator_direct: {
          ...receipt(realDirect),
          executable: ps,
          encoded_command: realEncoded,
          encoded_bytes_sha256: createHash("sha256").update(realEncoded, "ascii").digest("hex"),
          fixture_expected_record: "TRJ1|ERR|NOTINSTALLED|END\\r\\n (current is absent)",
        },
        direct_kind: "controlled stub, not the real validator",
        direct: receipt(direct),
        wrapped: receipt(wrapped),
        file_parser_control: receipt(parsed),
        observed_capture: { ...capture, result: receipt(observed) },
        controlled_frame_tee: {
          intended_wire_hex: expected.toString("hex"),
          directly_emitted_stub_wire_hex: direct.stdout?.toString("hex") ?? null,
          parser_received_raw_hex: rawWire?.toString("hex") ?? null,
          parser_received_raw_sha256: rawWire ? createHash("sha256").update(rawWire).digest("hex") : null,
          wire_byte_for_byte_equal: rawWire?.equals(expected) ?? false,
          exact_encoded_bytes_unchanged: teeLine.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)?.[1] === encoded,
          original_host_command_line: commandLine,
          tee_host_command_line: teeLine,
          result: receipt(teeResult),
          same_result_as_original:
            teeResult.status === wrapped.status &&
            teeResult.stdout?.equals(wrapped.stdout) &&
            teeResult.stderr?.equals(wrapped.stderr),
        },
        encoded_argument_probe: {
          limitation: "batch parameter expansion is not native-executable argv",
          expected_hex: Buffer.from(encoded + "\r\n").toString("hex"),
          direct_hex: directArg,
          via_for_hex: forArg,
          direct_result: receipt(argDirect),
          via_for_result: receipt(argViaFor),
        },
        file_parser_record_sha256: createHash("sha256").update(fs.readFileSync(frame)).digest("hex"),
        classification,
      });
    }
  return {
    schema: "trajecta.windows-boundary-b/v1",
    probe_revision: 2,
    node: process.versions.node,
    provenance: {
      run_id: process.env.GITHUB_RUN_ID ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      checkout_sha: process.env.GITHUB_SHA ?? null,
      image_os: process.env.ImageOS ?? null,
      image_version: process.env.ImageVersion ?? null,
      runner_os: process.env.RUNNER_OS ?? null,
      runner_arch: process.env.RUNNER_ARCH ?? null,
    },
    results,
  };
}
