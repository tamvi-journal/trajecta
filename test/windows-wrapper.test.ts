import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ROOT, temporary, isolatedEnv, tree } from "./support.ts";

const path = new URL("../product/src/wrappers.ts", import.meta.url);
const subject = fs.existsSync(path) ? await import(path.href) : null;
const systemPS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

test("Windows encoded validator fits the 240-character non-ASCII root without truncation", () => {
  assert(subject, "native wrapper renderer is not implemented");
  const root = "C:\\" + "界".repeat(237);
  assert.equal(root.length, 240);
  const wrapper = subject.windowsWrapper(root, systemPS, false);
  const line = wrapper.split(/\r?\n/u).find((line: string) => line.includes("-EncodedCommand"));
  assert(line);
  assert(line.length <= 8000, `encoded invocation is ${line.length} characters`);
  const source = Buffer.from(line.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)![1], "base64").toString("utf16le");
  assert.equal(source.split(root).length - 1, 1, "root appears once in the embedded script");
  assert(wrapper.includes('set "TRAJECTA_WRAPPER_DIR=%~dp0"'));
  assert(!wrapper.includes("%SystemRoot%"));
  assert(!wrapper.includes("%PATH%"));
  assert.throws(() => subject.windowsWrapper("C:\\" + "界".repeat(4000), systemPS, false), /8000/u);
});

test("Windows wrapper rejects current reparse before sentinel, preserves LF byte grammar and inserts mcp", (t) => {
  if (process.platform !== "win32") return t.skip("real Windows native contract job");
  assert(subject, "native wrapper renderer is not implemented");
  const root = temporary(),
    bin = join(root, "bin"),
    version = join(root, "0.5.0");
  fs.mkdirSync(bin);
  fs.mkdirSync(version);
  fs.writeFileSync(join(root, "current"), "0.5.0\n\n");
  fs.writeFileSync(join(version, "node"), process.execPath + "\n");
  fs.mkdirSync(join(version, "product/src"), { recursive: true });
  fs.writeFileSync(join(version, "product/package.json"), '{"type":"module"}\n');
  fs.writeFileSync(join(version, "product/src/cli.ts"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const ps = win32.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  for (const mcp of [false, true]) {
    const file = join(bin, mcp ? "trajecta-mcp.cmd" : "trajecta.cmd");
    fs.writeFileSync(file, subject.windowsWrapper(root, ps, mcp));
    const args = mcp ? ["label", "--engine", "identity", "--", "--profile", "example"] : ["version"];
    const run = () =>
      spawnSync("cmd.exe", ["/d", "/q", "/c", file, ...args], {
        cwd: root,
        env: isolatedEnv(root),
        encoding: "utf8",
        timeout: 20000,
      });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), mcp ? ["mcp", ...args] : args);
    for (const end of ["\r", "\0", "\r\n", ""]) {
      fs.writeFileSync(join(version, "node"), process.execPath + end);
      result = run();
      assert.equal(result.status, 1, JSON.stringify(result));
      assert.equal(
        result.stderr,
        `${mcp ? "label" : "trajecta"}: installation at ${root} is damaged; run the installer\r\n`,
      );
      assert.equal(result.stdout, "");
    }
    fs.writeFileSync(join(version, "node"), process.execPath + "\n");
    fs.writeFileSync(join(root, "sentinel"), "uninstalling\n");
    fs.unlinkSync(join(root, "current"));
    fs.symlinkSync(join(root, "sentinel"), join(root, "current"), "file");
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is damaged/u);
    fs.unlinkSync(join(root, "current"));
    fs.writeFileSync(join(root, "current"), "0.5.0\n\n");
  }
});

