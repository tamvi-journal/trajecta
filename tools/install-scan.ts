/** Production has no trust-configuration input and no child writer under the lock. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, filesIn } from "./engine-lock.ts";
export function checkInstall(): void {
  const trust = readFileSync(join(ROOT, "product/src/trust.ts"), "utf8");
  if (!/export const TRUST_ANCHOR = "";/u.test(trust) || !/export const ALLOW_FOUNDATION = false;/u.test(trust))
    throw new Error("production trust configuration changed");
  for (const [name, bytes] of Object.entries(filesIn(join(ROOT, "product/src")))) {
    const source = bytes.toString();
    if (/TEST_|process\.env\.[A-Z_]*(?:ANCHOR|TRUST|KEY)|--(?:trust|key|allow-foundation)/u.test(source))
      throw new Error("production trust/test seam input: " + name);
    if (name !== "node-probe.ts" && /node:child_process|\b(?:spawn|spawnSync|execve)\s*\(/u.test(source))
      throw new Error("child writer in installer: " + name);
  }
  const installer = readFileSync(join(ROOT, "product/src/installer.ts"), "utf8");
  if (
    !installer.includes("record.pid !== process.pid") ||
    installer.indexOf("handoffNode(node)") > installer.lastIndexOf("held = acquire(opts.root)")
  )
    throw new Error("writer lifetime routing changed");
  const adapter = readFileSync(join(ROOT, "product/src/engines.ts"), "utf8");
  for (const name of ["runVerifiedExtractor", "runStagedInstall"])
    if (!adapter.includes("export async function " + name)) throw new Error("missing in-process adapter");
  const staged = /export async function installStaged\([^]*?\n\}/u.exec(installer)?.[0] ?? "";
  if (!staged || /\bacquire\s*\(/u.test(staged) || !staged.includes("record.pid !== process.pid"))
    throw new Error("staged entry can acquire a nested lock or run without ownership");
  const adapterEntry = /export async function runStagedInstall\([^]*?\n\}/u.exec(adapter)?.[0] ?? "";
  if (
    !adapterEntry.includes("return module.installStaged(argv)") ||
    /cli\.main|process\.argv|spawn/u.test(adapterEntry)
  )
    throw new Error("staged adapter must call the explicit exported install entry");
}
