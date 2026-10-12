/** Real entry observation; no signal/exit hooks. Only ephemeral bind allocation is deterministic. */
import fs from "node:fs";
import net from "node:net";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { enginePath } from "../product/src/engines.ts";
if (
  !import.meta.url.endsWith("?entry") &&
  (process.env.TEST_PRODUCT_ROUTE !== "1" || process.argv[1]?.replaceAll("\\", "/").endsWith("product/src/cli.ts"))
) {
  fs.writeFileSync(process.env.TEST_PID_FILE! + ".launch", String(process.pid));
}
const entries = new Set(["identity", "work"].map((e) => pathToFileURL(enginePath(e as "identity" | "work")).href));
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!entries.has(url)) return result;
    return {
      ...result,
      source:
        `await import(${JSON.stringify(new URL("./view-observe.ts?entry", import.meta.url).href)});\n` +
        String(result.source).replace(/^#![^\n]*\n/u, ""),
    };
  },
});
if (import.meta.url.endsWith("?entry")) {
  fs.writeFileSync(
    process.env.TEST_PID_FILE!,
    JSON.stringify({ pid: process.pid, tty: Boolean(process.stdin.isTTY), argv: process.argv }),
  );
  if (process.env.TEST_BIND_PORT) {
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...args: any[]) {
      if (args[0]?.port === 0) args[0] = { ...args[0], port: Number(process.env.TEST_BIND_PORT) };
      return (listen as any).apply(this, args);
    } as any;
  }
}
