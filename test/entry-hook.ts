/** Test-only entry instrumentation applies at the same real engine module in either route. */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { enginePath } from "../product/src/engines.ts";
const entry = pathToFileURL(enginePath("identity")).href;
export function beforeIdentity(module: URL): void {
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url !== entry) return result;
      return { ...result, source: `await import(${JSON.stringify(module.href)});\n` + result.source };
    },
  });
}
