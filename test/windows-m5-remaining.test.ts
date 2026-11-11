import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { windowsWrapper } from "../product/src/wrappers.ts";
import { encodePowerShell } from "../product/src/templates.ts";
import { windowsValidator } from "../product/src/windows-validator.ts";
import { ROOT, CLI, temporary, isolatedEnv, tree } from "./support.ts";
import { signedFixture, testKey } from "./install-fixture.ts";
import { prewarmWindowsHost, HOST_FLAGS } from "./windows-host-a.ts";
import {
  raw,
  text,
  ps,
  psQuote,
  powershell,
  helper,
  receipt,
  jsonResult,
  systemPath,
  sameResult,
  nativeCanary,
  startNative,
  until,
  pidAlive,
  pidState,
  stopOwned,
} from "./native-m5-support.ts";
import { port } from "./view-signal-support.ts";

const native = process.platform === "win32";
const generic = (label: string) =>
  `${label}: cannot validate the installation (Windows PowerShell unavailable or blocked)\r\n`;
const need = (label: string) => `${label}: need Node 22.19+ or 24 LTS\r\n`;
function fixture(node = process.execPath) {
  const home = temporary(),
    root = join(home, "install"),
    version = join(root, "0.5.0"),
    env = isolatedEnv(home);
  fs.mkdirSync(join(root, "bin"), { recursive: true });
  fs.mkdirSync(join(version, "product/src"), { recursive: true });
  fs.writeFileSync(join(root, "current"), "0.5.0\n\n");
  fs.writeFileSync(join(version, "node"), node + "\n");
  fs.writeFileSync(join(version, "product/package.json"), '{"type":"module"}\n');
  fs.writeFileSync(join(version, "product/src/cli.ts"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  return { home, root, version, env };
}
function wrapper(f: ReturnType<typeof fixture>, mcp: boolean) {
  const file = join(f.root, "bin", mcp ? "trajecta-mcp.cmd" : "trajecta.cmd");
  fs.writeFileSync(file, windowsWrapper(f.root, powershell(), mcp));
  return file;
}
function command(file: string, args: string[], env: Record<string, string>, input?: Buffer, timeout = 30000) {
  return raw(systemPath("System32/cmd.exe"), ["/d", "/q", "/c", file, ...args], env, input, timeout);
}
function refused(r: ReturnType<typeof raw>, message: string) {
  assert.equal(r.error, null, JSON.stringify(r));
  assert.equal(r.status, 1, JSON.stringify(r));
  assert.equal(r.stdout_hex, "");
  assert.equal(text(r, "stderr"), message);
}
const argsFor = (mcp: boolean) =>
  mcp ? ["m5-server", "--engine", "identity", "--", "--profile", "example"] : ["version", "literal-é"];

test(
  "M5 real volume 8.3-disabled NODEPATH and enabled short-name success through both wrappers",
  { skip: !native },
  () => {
    const home = temporary(),
      env = isolatedEnv(home),
      mount = join(home, "volume"),
      vhd = join(home, "fixture.vhd"),
      tool = helper();
    fs.mkdirSync(mount);
    const logs: unknown[] = [];
    let attached = false;
    const diskpart = (lines: string[]) => {
      const file = join(home, `diskpart-${logs.length}.txt`);
      fs.writeFileSync(file, lines.join("\r\n") + "\r\n");
      const r = raw(systemPath("System32/diskpart.exe"), ["/s", file], env, undefined, 60000);
      logs.push(r);
      return r;
    };
    const rows: unknown[] = [];
    try {
      attached = true;
      diskpart([
        `create vdisk file="${vhd}" maximum=512 type=expandable`,
        `select vdisk file="${vhd}"`,
        "attach vdisk",
        "create partition primary",
        "format fs=ntfs quick label=M5TEST",
        `assign mount="${mount}"`,
      ]);
      const vr = raw(tool, ["--volume", mount + "\\"], env);
      logs.push(vr);
      assert.equal(vr.status, 0, "STOP M5-1: isolated VHD/mount unavailable; raw diskpart and volume probe recorded");
      const volume = jsonResult(vr).volume;
      // Never change the host or checkout volume's short-name setting.
      for (const drive of new Set([win32.parse(ROOT).root, win32.parse(powershell()).root])) {
        const hostVolume = raw(tool, ["--volume", drive], env);
        logs.push(hostVolume);
        assert.notEqual(
          volume.toLowerCase(),
          jsonResult(hostVolume).volume.toLowerCase(),
          "STOP: the mount resolved to a host volume rather than the disposable VHD",
        );
      }
      logs.push(raw(systemPath("System32/fsutil.exe"), ["8dot3name", "query"], env));
      for (const enabled of [true, false]) {
        const setting = raw(systemPath("System32/fsutil.exe"), ["8dot3name", "set", volume, enabled ? "0" : "1"], env);
        logs.push(setting);
        assert.equal(setting.status, 0, "STOP M5-1: per-test-volume 8.3 control unavailable");
        const query = raw(systemPath("System32/fsutil.exe"), ["8dot3name", "query", volume], env);
        logs.push(query);
        assert.equal(query.status, 0, JSON.stringify(query));
        const dir = join(mount, enabled ? "payload-é-enabled-long" : "payload-é-disabled-long"),
          node = join(dir, "node.exe");
        fs.mkdirSync(dir);
        fs.copyFileSync(process.execPath, node);
        const shortProbe = raw(tool, ["--short", node], env),
          short = jsonResult(shortProbe);
        logs.push(shortProbe);
        if (enabled)
          assert(
            short.result && /^[\x20-\x7e]+$/u.test(short.result) && short.result !== node,
            "real cmd-safe short form required",
          );
        else
          assert(
            !short.result || /[^\x20-\x7e]/u.test(short.result),
            "STOP M5-1: disabled file unexpectedly has ASCII short form",
          );
        const f = fixture(node);
        prewarmWindowsHost(powershell(), f.env);
        for (const mcp of [false, true]) {
          const file = wrapper(f, mcp),
            args = argsFor(mcp),
            before = tree(f.home),
            r = command(file, args, f.env);
          const direct = raw(powershell(), [...HOST_FLAGS, encodePowerShell(windowsValidator(f.root))], {
            ...f.env,
            TRAJECTA_WRAPPER_DIR: join(f.root, "bin") + "\\",
          });
          rows.push({
            enabled,
            node,
            short,
            query,
            result: r,
            direct,
            mcp,
            args,
            tree_unchanged: JSON.stringify(tree(f.home)) === JSON.stringify(before),
          });
          if (enabled) {
            assert.equal(r.status, 0, JSON.stringify(r));
            assert.equal(r.stderr_hex, "");
            assert.equal(text(r), JSON.stringify(mcp ? ["mcp", ...args] : args) + "\n");
            assert.equal(text(direct), `TRJ1|OK|0.5.0|${short.result}|END\r\n`);
          } else {
            refused(
              r,
              `${mcp ? "m5-server" : "trajecta"}: the recorded Node path has no usable short form on this system; reinstall with Node at an ASCII path\r\n`,
            );
            assert.equal(text(direct), "TRJ1|ERR|NODEPATH|END\r\n");
          }
          assert.deepEqual(tree(f.home), before);
        }
      }
    } finally {
      if (attached) diskpart([`select vdisk file="${vhd}"`, "detach vdisk"]);
      receipt("short-path", { home, mount, vhd, logs, rows });
    }
  },
);

test(
  "M5 runtime fake SystemRoot PowerShell canary is runnable but never selected by either pinned wrapper",
  { skip: !native },
  () => {
    const tool = nativeCanary(),
      f = fixture(),
      fakeRoot = join(f.home, "fake-windows"),
      fake = join(fakeRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      marker = join(f.home, "canary"),
      startMarker = join(temporary(), "node-starts.jsonl");
    const warmEnv = {
      ...f.env,
      SYSTEMROOT: systemPath(),
      TEST_NATIVE_MODE: "canary",
      TEST_NATIVE_MARKER: marker,
      TEST_M5_NODE_START: startMarker,
      NODE_OPTIONS: "--import=" + pathToFileURL(join(ROOT, "test/windows-m5-node-start.mjs")).href,
    };
    const env = { ...warmEnv, SYSTEMROOT: fakeRoot };
    const differences = Object.keys(env)
      .filter((key) => env[key] !== warmEnv[key])
      .map((key) => ({ key, prewarm: warmEnv[key], canary: env[key] }));
    const steps: Array<Record<string, unknown>> = [];
    const rows: Array<Record<string, unknown>> = [];
    try {
      const sensitivity = raw(tool, [], env);
      steps.push({ kind: "sensitivity", result: sensitivity, marker: fs.existsSync(marker) });
      assert.equal(sensitivity.status, 17);
      assert.equal(fs.readFileSync(marker, "utf8"), "canary ran\n");
      fs.unlinkSync(marker);

      assert.deepEqual(
        differences.map((d) => d.key),
        ["SYSTEMROOT"],
      );
      prewarmWindowsHost(powershell(), warmEnv);
      steps.push({ kind: "real-systemroot-prewarm", host: powershell(), status: 0 });
      const wrappers = [wrapper(f, false), wrapper(f, true)];
      fs.mkdirSync(join(fakeRoot, "System32/WindowsPowerShell/v1.0"), { recursive: true });
      fs.copyFileSync(tool, fake);
      const before = tree(f.home);
      steps.push({ kind: "whole-tree-baseline", tree: before });

      for (const [index, file] of wrappers.entries()) {
        const mcp = index === 1;
        const args = argsFor(mcp);
        const r = command(file, args, env);
        const starts = fs.existsSync(startMarker)
          ? fs
              .readFileSync(startMarker, "utf8")
              .trim()
              .split("\n")
              .map((l) => JSON.parse(l))
          : [];
        const after = tree(f.home);
        rows.push({ mcp, result: r, marker: fs.existsSync(marker), node_starts: starts, tree_after: after });
        assert(!fs.existsSync(marker));
        assert.deepEqual(after, before);
        if (r.status === 1) {
          refused(r, generic(mcp ? "m5-server" : "trajecta"));
          assert.deepEqual(starts, []);
        } else {
          assert.equal(r.error, null, JSON.stringify(r));
          assert.equal(r.status, 0, JSON.stringify(r));
          assert.equal(r.stderr_hex, "");
          assert.equal(text(r), JSON.stringify(mcp ? ["mcp", ...args] : args) + "\n");
          assert.equal(starts.length, 2, "exactly the version probe and fixture engine");
        }
        if (fs.existsSync(startMarker)) fs.unlinkSync(startMarker);
      }
    } finally {
      receipt("pinned-canary", { fake, environment_differences: differences, steps, rows });
    }
  },
);

test("M5 native CLM refuses exactly", { skip: !native }, () => {
  const f = fixture(),
    rows = [];
  const modeProbe = ps(
    "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'; $ExecutionContext.SessionState.LanguageMode",
    f.env,
  );
  try {
    assert.equal(modeProbe.status, 0, JSON.stringify(modeProbe));
    assert.equal(text(modeProbe), "ConstrainedLanguage\r\n");
    for (const mcp of [false, true]) {
      const file = wrapper(f, mcp),
        source = fs.readFileSync(file, "utf8"),
        encoded = encodePowerShell(
          "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';" + windowsValidator(f.root),
        );
      fs.writeFileSync(file, source.replace(/(-EncodedCommand )[A-Za-z0-9+/=]+/u, "$1" + encoded));
      prewarmWindowsHost(powershell(), f.env);
      const before = tree(f.home),
        r = command(file, argsFor(mcp), f.env);
      rows.push({ mcp, result: r, source_mode: "actual ConstrainedLanguage before unchanged validator" });
      refused(r, generic(mcp ? "m5-server" : "trajecta"));
      assert.deepEqual(tree(f.home), before);
    }
  } finally {
    receipt("policy", {
      mode_probe: modeProbe,
      clm_rows: rows,
      application_control_gate: "dedicated terminal AppLocker job",
    });
  }
});

function fixturePid(file: string) {
  return Number(fs.readFileSync(file, "utf8"));
}

test("M5-4 LIMITATION / UNBOUNDED WRAPPER: validator exits before inherited-pipe EOF", { skip: !native }, async () => {
  const tool = helper(),
    rows: Array<Record<string, any>> = [];
  try {
    for (const mode of ["parent-exit", "parent-hang"]) {
      for (const mcp of [false, true]) {
        const f = fixture(tool),
          file = wrapper(f, mcp),
          pidFile = join(f.home, "fake-pid"),
          frame = join(f.home, "validator-frame"),
          env = { ...f.env, TEST_NATIVE_MODE: mode, TEST_NATIVE_RECEIPT: pidFile, TEST_M5_FRAME: frame };
        prewarmWindowsHost(powershell(), env);
        const source = windowsValidator(f.root);
        const writeFrame = '[Console]::Out.Write("TRJ1|$s|END`r`n")';
        assert.equal(source.split(writeFrame).length, 2);
        // Record the exact string written into FOR /F's private pipe, and its writer PID.
        const encoded = encodePowerShell(
          source.replace(
            writeFrame,
            '$w="TRJ1|$s|END`r`n";[IO.File]::WriteAllText($env:TEST_M5_FRAME,"$PID`n$w");[Console]::Out.Write($w)',
          ),
        );
        const observed = fs.readFileSync(file, "utf8").replace(/(-EncodedCommand )[A-Za-z0-9+/=]+/u, "$1" + encoded);
        assert(observed.split(/\r?\n/u).every((line) => line.length <= 8000));
        fs.writeFileSync(file, observed);
        const start = performance.now();
        const proc = startNative(systemPath("System32/cmd.exe"), ["/d", "/q", "/c", file, ...argsFor(mcp)], env);
        proc.child.stdin.end();
        const row: Record<string, any> = { mode, mcp, events: [] };
        rows.push(row);
        try {
          await until(
            () => fs.existsSync(frame) && fs.existsSync(pidFile + ".child"),
            15000,
            "validator frame and child receipts",
          );
          const bytes = fs.readFileSync(frame);
          const end = bytes.indexOf(10);
          const validator = Number(bytes.subarray(0, end).toString("ascii"));
          const holder = fixturePid(pidFile + ".child"),
            probe = fixturePid(pidFile);
          row.frame_hex = bytes.subarray(end + 1).toString("hex");
          assert.equal(bytes.subarray(end + 1).toString("ascii"), "TRJ1|ERR|NODE|END\r\n");
          row.validator = pidState(validator, 2000);
          assert(
            row.validator.exited,
            "validator must exit independently of pipe holder: " + JSON.stringify(row.validator),
          );
          if (row.validator.present) assert.equal(row.validator.exit_unsigned, 0);
          row.events.push({ kind: "validator-exit-observed", pid: validator, t_ms: performance.now() - start });
          assert(row.events[0].t_ms < 15000, "bounded validator including host startup");
          assert(row.events[0].t_ms >= (mode === "parent-exit" ? 1900 : 9900));
          assert(!pidAlive(probe) && pidAlive(holder));
          assert(!proc.exited && !proc.closed, "wrapper remains blocked before inherited-pipe EOF");
          row.before_release = proc.snapshot();
          assert.equal(row.before_release.stdout_hex, "");
          assert.equal(row.before_release.stderr_hex, "");
          row.events.push({ kind: "terminate-owned-descendant", pid: holder, t_ms: performance.now() - start });
          await stopOwned(holder);
          await until(() => proc.closed, 5000, "wrapper must return cleanly after descendant termination");
          row.events.push({ kind: "wrapper-eof", t_ms: performance.now() - start });
          row.result = proc.snapshot();
          refused(row.result, need(mcp ? "m5-server" : "trajecta"));
          assert(!fs.existsSync(pidFile + ".engine"), "fixture engine must never start");
          row.all_test_pids_gone = [validator, holder, probe, proc.child.pid!].every((pid) => !pidAlive(pid));
          assert(row.all_test_pids_gone);
        } finally {
          for (const suffix of [".child", ""])
            if (fs.existsSync(pidFile + suffix)) await stopOwned(fixturePid(pidFile + suffix));
          if (!proc.closed && proc.child.pid) await stopOwned(proc.child.pid);
          row.final = proc.snapshot();
        }
      }
    }
  } finally {
    receipt("pipe-descendant", { disposition: "LIMITATION / UNBOUNDED WRAPPER (validator bounded)", rows });
  }
});

test("M5-4 hung version probe without a descendant returns after the bounded wait", { skip: !native }, async () => {
  const rows = [];
  try {
    for (const mcp of [false, true]) {
      const f = fixture(helper()),
        file = wrapper(f, mcp),
        pidFile = join(f.home, "fake-pid"),
        env = { ...f.env, TEST_NATIVE_MODE: "hang-alone", TEST_NATIVE_RECEIPT: pidFile };
      prewarmWindowsHost(powershell(), env);
      const r = command(file, argsFor(mcp), env, undefined, 15000);
      rows.push({ mcp, result: r });
      try {
        refused(r, need(mcp ? "m5-server" : "trajecta"));
        assert(r.elapsed_ms >= 9900 && r.elapsed_ms < 15000, "10 s wait + 2 s drain, with up to 3 s host startup");
        assert(!fs.existsSync(pidFile + ".child") && !fs.existsSync(pidFile + ".engine"));
        assert(!pidAlive(fixturePid(pidFile)), "hung fixture probe must be gone");
      } finally {
        if (fs.existsSync(pidFile)) await stopOwned(fixturePid(pidFile));
      }
    }
  } finally {
    receipt("pipe-no-descendant", { rows });
  }
});

function actualInstalledMcp(long: boolean) {
  const f = signedFixture(testKey()),
    root = join(f.root, long ? "界".repeat(240 - f.root.length - 1) : "mcp-é"),
    env = { ...f.env, NODE_NO_WARNINGS: "1" };
  if (long) assert.equal(root.length, 240);
  const rows: unknown[] = [];
  const install = raw(
    process.execPath,
    [CLI, "install", "--root", root, "--release", f.release, "--no-user-bin"],
    env,
    undefined,
    60000,
  );
  try {
    assert.equal(install.status, 0, "STOP M5-5 real long-root install: " + JSON.stringify(install));
    const cli = join(root, "bin/trajecta.cmd"),
      version = command(cli, ["version"], env);
    rows.push({ kind: "version", result: version });
    assert.equal(version.status, 0, JSON.stringify(version));
    sameResult(raw(process.execPath, [join(root, "0.5.0/product/src/cli.ts"), "version"], env), version);
    prewarmWindowsHost(powershell(), env);
    const before = tree(root);
    const input = Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"native-m5","version":"1"}}}\n',
    );
    for (const engine of ["identity", "work"]) {
      const file = join(f.root, engine + "-entry.json"),
        observedEnv = {
          ...env,
          NODE_OPTIONS: "--import=" + pathToFileURL(join(ROOT, "test/native-m5-entry-observer.ts")).href,
          TEST_M5_NATIVE_TOOL: helper(),
          TEST_M5_ENTRY_RECEIPT: file,
        };
      const entry = join(
          root,
          "0.5.0/engines",
          engine === "identity" ? "identity/src/mcp.ts" : "work/src/mcp-server.ts",
        ),
        engineArgs = engine === "identity" ? ["--profile", "example"] : [];
      const direct = raw(process.execPath, [entry, ...engineArgs], observedEnv, input);
      const directEntry = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.unlinkSync(file);
      const wrapped = command(
        join(root, "bin/trajecta-mcp.cmd"),
        ["m5-" + engine, "--engine", engine, "--", ...engineArgs],
        observedEnv,
        input,
      );
      const actual = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
      rows.push({ engine, direct, wrapped, direct_entry: directEntry, wrapped_entry: actual });
      sameResult(direct, wrapped);
      assert.equal(wrapped.status, 0);
      assert.equal(wrapped.stderr_hex, "");
      assert.equal(text(wrapped).split("\n").length, 2);
      assert.equal(JSON.parse(text(wrapped)).id, 1);
      assert(actual);
      assert.deepEqual(actual.argv, directEntry.argv);
      assert.equal(actual.tree_status, 0);
      assert.equal(actual.tree_stderr, "");
      const ancestors = JSON.parse(actual.tree_stdout);
      assert.equal(ancestors[0].pid, actual.pid);
      assert(ancestors.length >= 2);
      assert(
        !ancestors.some((p: any) => /powershell|pwsh/iu.test(p.name)),
        "PowerShell must have exited before engine entry",
      );
    }
    assert.deepEqual(tree(root), before);
    for (const mcp of [false, true])
      assert.throws(() => windowsWrapper("C:\\" + "界".repeat(4000), powershell(), mcp), /8000/u);
  } finally {
    receipt(long ? "long-root" : "mcp-ancestry", { root, length: root.length, install, rows });
  }
}

