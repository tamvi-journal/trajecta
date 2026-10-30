import { registerHooks } from "node:module";
// Test-only hook; production checkpoint code has no runtime fault controls.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith("/product/src/checkpoint.ts")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `export function checkpoint(point) {
    if (point === process.env.TEST_KILL_AT) process.kill(process.pid, "SIGKILL");
  }`,
    };
  },
});
