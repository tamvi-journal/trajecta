import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
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
    const tool = helper(),
      f = fixture(),
      fakeRoot = join(f.home, "fake-windows"),
      fake = join(fakeRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      marker = join(f.home, "canary");
    fs.mkdirSync(join(fakeRoot, "System32/WindowsPowerShell/v1.0"), { recursive: true });
    fs.copyFileSync(tool, fake);
    const env = {
      ...f.env,
      SYSTEMROOT: fakeRoot,
      windir: fakeRoot,
      TEST_NATIVE_MODE: "canary",
      TEST_NATIVE_MARKER: marker,
    };
    const sensitivity = raw(fake, [], env);
    assert.equal(sensitivity.status, 17);
    assert(fs.existsSync(marker));
    fs.unlinkSync(marker);
    // Host cache is warmed with the exact changed environment too.
    prewarmWindowsHost(powershell(), env);
    const rows = [];
    try {
      for (const mcp of [false, true]) {
        const file = wrapper(f, mcp),
          before = tree(f.home),
          r = command(file, argsFor(mcp), env);
        rows.push({ mcp, result: r, marker: fs.existsSync(marker) });
        assert.equal(r.status, 0, JSON.stringify(r));
        assert.equal(r.stderr_hex, "");
        assert(!fs.existsSync(marker));
        assert.deepEqual(tree(f.home), before);
      }
    } finally {
      receipt("pinned-canary", { sensitivity, fake, rows });
    }
  },
);

test(
  "M5 native CLM refuses exactly; real application-control capability is recorded without pretending a missing host is policy",
  { skip: !native },
  () => {
    const f = fixture(),
      rows = [];
    const capability = ps(
      "$ErrorActionPreference='Continue'; 'APPIDSVC'; sc.exe query AppIDSvc; 'APPLOCKER'; Get-AppLockerPolicy -Effective -Xml; 'DEVICEGUARD'; Get-CimInstance -Namespace root/Microsoft/Windows/DeviceGuard -ClassName Win32_DeviceGuard | ConvertTo-Json -Depth 4",
      f.env,
    );
    try {
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
        capability,
        clm_rows: rows,
        application_control_gate:
          "OPEN: no blocked-host fixture has been provisioned; no global policy/service changes made",
      });
    }
    assert.fail(
      "STOP M5-3: CLM proven; actual AppLocker/WDAC blocked-host fixture requires native policy provisioning; capability bytes recorded, not simulated",
    );
  },
);

test(
  "M5 inherited stdout/stderr remain open in a real descendant; bounded drain never leaks bytes",
  { skip: !native },
  () => {
    const tool = helper(),
      rows = [];
    try {
      for (const mode of ["parent-exit", "parent-hang"])
        for (const mcp of [false, true]) {
          const f = fixture(tool),
            file = wrapper(f, mcp),
            pidFile = join(f.home, "fake-pid"),
            env = { ...f.env, TEST_NATIVE_MODE: mode, TEST_NATIVE_RECEIPT: pidFile };
          prewarmWindowsHost(powershell(), env);
          const r = command(file, argsFor(mcp), env, undefined, 20000),
            pids = [];
          for (const name of [pidFile, pidFile + ".child"])
            if (fs.existsSync(name)) pids.push(Number(fs.readFileSync(name, "utf8")));
          rows.push({ mode, mcp, result: r, pids });
          try {
            assert.equal(pids.length, 2, "both real fixture processes must have started");
            refused(r, need(mcp ? "m5-server" : "trajecta"));
            assert(r.elapsed_ms < 15000, "STOP: 12-second wait+drain plus host startup exceeded 15 seconds");
            assert(
              r.elapsed_ms >= (mode === "parent-exit" ? 1900 : 9900),
              "real pending drain/timeout must be exercised",
            );
          } finally {
            for (const pid of pids)
              try {
                process.kill(pid);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
              }
          }
        }
    } finally {
      receipt("pipe-descendant", { rows });
    }
  },
);

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
  "M5 real Windows console Ctrl-C direct versus installed batch launcher, including the actual batch prompt",
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
            " /d /q /c " +
            quote(join(root, "bin/trajecta.cmd")) +
            " identity " +
            viewArgs.map(quote).join(" ")
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
      assert.equal(
        wrapped.exit_unsigned,
        direct.exit_unsigned,
        "STOP M5-8: observed console exit differs; raw screen and prompt recorded, requires declared-limitation decision",
      );
      assert.equal(
        wrapped.batch_prompt,
        direct.batch_prompt,
        "STOP M5-8: observed batch prompt differs; raw screen recorded, requires declared-limitation decision",
      );
      assert.equal(wrapped.after_utf16le_base64, direct.after_utf16le_base64);
    } finally {
      receipt("console-ctrl-c", { install, rows });
    }
  },
);
