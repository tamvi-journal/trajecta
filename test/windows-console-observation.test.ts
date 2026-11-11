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
    let closeControl: Record<string, any> | undefined;
    try {
      assert.equal(installed.status, 0, JSON.stringify(installed));
      const cases = [
        { id: "direct-ctrl-c", wrapped: false, action: "ctrl-c", answer: "Y" },
        { id: "batch-ctrl-c-Y", wrapped: true, action: "ctrl-c", answer: "Y" },
        { id: "batch-ctrl-c-N", wrapped: true, action: "ctrl-c", answer: "N" },
        { id: "direct-window-close", wrapped: false, action: "close-window", answer: "" },
        { id: "batch-window-close", wrapped: true, action: "close-window", answer: "" },
        {
          id: "direct-window-close-released-handles",
          wrapped: false,
          action: "close-window",
          answer: "",
          release_console_handles: true,
        },
        {
          id: "batch-window-close-released-handles",
          wrapped: true,
          action: "close-window",
          answer: "",
          release_console_handles: true,
        },
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
            release_console_handles: "release_console_handles" in scenario && scenario.release_console_handles,
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
          scope: "§13.9 M5-8 console observations",
          installed,
          rows,
        });
      }
      const prefix = join(f.root, "plain-console-close");
      const application = systemPath("System32/cmd.exe");
      const command = `${quote(application)} /d /q /k "${quote(tool)} --console-close-probe ${quote(prefix)}"`;
      const config = prefix + ".config.json",
        result = prefix + ".result.json",
        eventLog = prefix + ".events.jsonl";
      fs.writeFileSync(
        config,
        JSON.stringify({
          application,
          command,
          cwd: f.root,
          action: "close-window",
          answer: "",
          meta: prefix + ".meta.json",
          plain_control: true,
          release_console_handles: true,
        }),
      );
      const run = raw(tool, ["--console-observe", config, result], installEnv, undefined, 50000);
      const evidence = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, "utf8")) : null;
      const eventBytes = fs.existsSync(eventLog) ? fs.readFileSync(eventLog) : Buffer.alloc(0);
      const controlEvents = eventBytes
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      closeControl = { command, run, evidence, events_hex: eventBytes.toString("hex"), control_events: controlEvents };
      assert.equal(run.status, 0, JSON.stringify(closeControl));
      assert.equal(evidence?.error, null, JSON.stringify(closeControl));
      assert(evidence.action_sent && evidence.window_gone && evidence.host_at_window_gone);
      assert(Number.isInteger(evidence.observer_session_id) && Number.isInteger(evidence.root_session_id));
      assert(evidence.final_processes.every((p: any) => p.exited));
      const plainRoot = evidence.natural_processes.find((p: any) => p.pid === evidence.root_pid);
      const probe = evidence.natural_processes.find((p: any) => p.pid === evidence.engine_pid);
      assert(plainRoot && probe && plainRoot.pid !== probe.pid);
      const closeReceived = controlEvents.some((e) => e.control === 2);
      const engineSurvives = rows
        .filter((row) => row.action === "close-window")
        .some((row) => row.evidence?.natural_processes.some((p: any) => p.pid === row.meta?.pid && !p.exited));
      const closeParity = [false, true].every((released) => {
        const pair = rows.filter((row) => row.action === "close-window" && !!row.release_console_handles === released);
        const outcomes = pair.map((row) => row.evidence?.natural_processes.find((p: any) => p.pid === row.meta?.pid));
        return (
          outcomes.length === 2 &&
          outcomes.every(Boolean) &&
          outcomes[0].exited === outcomes[1].exited &&
          outcomes[0].exit_unsigned === outcomes[1].exit_unsigned
        );
      });
      closeControl.disposition =
        !plainRoot.exited || !closeReceived
          ? closeParity
            ? "window close: not reproducible on hosted runner, direct/wrapped parity observed; M8 physical-close check"
            : "STOP: direct/wrapped close outcomes differ"
          : engineSurvives
            ? "STOP: plain control received CTRL_CLOSE_EVENT and exited, but a Node engine survived"
            : "native close delivered CTRL_CLOSE_EVENT; process outcomes recorded";
      assert(!closeControl.disposition.startsWith("STOP:"), closeControl.disposition);
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
        scope: "§13.9 M5-8 console observations",
        installed,
        rows,
        close_control: closeControl,
      });
    }
  },
);