test(
  "M5 actual installed identity/work MCP initialize bytes and no-PowerShell engine ancestry",
  { skip: !native },
  () => actualInstalledMcp(false),
);
test("M5 240-character non-ASCII install root runs CLI and actual engine MCP; >8000 refuses", { skip: !native }, () =>
  actualInstalledMcp(true),
);

test(
  "M5-8 declared Windows limitation: the batch Y prompt exits 255 after engine Ctrl-C",
  { skip: !native },
  async () => {
    const tool = helper(),
      f = signedFixture(testKey()),
      root = join(f.root, "install"),
      env = { ...f.env, NODE_NO_WARNINGS: "1" };
    const install = raw(
      process.execPath,
      [CLI, "install", "--root", root, "--release", f.release, "--no-user-bin"],
      env,
      undefined,
      60000,
    );
    const rows = [];
    try {
      assert.equal(install.status, 0, JSON.stringify(install));
      const bound = await port();
      const quote = (s: string) => '"' + s.replaceAll('"', '\\"') + '"';
      for (const wrapped of [false, true]) {
        const application = wrapped ? systemPath("System32/cmd.exe") : process.execPath;
        const viewArgs = ["view", "--no-browser", "--port", String(bound)];
        const commandLine = wrapped
          ? quote(application) +
            ' /d /q /s /c "' +
            quote(join(root, "bin/trajecta.cmd")) +
            " identity " +
            viewArgs.join(" ") +
            '"'
          : [application, join(root, "0.5.0/engines/identity/src/cli.ts"), ...viewArgs].map(quote).join(" ");
        const config = join(f.root, wrapped ? "wrapped-console.json" : "direct-console.json"),
          out = config + ".receipt";
        fs.writeFileSync(config, JSON.stringify({ application, command: commandLine, cwd: f.root, answer: "Y" }));
        const run = raw(tool, ["--console", config, out], env, undefined, 45000);
        const evidence = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
        rows.push({ wrapped, run, evidence });
        assert.equal(run.status, 0, "STOP M5-8 native console harness: " + JSON.stringify({ run, evidence }));
        assert(evidence?.ctrl_c_sent);
      }
      const direct = rows[0].evidence,
        wrapped = rows[1].evidence;
      assert.equal(direct.exit_unsigned, 0, "real direct engine handles console Ctrl-C gracefully");
      assert.equal(wrapped.exit_unsigned, 255);
      assert.equal(direct.batch_prompt, false);
      assert.equal(wrapped.batch_prompt, true);
      assert.equal(wrapped.answer, "Y");
      const lines = (base64: string, width: number) => {
        const screen = Buffer.from(base64, "base64").toString("utf16le");
        const result: string[] = [];
        for (let i = 0; i < screen.length; i += width) {
          const line = screen.slice(i, i + width).trimEnd();
          if (line) result.push(line);
        }
        return result;
      };
      const ready = lines(direct.before_utf16le_base64, direct.width);
      assert.deepEqual(lines(wrapped.before_utf16le_base64, wrapped.width), ready);
      assert.deepEqual(lines(direct.after_utf16le_base64, direct.width), ready);
      assert.deepEqual(lines(wrapped.after_utf16le_base64, wrapped.width), [...ready, "Terminate batch job (Y/N)? Y"]);
    } finally {
      receipt("console-ctrl-c", { disposition: "declared Windows limitation", install, rows });
    }
  },
);

