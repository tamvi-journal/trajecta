import * as fs from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { digest, regular, safeRoot, syncDir, jsonBytes } from "./install-fs.ts";
import { checkpoint } from "./checkpoint.ts";

export type Owner = { token: string; pid: number; hostname: string; created: string };
export function owner(bytes: Buffer): Owner | null {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return /^[a-f0-9]{32}$/u.test(value.token) &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.hostname === "string" &&
      value.hostname.length &&
      typeof value.created === "string" &&
      Number.isFinite(Date.parse(value.created))
      ? value
      : null;
  } catch {
    return null;
  }
}
export function live(record: Owner): boolean {
  if (record.hostname !== hostname()) return true;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function bytes(path: string): Buffer | null {
  try {
    if (!regular(path)) return null;
    checkpoint("lock-read:before-read:" + path);
    return fs.readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Another claimant/holder can remove the name after lstat. Windows also
    // refuses an open while an unlink is pending. Neither permits proceeding.
    if (code === "ENOENT") return null;
    if (code === "EPERM" || code === "EACCES") throw busy();
    throw error;
  }
}
export const identity = (content: Buffer): string => owner(content)?.token ?? digest(content);
function publish(root: string, name: string): Owner | null {
  const record = {
    token: randomBytes(16).toString("hex"),
    pid: process.pid,
    hostname: hostname(),
    created: new Date().toISOString(),
  };
  const tmp = join(root, `.lock.${record.token}.tmp`),
    path = join(root, name);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, jsonBytes(record));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  checkpoint(name + ":before-link");
  try {
    fs.linkSync(tmp, path);
    syncDir(root);
    checkpoint(name + ":after-link");
    return record;
  } catch (error) {
    if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
function heldBy(root: string, record: Owner): boolean {
  const content = bytes(join(root, ".lock"));
  return !!content && owner(content)?.token === record.token;
}
export function cleanupClaims(root: string, record: Owner): void {
  if (!heldBy(root, record)) throw new Error("install lock changed");
  for (const name of fs.readdirSync(root).sort()) {
    const match = /^\.lock\.claim\.([a-f0-9]{32}|[a-f0-9]{64})\.([1-9][0-9]*)$/u.exec(name);
    if (!match || match[1] === record.token) continue;
    const path = join(root, name);
    try {
      if (!fs.lstatSync(path).isFile()) continue;
      checkpoint("claim-cleanup:before-unlink:" + name);
      fs.unlinkSync(path);
      checkpoint("claim-cleanup:after-unlink:" + name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  syncDir(root);
}
export function cleanupTemps(root: string, record: Owner): void {
  if (!heldBy(root, record)) throw new Error("install lock changed");
  for (const name of fs.readdirSync(root).sort()) {
    const match = /^\.lock\.([a-f0-9]{32})\.tmp$/u.exec(name);
    if (!match || match[1] === record.token) continue;
    const path = join(root, name);
    try {
      if (!fs.lstatSync(path).isFile()) continue;
      checkpoint("tmp-cleanup:before-unlink:" + name);
      fs.unlinkSync(path);
      checkpoint("tmp-cleanup:after-unlink:" + name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  syncDir(root);
}
export function release(root: string, name: string, record: Owner): void {
  if (name !== ".lock") throw new Error("only the install lock may be released");
  if (!heldBy(root, record)) return;
  cleanupClaims(root, record);
  if (!heldBy(root, record)) throw new Error("install lock changed");
  checkpoint("lock:before-release");
  fs.unlinkSync(join(root, name));
  syncDir(root);
  checkpoint("lock:after-release");
}
const busy = () => new Error("another install is running; lock is busy");
const human = () => new Error("install lock cannot be recovered; run trajecta install --break-lock");
function claim(root: string, id: string, approvedRemote = new Set<string>()): Owner {
  for (let n = 1; Number.isSafeInteger(n); n++) {
    const name = `.lock.claim.${id}.${n}`,
      previous = bytes(join(root, name));
    if (previous) {
      const record = owner(previous);
      if (!record) throw human();
      if (record.hostname !== hostname()) {
        if (!approvedRemote.has(record.token)) throw human();
      } else if (live(record)) throw busy();
      continue;
    }
    const claimed = publish(root, name);
    if (!claimed) throw busy(); // A losing contender must not advance to the next claim.
    checkpoint("claim:held");
    return claimed;
  }
  throw human();
}
function removeClaimed(root: string, original: Buffer, approvedRemote?: Set<string>): void {
  const id = identity(original);
  claim(root, id, approvedRemote);
  const current = bytes(join(root, ".lock"));
  if (!current || identity(current) !== id) throw new Error("lock changed; nothing removed");
  checkpoint("claim:before-unlink");
  fs.unlinkSync(join(root, ".lock"));
  syncDir(root);
  checkpoint("claim:after-unlink");
}
export function acquire(root: string): Owner {
  safeRoot(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (;;) {
    const held = publish(root, ".lock");
    if (held) {
      cleanupClaims(root, held);
      return held;
    }
    const content = bytes(join(root, ".lock"));
    if (!content) throw busy();
    const record = owner(content);
    if (!record || record.hostname !== hostname()) throw human();
    if (live(record)) throw busy();
    removeClaimed(root, content);
  }
}
export async function breakLock(root: string, confirm: (message: string) => Promise<boolean>): Promise<void> {
  safeRoot(root);
  const path = join(root, ".lock"),
    original = bytes(path);
  if (!original) throw new Error("no install lock");
  const record = owner(original),
    stat = fs.statSync(path, { bigint: true }),
    id = identity(original);
  if (record?.hostname === hostname() && live(record)) throw new Error("refusing to break a live lock");
  const approved = new Set<string>(),
    remoteClaims: string[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (!name.startsWith(`.lock.claim.${id}.`)) continue;
    const content = bytes(join(root, name)),
      claimant = content && owner(content);
    if (claimant && claimant.hostname !== hostname()) {
      approved.add(claimant.token);
      remoteClaims.push(
        `${name}: bytes ${content!.toString("hex")}; size ${content!.length}; mtime_ns ${fs.statSync(join(root, name), { bigint: true }).mtimeNs}`,
      );
    }
  }
  const remote =
    (record && record.hostname !== hostname()) || approved.size
      ? "\nYou are asserting that each shown remote process is not running."
      : "";
  if (
    !(await confirm(
      `${path}: identity ${id}; bytes ${original.toString("hex")}; size ${stat.size}; mtime_ns ${stat.mtimeNs}\n${remoteClaims.join("\n")}${remote}\nType BREAK LOCK to remove this lock: `,
    ))
  )
    throw new Error("lock break refused");
  checkpoint("break:confirmed");
  removeClaimed(root, original, approved);
}
