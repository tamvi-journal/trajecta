/** Test-only transport bisection. No candidate is installed or used by production. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { join, win32 } from "node:path";
import { windowsWrapper } from "../product/src/wrappers.ts";
import { ROOT, temporary, isolatedEnv } from "./support.ts";

function receipt(r: SpawnSyncReturns<Buffer>) {
  return {
    status: r.status,
    status_hex: r.status === null ? null : "0x" + (r.status >>> 0).toString(16).padStart(8, "0"),
    signal: r.signal,
    error: r.error?.message ?? null,
    stdout_hex: r.stdout?.toString("hex") ?? null,
    stderr_hex: r.stderr?.toString("hex") ?? null,
  };
}

export function captureWindowsBisectionB() {
  assert.equal(process.platform, "win32");
  const root = temporary(),
    bin = join(root, "bin"),
    file = join(bin, "trajecta.cmd");
  fs.mkdirSync(bin);
  const ps = win32.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    flags = ["-NoLogo", "-NoProfile", "-NonInteractive"],
    env = isolatedEnv(root),
    template = windowsWrapper(root, ps, false),
    realEncoded = template.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)![1],
    realScript = Buffer.from(realEncoded, "base64").toString("utf16le");
  // Measure the exact native %~dp0 rather than infer its spelling from Node.
  const dirReceipt = join(root, "wrapper-dir.utf16le");
  fs.writeFileSync(
    file,
    `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "TRAJECTA_WRAPPER_DIR=%~dp0"\r\n"${process.execPath}" -e "require('node:fs').writeFileSync(process.argv[1],Buffer.from(process.env.TRAJECTA_WRAPPER_DIR,'utf16le'))" "${dirReceipt}"\r\nexit /b %errorlevel%\r\n`,
  );
  const runCmd = () => spawnSync("cmd.exe", ["/d", "/q", "/c", file, "version"], { cwd: ROOT, env, timeout: 20000 });
  const dirProbe = runCmd();
  assert.equal(dirProbe.status, 0, JSON.stringify(receipt(dirProbe)));
  env.TRAJECTA_WRAPPER_DIR = fs.readFileSync(dirReceipt).toString("utf16le");

  function run(script: string, shape = "template") {
    const encoded = Buffer.from(script, "utf16le").toString("base64"),
      source = template.replace(realEncoded, () => encoded),
      line = source.split("\n").find((l) => l.startsWith('for /f "usebackq'))!,
      prefix = 'for /f "usebackq delims= eol=`" %%L in (`',
      suffix = "`) do (";
    assert(line.startsWith(prefix) && line.endsWith(suffix));
    const inner = line.slice(prefix.length, -suffix.length);
    let changed = line;
    if (shape === "without-stderr-redirection") changed = line.replace(" 2^>nul", "");
    if (shape === "single-quote-command") changed = 'for /f "delims= eol=~" %%L in (\'' + inner + "') do (";
    if (shape === "unquoted-executable") changed = line.replace('"' + ps + '"', ps);
    const countFile = join(root, "count.bin"),
      firstFile = join(root, "first.bin"),
      lastFile = join(root, "last.bin");
    for (const path of [countFile, firstFile, lastFile]) if (fs.existsSync(path)) fs.unlinkSync(path);
    if (shape === "outside-for") {
      fs.writeFileSync(
        file,
        '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "TRAJECTA_WRAPPER_DIR=%~dp0"\r\n' +
          inner.replace("2^>nul", "2>nul") +
          "\r\nexit /b %errorlevel%\r\n",
      );
    } else {
      fs.writeFileSync(
        file,
        source
          .replace(line, () => changed)
          .replace('set "count=0"\n', 'set "count=0"\nset "__B_FIRST="\n')
          .replace('set "wire=%%L"\n', 'set "wire=%%L"\nif not defined __B_FIRST set "__B_FIRST=%%L"\n')
          .replace(
            "setlocal EnableDelayedExpansion\n",
            `setlocal EnableDelayedExpansion\n1>"${countFile}" echo(!count!\n1>"${firstFile}" echo(!__B_FIRST!\n1>"${lastFile}" echo(!wire!\n`,
          ),
      );
    }
    const result = runCmd();
    const plainLines = (result.stdout ?? Buffer.alloc(0))
      .toString("ascii")
      .split(/\r?\n/u)
      .filter((l) => l && !l.startsWith("`"));
    const countHex =
        shape === "outside-for" ? null : fs.existsSync(countFile) ? fs.readFileSync(countFile).toString("hex") : null,
      first =
        shape === "outside-for"
          ? Buffer.from((plainLines[0] ?? "") + "\r\n")
          : fs.existsSync(firstFile)
            ? fs.readFileSync(firstFile)
            : null,
      last =
        shape === "outside-for"
          ? Buffer.from((plainLines.at(-1) ?? "") + "\r\n")
          : fs.existsSync(lastFile)
            ? fs.readFileSync(lastFile)
            : null;
    return {
      shape,
      utf16le_bytes: Buffer.byteLength(script, "utf16le"),
      base64_chars: encoded.length,
      base64_padding: encoded.length - encoded.replace(/=+$/u, "").length,
      script_utf16le_sha256: createHash("sha256").update(Buffer.from(script, "utf16le")).digest("hex"),
      for_command_line: shape === "outside-for" ? null : changed,
      direct_command_line: shape === "outside-for" ? inner.replace("2^>nul", "2>nul") : null,
      count:
        shape === "outside-for"
          ? plainLines.length
          : countHex
            ? Number(Buffer.from(countHex, "hex").toString("ascii").trim())
            : null,
      count_hex: countHex,
      first_line_hex: first?.toString("hex") ?? null,
      last_line_hex: last?.toString("hex") ?? null,
      usage_appeared:
        !!first?.toString("ascii").startsWith("PowerShell[.exe]") ||
        !!last?.toString("ascii").includes("powershell.exe -encodedCommand $encodedCommand"),
      result: receipt(result),
    };
  }
  // No output and no filesystem/store effects: only a comment changes size.
  // Choose neighboring no-padding lengths so padding cannot confound size.
  const sizes = [100, 1000, 2000, 4000, 6000, 6800, 7500].map((target) => {
    let chars = Math.max(9, Math.round((target * 3) / 8));
    while (chars % 3) chars++;
    const script = "exit 0;#" + "x".repeat(chars - 8);
    return { target, script, observation: run(script) };
  });
  const selected = sizes.find((row) => row.observation.usage_appeared) ?? sizes.find((row) => row.target === 6800)!;
  const shapes = [
    "template",
    "outside-for",
    "without-stderr-redirection",
    "single-quote-command",
    "unquoted-executable",
  ];
  const noopShapes = shapes.map((shape) => run(selected.script, shape));
  const realShapes = shapes.map((shape) => run(realScript, shape));
  // Identical decoded source through stdin, for diagnosis only; never a design seam.
  const stdin = Buffer.from(realScript, "utf8");
  const realStdin = spawnSync(ps, [...flags, "-Command", "-"], { cwd: ROOT, env, input: stdin, timeout: 20000 });
  const realDirect = spawnSync(ps, [...flags, "-EncodedCommand", realEncoded], { cwd: ROOT, env, timeout: 20000 });
  return {
    schema: "trajecta.windows-bisection-b/v1",
    node: process.versions.node,
    powershell: ps,
    flags,
    root,
    wrapper_directory_utf16le_hex: Buffer.from(env.TRAJECTA_WRAPPER_DIR, "utf16le").toString("hex"),
    provenance: {
      run_id: process.env.GITHUB_RUN_ID ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      checkout_sha: process.env.GITHUB_SHA ?? null,
      image_os: process.env.ImageOS ?? null,
      image_version: process.env.ImageVersion ?? null,
    },
    sizes,
    selected_size_reason: sizes.some((r) => r.observation.usage_appeared)
      ? "first observed usage"
      : "no usage observed; requested 6800 reference",
    selected_target: selected.target,
    noop_shapes: noopShapes,
    real_shapes: realShapes,
    real_validator: {
      source_utf16le_hex: Buffer.from(realScript, "utf16le").toString("hex"),
      encoded: realEncoded,
      stdin_utf8_hex: stdin.toString("hex"),
      stdin: receipt(realStdin),
      direct_encoded: receipt(realDirect),
    },
  };
}
