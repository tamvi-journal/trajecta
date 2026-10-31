/** Observes the actual engine entry, never a replacement engine. */
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (!/\/engines\/(identity\/src\/mcp|work\/src\/mcp-server)\.ts$/u.test(url)) return result;
    return {
      ...result,
      source:
        `
import { spawnSync as nativeM5Spawn } from 'node:child_process';
import { writeFileSync as nativeM5Write } from 'node:fs';
const nativeM5Tree=nativeM5Spawn(process.env.TEST_M5_NATIVE_TOOL,['--ancestors',String(process.pid)],{encoding:'utf8'});
nativeM5Write(process.env.TEST_M5_ENTRY_RECEIPT,JSON.stringify({pid:process.pid,argv:process.argv,
  entry:import.meta.url,tree_status:nativeM5Tree.status,tree_stdout:nativeM5Tree.stdout,tree_stderr:nativeM5Tree.stderr})+'\\n');
` + result.source,
    };
  },
});