test("M5-8 piped MCP initialize, then stdin EOF, matches the direct engine", { skip: !native }, async () => {
  const f = signedFixture(testKey()),
    root = join(f.root, "install");
  const env = { ...f.env, NODE_NO_WARNINGS: "1" };
  const install = raw(
    process.execPath,
    [CLI, "install", "--root", root, "--release", f.release, "--no-user-bin"],
    env,
    undefined,
    60000,
  );
  const rows: Array<Record<string, any>> = [];
  try {
    assert.equal(install.status, 0, JSON.stringify(install));
    prewarmWindowsHost(powershell(), env);
    const before = tree(root);
    const request =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"native-m5-eof","version":"1"}}}\n';
    for (const engine of ["identity", "work"]) {
      const pair = [];
      for (const wrapped of [false, true]) {
        const marker = join(f.root, `${engine}-${wrapped ? "batch" : "direct"}-eof.json`);
        const entry = join(
          root,
          "0.5.0/engines",
          engine === "identity" ? "identity/src/mcp.ts" : "work/src/mcp-server.ts",
        );
        const engineArgs = engine === "identity" ? ["--profile", "example"] : [];
        const observedEnv = {
          ...env,
          NODE_OPTIONS: "--import=" + pathToFileURL(join(ROOT, "test/native-m5-entry-observer.ts")).href,
          TEST_M5_NATIVE_TOOL: helper(),
          TEST_M5_ENTRY_RECEIPT: marker,
        };
        const proc = wrapped
          ? startNative(
              systemPath("System32/cmd.exe"),
              [
                "/d",
                "/q",
                "/c",
                join(root, "bin/trajecta-mcp.cmd"),
                "m5-" + engine,
                "--engine",
                engine,
                "--",
                ...engineArgs,
              ],
              observedEnv,
            )
          : startNative(process.execPath, [entry, ...engineArgs], observedEnv);
        const row: Record<string, any> = { engine, wrapped, request_hex: Buffer.from(request).toString("hex") };
        rows.push(row);
        pair.push(row);
        proc.child.stdin.write(request);
        try {
          await until(
            () => text(proc.snapshot()).includes("\n") || proc.closed,
            20000,
            "initialize response before stdin EOF",
          );
          row.before_eof = proc.snapshot();
          assert(!proc.closed && !proc.exited, JSON.stringify(row));
          assert(fs.existsSync(marker), "actual engine entry receipt");
          row.entry = JSON.parse(fs.readFileSync(marker, "utf8"));
          assert.equal(row.entry.entry, pathToFileURL(entry).href);
          row.engine_alive_before_eof = pidAlive(row.entry.pid);
          assert(row.engine_alive_before_eof);
          const response = text(row.before_eof);
          assert.equal(response.split("\n").length, 2);
          const parsed = JSON.parse(response);
          assert.equal(parsed.id, 1);
          assert(parsed.result && !parsed.error);
          row.stdin_closed_ms = performance.now();
          proc.child.stdin.end();
          await until(() => proc.closed, 10000, "MCP exit and pipe EOF after closing stdin");
          row.result = proc.snapshot();
          row.engine_alive_after_eof = pidAlive(row.entry.pid);
          assert.equal(row.result.status, 0, JSON.stringify(row));
          assert.equal(row.result.error, null);
          assert.equal(row.result.signal, null);
          assert.equal(row.result.stdout_hex, row.before_eof.stdout_hex);
          assert.equal(row.result.stderr_hex, "");
          assert.equal(row.engine_alive_after_eof, false);
        } finally {
          if (!proc.closed) {
            proc.child.stdin.destroy();
            if (fs.existsSync(marker)) await stopOwned(JSON.parse(fs.readFileSync(marker, "utf8")).pid);
            if (proc.child.pid) await stopOwned(proc.child.pid);
          }
          row.final = proc.snapshot();
        }
      }
      sameResult(pair[0].result, pair[1].result);
      assert.deepEqual(pair[0].entry.argv, pair[1].entry.argv);
    }
    assert.deepEqual(tree(root), before);
  } finally {
    receipt("mcp-stdin-eof", { install, rows });
  }
});
