/** Native §13.8 acceptance; controlled NODEPATH is not the open real 8.3-disabled gate. */
import * as fs from "node:fs";
import { join, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { windowsWrapper } from "../product/src/wrappers.ts";
import { windowsValidator } from "../product/src/windows-validator.ts";
import { readTemplate, renderTemplate } from "../product/src/templates.ts";
import { ROOT, temporary, isolatedEnv, tree } from "./support.ts";
import { prewarmWindowsHost } from "./windows-host-a.ts";

export function capturePaddingM5() {
  if (process.platform !== "win32") throw new Error("native Windows acceptance only");
  const base = temporary(),
    env = isolatedEnv(base),
    ps = win32.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const results = [];
  for (const originalClass of [0, 1, 2]) {
    const root = [1, 2, 3]
      .map((n) => join(base, "r".repeat(n)))
      .find((root) => {
        const value = Buffer.from(windowsValidator(root), "utf16le").toString("base64");
        return value.length - value.replace(/=+$/u, "").length === originalClass;
      })!;
    const bin = join(root, "bin"),
      version = join(root, "0.5.0");
    fs.mkdirSync(join(version, "product/src"), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(join(version, "product/package.json"), '{"type":"module"}\n');
    fs.writeFileSync(join(version, "node"), process.execPath + "\n");
    fs.writeFileSync(join(version, "product/src/cli.ts"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
    for (const mcp of [false, true])
      for (const kind of ["real-notinstalled", "controlled-nodepath", "real-ok"]) {
        const current = join(root, "current");
        if (fs.existsSync(current)) fs.unlinkSync(current);
        if (kind === "real-ok") fs.writeFileSync(current, "0.5.0\n\n");
        const label = mcp ? "m5-server" : "trajecta",
          args = mcp ? [label, "--engine", "identity", "--"] : ["version"],
          file = join(bin, mcp ? "trajecta-mcp.cmd" : "trajecta.cmd"),
          name = mcp ? "trajecta-mcp.cmd.tmpl" : "trajecta.cmd.tmpl",
          script =
            kind === "controlled-nodepath"
              ? '[Console]::Out.Write("TRJ1|ERR|NODEPATH|END`r`n");[Environment]::Exit(0)'
              : windowsValidator(root),
          source =
            kind === "controlled-nodepath"
              ? renderTemplate(name, readTemplate(name), { root, powershell: ps, validator: script })
              : windowsWrapper(root, ps, mcp),
          encoded = source.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)![1];
        fs.writeFileSync(file, source);
        prewarmWindowsHost(ps, env);
        const before = tree(base),
          run = () => spawnSync("cmd.exe", ["/d", "/q", "/c", file, ...args], { cwd: ROOT, env, timeout: 20000 }),
          plain = run(),
          after = tree(base),
          countFile = join(root, "m5-count.bin"),
          firstFile = join(root, "m5-first.bin");
        for (const path of [countFile, firstFile]) if (fs.existsSync(path)) fs.unlinkSync(path);
        fs.writeFileSync(
          file,
          source
            .replace('set "count=0"\n', 'set "count=0"\nset "__M5_FIRST="\n')
            .replace('set "wire=%%L"\n', 'set "wire=%%L"\nif not defined __M5_FIRST set "__M5_FIRST=%%L"\n')
            .replace(
              "setlocal EnableDelayedExpansion\n",
              `setlocal EnableDelayedExpansion\n1>"${countFile}" echo(!count!\n1>"${firstFile}" echo(!__M5_FIRST!\n`,
            ),
        );
        const observed = run(),
          receipt = (r: typeof plain) => ({
            status: r.status,
            error: r.error?.message ?? null,
            stdout_hex: r.stdout?.toString("hex") ?? null,
            stderr_hex: r.stderr?.toString("hex") ?? null,
          });
        const record =
            kind === "real-ok"
              ? `TRJ1|OK|0.5.0|${process.execPath}|END\r\n`
              : kind === "real-notinstalled"
                ? "TRJ1|ERR|NOTINSTALLED|END\r\n"
                : "TRJ1|ERR|NODEPATH|END\r\n",
          error =
            kind === "real-ok"
              ? ""
              : kind === "real-notinstalled"
                ? `${label}: not installed at ${root}; run the installer\r\n`
                : `${label}: the recorded Node path has no usable short form on this system; reinstall with Node at an ASCII path\r\n`;
        results.push({
          original_root_padding: originalClass,
          root,
          mcp,
          kind,
          encoded,
          script_utf16le_sha256: createHash("sha256").update(Buffer.from(script, "utf16le")).digest("hex"),
          count_hex: fs.existsSync(countFile) ? fs.readFileSync(countFile).toString("hex") : null,
          first_line_hex: fs.existsSync(firstFile) ? fs.readFileSync(firstFile).toString("hex") : null,
          expected_record_hex: Buffer.from(record).toString("hex"),
          expected_status: kind === "real-ok" ? 0 : 1,
          expected_stdout_hex:
            kind === "real-ok" ? Buffer.from(JSON.stringify(mcp ? ["mcp", ...args] : args) + "\n").toString("hex") : "",
          expected_stderr_hex: Buffer.from(error).toString("hex"),
          plain: receipt(plain),
          observed: receipt(observed),
          tree_unchanged: JSON.stringify(before) === JSON.stringify(after),
          tree_difference: JSON.stringify(before) === JSON.stringify(after) ? null : { before, after },
        });
      }
  }
  return {
    schema: "trajecta.windows-padding-m5/v1",
    node: process.versions.node,
    powershell: ps,
    run_id: process.env.GITHUB_RUN_ID ?? null,
    checkout_sha: process.env.GITHUB_SHA ?? null,
    image_os: process.env.ImageOS ?? null,
    image_version: process.env.ImageVersion ?? null,
    results,
    real_8dot3_disabled_nodepath: "OPEN; controlled row is not real acceptance",
  };
}
