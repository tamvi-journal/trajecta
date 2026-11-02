/** Observes the actual engine entry, never a replacement engine. */
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (!/\/engines\/(identity\/src\/mcp|work\/src\/mcp-server)\.ts$/u.test(url)) return result;
    const original = String(result.source);
    const first = original.startsWith("#!") ? original.indexOf("\n") + 1 : 0;
    return {
      ...result,
      source:
        original.slice(0, first) +
        `
import { spawnSync as nativeM5Spawn } from 'node:child_process';
import { writeFileSync as nativeM5Write } from 'node:fs';
let nativeM5Tree;
if(process.platform==='win32') {
  nativeM5Tree=nativeM5Spawn(process.env.TEST_M5_NATIVE_TOOL,['--ancestors',String(process.pid)],{encoding:'utf8'});
} else {
  const rows=[],seen=new Set();let pid=process.pid;
  while(pid && !seen.has(pid)) {
    seen.add(pid);
    const r=nativeM5Spawn('/bin/ps',['-o','pid=,ppid=,comm=','-p',String(pid)],{encoding:'utf8'});
    if(r.status!==0)throw Error('native ancestor read failed: '+r.stderr);
    const m=/^\\s*(\\d+)\\s+(\\d+)\\s+(.+)$/u.exec(r.stdout.trim());
    if(!m)throw Error('native ancestor row invalid: '+r.stdout);
    rows.push({pid:Number(m[1]),parent:Number(m[2]),name:m[3]});pid=Number(m[2]);
  }
  nativeM5Tree={status:0,stdout:JSON.stringify(rows),stderr:''};
}
nativeM5Write(process.env.TEST_M5_ENTRY_RECEIPT,JSON.stringify({pid:process.pid,argv:process.argv,
  entry:import.meta.url,tree_status:nativeM5Tree.status,tree_stdout:nativeM5Tree.stdout,tree_stderr:nativeM5Tree.stderr})+'\\n');
` +
        original.slice(first),
    };
  },
});
