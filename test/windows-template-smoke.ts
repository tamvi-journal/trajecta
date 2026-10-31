/** Native branch/line coverage with exact plain-vs-traced outcomes. Test copies only. */
import * as fs from "node:fs";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { readTemplate, renderTemplate } from "../product/src/templates.ts";
import { ROOT, temporary, isolatedEnv } from "./support.ts";
import { prewarmWindowsHost } from "./windows-host-a.ts";

export function captureTemplateSmoke() {
  if (process.platform !== "win32") throw new Error("native Windows branch smoke only");
  const root = temporary(),
    bin = join(root, "bin"),
    version = join(root, "0.5.0"),
    marker = join(root, "node-started.json"),
    preload = join(root, "marker.mjs"),
    trace = join(root, "lines.txt"),
    wireReceipt = join(root, "wire.bin"),
    ps = win32.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  fs.mkdirSync(bin);
  fs.mkdirSync(join(version, "product/src"), { recursive: true });
  fs.writeFileSync(join(version, "product/package.json"), '{"type":"module"}\n');
  fs.writeFileSync(
    join(version, "product/src/cli.ts"),
    "console.log(JSON.stringify(process.argv.slice(2)));process.exitCode=Number(process.env.TEST_CMD_CHILD_EXIT);\n",
  );
  fs.writeFileSync(
    preload,
    'import{writeFileSync}from"node:fs";writeFileSync(process.env.TEST_CMD_MARKER,JSON.stringify({pid:process.pid,exe:process.execPath}));\n',
  );
  const aliases = Object.fromEntries(
    ["space", "(", ")", "&"].map((char) => {
      const path = join(root, char === "space" ? "node space.exe" : "node" + char + ".exe");
      fs.copyFileSync(process.execPath, path);
      return [char, path];
    }),
  );
  const env = {
    ...isolatedEnv(root),
    NODE_OPTIONS: "--import=" + pathToFileURL(preload).href,
    TEST_CMD_MARKER: marker,
    TEST_CMD_CHILD_EXIT: "0",
  };
  prewarmWindowsHost(ps, env);
  const results = [],
    coverage = [];
  const resume =
    "trajecta is being uninstalled; resume with the command printed by 'trajecta uninstall', or run the installer bootstrap with --resume-uninstall\r\n";
  for (const mcp of [false, true]) {
    const name = mcp ? "trajecta-mcp.cmd.tmpl" : "trajecta.cmd.tmpl",
      template = readTemplate(name),
      label = mcp ? "smoke-server" : "trajecta",
      args = mcp ? [label, "--engine", "identity", "--"] : ["version"],
      file = join(bin, mcp ? "trajecta-mcp.cmd" : "trajecta.cmd"),
      invalid = `${label}: cannot validate the installation (Windows PowerShell unavailable or blocked)\r\n`,
      ok = (node: string, ver = "0.5.0") => `TRJ1|OK|${ver}|${node}|END\r\n`;
    type Row = {
      id: string;
      wire: string;
      argv?: string[];
      status?: number;
      stdout?: string;
      stderr?: string;
      launched?: boolean;
      childExit?: number;
      legacy?: boolean;
    };
    const rows: Row[] = [
      { id: "zero-records", wire: "" },
      { id: "two-records", wire: "TRJ1|ERR|NODE|END\r\n".repeat(2) },
      { id: "unknown-status", wire: "TRJ1|WHAT|END\r\n" },
      { id: "extra-fields", wire: "TRJ1|ERR|NODE|END|extra|junk\r\n" },
      ...["NOTINSTALLED", "DAMAGED", "NODE", "NODEPATH", "UNKNOWN"].map((reason) => ({
        id: "error-" + reason,
        wire: `TRJ1|ERR|${reason}|END\r\n`,
        stderr:
          reason === "NOTINSTALLED"
            ? `${label}: not installed at ${root}; run the installer\r\n`
            : reason === "DAMAGED"
              ? `${label}: installation at ${root} is damaged; run the installer\r\n`
              : reason === "NODE"
                ? `${label}: need Node 22.19+ or 24 LTS\r\n`
                : reason === "NODEPATH"
                  ? `${label}: the recorded Node path has no usable short form on this system; reinstall with Node at an ASCII path\r\n`
                  : invalid,
      })),
      ...[
        ["identity", "status"],
        ["uninstall", "--resume"],
        ["uninstall", "--status", "extra"],
      ].map((argv, n) => ({
        id: "sentinel-resume-" + n,
        wire: "TRJ1|SENTINEL|END\r\n",
        argv: mcp ? [label, ...argv] : argv,
        stderr: resume,
      })),
      {
        id: "sentinel-status",
        wire: "TRJ1|SENTINEL|END\r\n",
        argv: mcp ? [label, "uninstall", "--status"] : ["uninstall", "--status"],
        status: mcp ? 1 : 3,
        stdout: mcp ? "" : `trajecta: uninstall in progress at ${root}\r\n` + resume,
        stderr: mcp ? resume : "",
      },
      { id: "bad-version", wire: ok(aliases.space, "not-a-version") },
      { id: "relative-node", wire: ok("relative.exe") },
      { id: "noncanonical", wire: `TRJ1|OK||0.5.0|${aliases.space}|END\r\n` },
      ...[
        ["drive", aliases.space],
        ["forward", aliases.space.replaceAll("\\", "/")],
        ["device", "\\\\?\\" + aliases.space],
      ].map(([kind, node]) => ({
        id: "ok-" + kind,
        wire: ok(node),
        status: 0,
        stderr: "",
        launched: true,
      })),
      { id: "ok-child-exit", wire: ok(aliases.space), status: 7, stderr: "", launched: true, childExit: 7 },
      ...["(", ")", "&"].map((char) => ({ id: "forbidden-" + char, wire: ok(aliases[char]) })),
      // RED witness for this regression: the old options must run the forbidden alias.
      { id: "old-dead-guard-control", wire: ok(aliases["("]), legacy: true, launched: true },
    ];
    const seen = new Set<number>();
    for (const row of rows) {
      const script = "[Console]::Out.Write('" + row.wire.replaceAll("'", "''") + "');[Environment]::Exit(0)";
      let source = renderTemplate(name, template, { root, powershell: ps, validator: script });
      if (row.legacy) source = source.replace("0123456789:;", "0123456789 :;").replace("'`~ \" %%X", "'`~\" %%X");
      env.TEST_CMD_CHILD_EXIT = String(row.childExit ?? 0);
      const run = () =>
          spawnSync("cmd.exe", ["/d", "/q", "/c", file, ...(row.argv ?? args)], { cwd: ROOT, env, timeout: 20000 }),
        receipt = (r: ReturnType<typeof run>) => ({
          status: r.status,
          error: r.error?.message ?? null,
          stdout_hex: r.stdout?.toString("hex") ?? null,
          stderr_hex: r.stderr?.toString("hex") ?? null,
        });
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
      fs.writeFileSync(file, source);
      const plain = run(),
        plainMarker = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null;
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
      if (fs.existsSync(trace)) fs.unlinkSync(trace);
      if (fs.existsSync(wireReceipt)) fs.unlinkSync(wireReceipt);
      const lines = source.split("\n"),
        instrumented = lines
          .map((line, i) => {
            if (!line) return line;
            const stamp = `1>>"${trace}" echo TRACE_${i + 1}`;
            let result = line.startsWith(":") || line === "@echo off" ? line + "\n" + stamp : stamp + "\n" + line;
            if (line === "setlocal EnableDelayedExpansion") result += `\n1>"${wireReceipt}" echo(!wire!`;
            return result;
          })
          .join("\n");
      fs.writeFileSync(file, instrumented);
      const traced = run(),
        tracedMarker = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null,
        visited = fs.existsSync(trace)
          ? [...fs.readFileSync(trace, "utf8").matchAll(/TRACE_(\d+)/gu)].map((m) => Number(m[1]))
          : [];
      if (!row.legacy) for (const n of visited) seen.add(n);
      results.push({
        mcp,
        id: row.id,
        wire_hex: Buffer.from(row.wire).toString("hex"),
        legacy: row.legacy ?? false,
        expected_status: row.status ?? 1,
        expected_launched: row.launched ?? false,
        expected_stdout_hex: Buffer.from(
          row.stdout ?? (row.launched ? JSON.stringify(mcp ? ["mcp", ...args] : args) + "\n" : ""),
        ).toString("hex"),
        expected_stderr_hex: Buffer.from(row.stderr ?? invalid).toString("hex"),
        single_record: row.wire.split("\r\n").filter(Boolean).length === 1,
        received_wire_hex: fs.existsSync(wireReceipt) ? fs.readFileSync(wireReceipt).toString("hex") : null,
        plain: receipt(plain),
        traced: receipt(traced),
        plain_marker: plainMarker,
        traced_marker: tracedMarker,
        visited,
      });
    }
    const lines = template.split("\n");
    coverage.push({
      mcp,
      template: name,
      unvisited_lines: lines.flatMap((line, i) => (line && !seen.has(i + 1) ? [{ line: i + 1, source: line }] : [])),
      branches: lines.flatMap((line, i) => (line.startsWith(":") ? [{ label: line, visited: seen.has(i + 1) }] : [])),
      options_audit: lines.flatMap((line, i) => (/^(for|if) /u.test(line) ? [{ line: i + 1, source: line }] : [])),
    });
  }
  return {
    schema: "trajecta.windows-template-smoke/v1",
    node: process.versions.node,
    powershell: ps,
    run_id: process.env.GITHUB_RUN_ID ?? null,
    checkout_sha: process.env.GITHUB_SHA ?? null,
    image_os: process.env.ImageOS ?? null,
    image_version: process.env.ImageVersion ?? null,
    results,
    coverage,
  };
}