test("Windows cmd canonical reconstruction rejects every observable malformed framing; only blank/backtick lines are unobservable", (t) => {
  if (process.platform !== "win32") return t.skip("real Windows native contract job");
  const root = temporary(),
    bin = join(root, "bin"),
    version = join(root, "0.5.0");
  fs.mkdirSync(bin);
  fs.mkdirSync(join(version, "product/src"), { recursive: true });
  fs.writeFileSync(join(version, "product/package.json"), '{"type":"module"}\n');
  fs.writeFileSync(join(version, "product/src/cli.ts"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const ps = win32.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const good = `TRJ1|OK|0.5.0|${process.execPath}|END\r\n`;
  const malformed = [
    "",
    ";extra\r\n" + good,
    "|junk\r\n" + good,
    good + good,
    "TRJ1|ERR|NODE|extra|END\r\n",
    "TRJ1|ERR|END\r\n",
    "TRJ1|ERR|NODE\r\n",
    "BAD|ERR|NODE|END\r\n",
    `TRJ1|OK||0.5.0|${process.execPath}|END\r\n`,
    good.trimEnd() + "|\r\n",
    "|" + good,
    "TRJ1|unknown|END\r\n",
    "TRJ1|ERR|OTHER|END\r\n",
    "TRJ1|SENTINEL|extra|END\r\n",
  ];
  for (const mcp of [false, true]) {
    const file = join(bin, mcp ? "trajecta-mcp.cmd" : "trajecta.cmd"),
      template = subject.windowsWrapper(root, ps, mcp);
    const args = mcp ? ["configured-label", "--engine", "identity", "--"] : ["version"];
    const stub = (record: string) => {
      const script = "[Console]::Out.Write('" + record.replaceAll("'", "''") + "');[Environment]::Exit(0)";
      fs.writeFileSync(
        file,
        template.replace(
          /(-EncodedCommand )[A-Za-z0-9+/=]+/u,
          "$1" + Buffer.from(script, "utf16le").toString("base64"),
        ),
      );
    };
    for (const record of malformed) {
      stub(record);
      const before = tree(root);
      const r = spawnSync("cmd.exe", ["/d", "/q", "/c", file, ...args], {
        env: isolatedEnv(root),
        encoding: "utf8",
        timeout: 20000,
      });
      assert.equal(r.status, 1, JSON.stringify({ record, stdout: r.stdout, stderr: r.stderr }));
      assert.equal(r.stdout, "");
      assert.equal(
        r.stderr,
        `${mcp ? "configured-label" : "trajecta"}: cannot validate the installation (Windows PowerShell unavailable or blocked)\r\n`,
      );
      assert.deepEqual(tree(root), before);
    }
    for (const extra of ["", "\r\n", "`unobservable\r\n"]) {
      stub(extra + good);
      const r = spawnSync("cmd.exe", ["/d", "/q", "/c", file, ...args], {
        env: isolatedEnv(root),
        encoding: "utf8",
        timeout: 20000,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), mcp ? ["mcp", ...args] : args);
    }
  }
});

test("Windows all pointer rows precede Node; status has exact arity; moved cmd and missing/CLM PowerShell fail closed", (t) => {
  if (process.platform !== "win32") return t.skip("real Windows native contract job");
  const root = temporary(),
    bin = join(root, "bin"),
    version = join(root, "0.5.0");
  fs.mkdirSync(bin);
  fs.mkdirSync(version);
  fs.writeFileSync(join(version, "node"), "C:\\missing\\node.exe\n");
  const ps = win32.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const resume =
    "trajecta is being uninstalled; resume with the command printed by 'trajecta uninstall', or run the installer bootstrap with --resume-uninstall\r\n";
  for (const mcp of [false, true]) {
    const file = join(bin, mcp ? "trajecta-mcp.cmd" : "trajecta.cmd"),
      template = subject.windowsWrapper(root, ps, mcp),
      label = mcp ? "server-A" : "trajecta";
    fs.writeFileSync(file, template);
    const args = mcp ? [label] : ["version"];
    const run = (a = args, env = isolatedEnv(root)) =>
      spawnSync("cmd.exe", ["/d", "/q", "/c", file, ...a], { env, encoding: "utf8", timeout: 20000 });
    const absent = run();
    assert.equal(absent.status, 1);
    assert.equal(absent.stderr, `${label}: not installed at ${root}; run the installer\r\n`);
    for (const bytes of [
      "../x\n\n",
      "C:\\outside\n\n",
      "\\outside\n\n",
      "",
      "0.5.0\n",
      "0.5.0\n\nextra\n",
      "0.5.0\r\n\r\n",
      "x".repeat(257),
      "0.5.0\n\0\n",
    ]) {
      fs.writeFileSync(join(root, "current"), bytes);
      const before = tree(root);
      const r = run();
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "");
      assert.equal(r.stderr, `${label}: installation at ${root} is damaged; run the installer\r\n`);
      assert.deepEqual(tree(root), before);
    }
    fs.writeFileSync(join(root, "current"), "uninstalling\n");
    for (const a of [
      ["uninstall", "--resume"],
      ["uninstall", "--status", "extra"],
      ["identity", "status"],
    ]) {
      const r = run(mcp ? [label, ...a] : a);
      assert.equal(r.status, 1);
      assert.equal(r.stderr, resume);
      assert.equal(r.stdout, "");
    }
    const status = run(mcp ? [label, "uninstall", "--status"] : ["uninstall", "--status"]);
    assert.equal(status.status, mcp ? 1 : 3);
    assert.equal(
      mcp ? status.stderr : status.stdout,
      mcp ? resume : `trajecta: uninstall in progress at ${root}\r\n` + resume,
    );
    fs.writeFileSync(join(root, "current"), "0.5.0\n\n");
    let r = run();
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `${label}: need Node 22.19+ or 24 LTS\r\n`);
    const moved = join(temporary(), "moved.cmd");
    fs.writeFileSync(moved, template);
    r = spawnSync("cmd.exe", ["/d", "/q", "/c", moved, ...args], {
      env: isolatedEnv(root),
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is damaged/);
    const source = Buffer.from(template.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)![1], "base64").toString("utf16le");
    const clm = "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';" + source;
    fs.writeFileSync(
      file,
      template.replace(/(-EncodedCommand )[A-Za-z0-9+/=]+/u, "$1" + Buffer.from(clm, "utf16le").toString("base64")),
    );
    r = run();
    assert.equal(r.status, 1);
    assert.equal(
      r.stderr,
      `${label}: cannot validate the installation (Windows PowerShell unavailable or blocked)\r\n`,
    );
    fs.writeFileSync(file, subject.windowsWrapper(root, join(root, "missing-powershell.exe"), mcp));
    r = run();
    assert.equal(r.status, 1);
    assert.equal(
      r.stderr,
      `${label}: cannot validate the installation (Windows PowerShell unavailable or blocked)\r\n`,
    );
    fs.writeFileSync(file, template);
    fs.unlinkSync(join(root, "current"));
  }
});

