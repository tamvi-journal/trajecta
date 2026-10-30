/** Test-only --import seam. All key material remains in process memory/environment. */
import * as fs from "node:fs";
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("#trajecta-bootstrap")) {
      const result = nextLoad(url, context);
      return {
        ...result,
        source: String(result.source)
          .replace('const TRUST_ANCHOR = "";', `const TRUST_ANCHOR = ${JSON.stringify(process.env.TEST_TRUST_ANCHOR)};`)
          .replace("const ALLOW_FOUNDATION = false;", "const ALLOW_FOUNDATION = true;"),
      };
    }
    if (url.endsWith("/product/src/node-probe.ts") && process.env.TEST_NODE_CANDIDATES) {
      const result = nextLoad(url, context);
      return {
        ...result,
        source:
          String(result.source).replace("export function candidates(", "function productionCandidates(") +
          `\nexport function candidates() { return JSON.parse(process.env.TEST_NODE_CANDIDATES); }\n`,
      };
    }
    if (url.endsWith("/engines/identity/src/clock.ts") && process.env.TEST_FIXED_IDENTITY) {
      const result = nextLoad(url, context);
      return {
        ...result,
        source:
          String(result.source).replace(
            "export class WallClock implements Clock",
            "class RealWallClock implements Clock",
          ) + "\nexport class WallClock extends InjectedClock {}\n",
      };
    }
    if (url.endsWith("/product/src/trust.ts")) {
      const anchor = process.env.TEST_TRUST_ANCHOR;
      if (!anchor) throw new Error("test anchor missing");
      return {
        format: "module",
        shortCircuit: true,
        source: `export const TRUST_ANCHOR=${JSON.stringify(anchor)}; export const ALLOW_FOUNDATION=${process.env.TEST_REFUSE_FOUNDATION !== "1"};`,
      };
    }
    if (url.endsWith("/product/src/checkpoint.ts")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `import * as fs from "node:fs";
      export function checkpoint(point) {
        if (point === process.env.TEST_FAIL_AT) throw new Error("test injected fault: " + point);
        if (point === process.env.TEST_KILL_AT) process.kill(process.pid, "SIGKILL");
        if (point === process.env.TEST_PAUSE_AT) {
          fs.writeFileSync(process.env.TEST_PAUSE_MARKER, JSON.stringify({pid:process.pid,point}));
          while (!fs.existsSync(process.env.TEST_PAUSE_RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
        }
      }`,
      };
    }
    return nextLoad(url, context);
  },
});
