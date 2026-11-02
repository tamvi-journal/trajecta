/** Authorized observations only; pending §13.9 does not change any acceptance gate. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createConnection } from "node:net";
import test from "node:test";
import { CLI, ROOT } from "./support.ts";
import { signedFixture, testKey } from "./install-fixture.ts";
import { helper, raw, receipt, systemPath } from "./native-m5-support.ts";
import { port } from "./view-signal-support.ts";

async function portAfterCleanup(bound: number) {
  const started = performance.now();
  return new Promise<{ connected: boolean; error: string | null; elapsed_ms: number }>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: bound });
    const finish = (connected: boolean, error: string | null) => {
      socket.destroy();
      resolve({ connected, error, elapsed_ms: performance.now() - started });
    };
    socket.setTimeout(1000, () => finish(false, "timeout"));
    socket.once("connect", () => finish(true, null));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(false, error.code ?? error.message));
  });
}

test(
  "observation only: real Windows console Y, N, window close and owned-process lifetime",
  {
    skip: process.platform !== "win32" ? "native Windows console observation" : false,
  },
  async () => {
    const tool = helper(),
      f = signedFixture(testKey()),
      root = join(f.root, "install");
    const installEnv = { ...f.env, NODE_NO_WARNINGS: "1" };
    const installed = raw(
      process.execPath,
      [CLI, "install", "--root", root, "--release", f.release, "--no-user-bin"],
      installEnv,
      undefined,
      60000,
    );
    const rows: Array<Record<string, any>> = [];
    try {
      assert.equal(installed.status, 0, JSON.stringify(installed));
      const cases = [
        { id: "direct-ctrl-c", wrapped: false, action: "ctrl-c", answer: "Y" },
        { id: "batch-ctrl-c-Y", wrapped: true, action: "ctrl-c", answer: "Y" },
        { id: "batch-ctrl-c-N", wrapped: true, action: "ctrl-c", answer: "N" },
        { id: "direct-window-close", wrapped: false, action: "close-window", answer: "" },
        { id: "batch-window-close", wrapped: true, action: "close-window", answer: "" },
      ];
      const quote = (s: string) => '"' + s.replaceAll('"', '\\"') + '"';
      for (const scenario of cases) {
        const bound = await port(),
          prefix = join(f.root, scenario.id);
        const viewArgs = ["view", "--no-browser", "--port", String(bound)];
        const application = scenario.wrapped ? systemPath("System32/cmd.exe") : process.execPath;
        const command = scenario.wrapped
          ? quote(application) +
            ' /d /q /s /c "' +
            quote(join(root, "bin/trajecta.cmd")) +
            " identity " +
            viewArgs.join(" ") +
            '"'
          : [application, join(root, "0.5.0/engines/identity/src/cli.ts"), ...viewArgs].map(quote).join(" ");
        const config = prefix + ".config.json",
          result = prefix + ".result.json";
        fs.writeFileSync(
          config,
          JSON.stringify({
            application,
            command,
            cwd: f.root,
            action: scenario.action,
            answer: scenario.answer,
            meta: prefix + ".meta.json",
          }),
        );
        const env = {
          ...installEnv,
          TEST_CONSOLE_CAPTURE: prefix,
          NODE_OPTIONS:
            installEnv.NODE_OPTIONS + " --import=" + pathToFileURL(join(ROOT, "test/console-output-observer.mjs")).href,
        };
        const run = raw(tool, ["--console-observe", config, result], env, undefined, 50000);
        const evidence = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, "utf8")) : null;
        const meta = fs.existsSync(prefix + ".meta.json")
          ? JSON.parse(fs.readFileSync(prefix + ".meta.json", "utf8"))
          : null;
        const captured = (suffix: string) =>
          fs.existsSync(prefix + suffix) ? fs.readFileSync(prefix + suffix).toString("hex") : null;
        const portState = await portAfterCleanup(bound);
        rows.push({
          ...scenario,
          bound,
          application,
          command,
          run,
          evidence,
          meta,
          engine_stdout_hex: captured(".stdout"),
          engine_stderr_hex: captured(".stderr"),
          port_after_harness_cleanup: portState,
        });
        receipt("console-observation", {
          scope: "observation only; PR53 unmerged; M5 acceptance unchanged",
          installed,
          rows,
        });
      }
      // Assert successful measurement and safe harness cleanup, not a proposed
      // exit-code/prompt/natural-cleanup law. Every observed value stays in raw data.
      for (const row of rows) {
        assert.equal(row.run.status, 0, JSON.stringify(row));
        assert.equal(row.evidence?.error, null, JSON.stringify(row.evidence));
        assert(row.evidence.action_sent);
        assert(row.meta?.stdin_tty && row.meta.stdout_tty && row.meta.stderr_tty, "real console descriptors required");
        assert.equal(row.evidence.engine_pid, row.meta.pid);
        assert(row.evidence.natural_processes.some((p: any) => p.pid === row.meta.pid));
        assert(
          row.evidence.final_processes.every((p: any) => p.exited),
          "no owned console client may remain after harness cleanup",
        );
        assert.equal(row.port_after_harness_cleanup.connected, false);
        assert.equal(row.port_after_harness_cleanup.error, "ECONNREFUSED");
        if (row.wrapped && row.action === "ctrl-c") {
          assert(row.evidence.batch_prompt, "answer observation must reach the actual batch prompt");
          assert(row.evidence.events.some((e: any) => e.kind === "answer" && e.answer === row.answer));
        }
      }
    } finally {
      receipt("console-observation", {
        scope: "observation only; PR53 unmerged; M5 acceptance unchanged",
        installed,
        rows,
      });
    }
  },
);