test("Windows every refusal branch emits exact CRLF bytes with no trailing space or store writes", (t) => {
  if (process.platform !== "win32") return t.skip("real Windows native contract job");
  const root = temporary(),
    bin = join(root, "bin"),
    failures: string[] = [];
  fs.mkdirSync(bin);
  const ps = win32.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const resume =
    "trajecta is being uninstalled; resume with the command printed by 'trajecta uninstall', or run the installer bootstrap with --resume-uninstall";
  for (const mcp of [false, true]) {
    const label = mcp ? "exact-server" : "trajecta",
      file = join(bin, mcp ? "trajecta-mcp.cmd" : "trajecta.cmd");
    const cases = [
      ["ERR|NOTINSTALLED", `${label}: not installed at ${root}; run the installer`],
      ["ERR|DAMAGED", `${label}: installation at ${root} is damaged; run the installer`],
      ["ERR|NODE", `${label}: need Node 22.19+ or 24 LTS`],
      [
        "ERR|NODEPATH",
        `${label}: the recorded Node path has no usable short form on this system; reinstall with Node at an ASCII path`,
      ],
      ["ERR|UNKNOWN", `${label}: cannot validate the installation (Windows PowerShell unavailable or blocked)`],
      ["SENTINEL", resume],
    ];
    for (const [body, expected] of cases) {
      const record = `TRJ1|${body}|END\r\n`,
        script = "[Console]::Out.Write('" + record + "');[Environment]::Exit(0)";
      fs.writeFileSync(
        file,
        subject
          .windowsWrapper(root, ps, mcp)
          .replace(/(-EncodedCommand )[A-Za-z0-9+/=]+/u, "$1" + Buffer.from(script, "utf16le").toString("base64")),
      );
      const before = tree(root);
      const result = spawnSync(
        "cmd.exe",
        ["/d", "/q", "/c", file, ...(mcp ? [label, "--engine", "identity", "--"] : ["version"])],
        { env: isolatedEnv(root), timeout: 20000 },
      );
      try {
        assert.equal(result.status, 1);
        assert.deepEqual(result.stdout, Buffer.alloc(0));
        assert.deepEqual(result.stderr, Buffer.from(expected + "\r\n"));
        assert.deepEqual(tree(root), before);
      } catch (error) {
        failures.push(`${label}/${body}: ${(error as Error).message}`);
      }
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("Windows B diagnostic captures raw direct encoded-command output and an exact-record parser control", async (t) => {
  if (process.platform !== "win32") return t.skip("real Windows native diagnostic");
  const { captureWindowsBoundaryB } = await import("./windows-boundary-b.ts");
  const report = captureWindowsBoundaryB();
  assert.equal(report.results.length, 4);
  fs.mkdirSync(join(ROOT, "dist"), { recursive: true });
  fs.writeFileSync(join(ROOT, "dist/windows-boundary-b.json"), JSON.stringify(report, null, 2) + "\n");
  for (const row of report.results) t.diagnostic("BOUNDARY_B " + JSON.stringify(row));
  for (const row of report.results) {
    assert.equal(row.wrapper_directory.cmd_percent_dp0_utf16le_hex, row.wrapper_directory.direct_env_utf16le_hex);
    assert.equal(row.controlled_frame_tee.exact_encoded_bytes_unchanged, true);
    assert.notEqual(row.controlled_frame_tee.parser_received_raw_hex, null, "binary tee captured no wire");
    assert.equal(row.controlled_frame_tee.same_result_as_original, true, "binary tee changed the original outcome");
    for (const variant of row.padding_hypothesis.variants) {
      const context = `${row.wrapper}/${row.reason}/${variant.name}`;
      assert.equal(variant.count_hex, "310d0a", context + ": count must be one");
      assert.equal(variant.first_line_hex, row.expected_record_hex, context + ": first line bytes");
      assert.equal(variant.exact_category_message_and_exit, true, context + ": exact message/exit");
      assert.equal(variant.observation_preserves_result, true, context + ": observer changed result");
      assert.equal(variant.source_except_for_line_unchanged, true, context + ": escaped beyond FOR command");
      if (variant.name === "source-trailing-spaces") {
        assert.equal(variant.tested_utf16le_bytes % 3, 0, context + ": UTF-16LE length");
        assert(!variant.encoded_command_text.includes("="), context + ": Base64 padding remains");
      }
    }
  }
});
