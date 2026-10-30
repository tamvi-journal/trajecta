import * as fs from "node:fs";
import { dirname, join, win32 } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { safeProfileName } from "./engines.ts";

export class PluginInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginInputError";
  }
}
export type PluginOptions = {
  root: string;
  profile: string;
  name?: string;
  house?: string;
  dataDir?: string;
  profilesDir?: string;
  workRoot?: string;
};
export function serverSlug(profile: string): string {
  if (/^[a-z0-9._-]{1,46}$/u.test(profile)) return profile;
  const base = profile
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/gu, "d")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 37);
  return base + "-" + createHash("sha256").update(profile, "utf8").digest("hex").slice(0, 8);
}
export async function pluginName(profile: string): Promise<string> {
  return "trajecta-" + (await safeProfileName(profile)) + ".plugin";
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
function windowsSafe(value: string, field: string): void {
  if (/[%!^&|<>"()\x00-\x1f\x7f]/u.test(value) || value.endsWith("\\"))
    throw new PluginInputError(`Windows-unsafe ${field}`);
}
export async function pluginFiles(
  opts: PluginOptions,
  target: "posix" | "windows" = process.platform === "win32" ? "windows" : "posix",
): Promise<Record<string, Buffer>> {
  if (typeof opts.profile !== "string" || !opts.profile) throw new PluginInputError("--profile is required");
  if (opts.name !== undefined && !/^[A-Za-z0-9._-]{1,59}$/u.test(opts.name))
    throw new PluginInputError("invalid --name");
  const slug = serverSlug(opts.profile),
    identity = opts.name ?? "trajecta-identity-" + slug,
    work = opts.name ? opts.name + "-work" : "trajecta-work-" + slug;
  for (const label of [identity, work])
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(label)) throw new PluginInputError("invalid generated server label");
  const house = opts.house?.replace(/[/\\]+$/gu, "");
  const data = opts.dataDir || (house ? house + "/house-data/identity" : undefined),
    profiles = opts.profilesDir || (house ? house + "/private-profiles" : undefined),
    root = opts.workRoot || (house ? house + "/house-data/work" : undefined);
  const defaults: Array<[string, string]> = [];
  if (data) defaults.push(["TRAJECTA_IDENTITY_DATA_DIR", data]);
  if (profiles) defaults.push(["TRAJECTA_IDENTITY_PROFILES", profiles]);
  if (root) defaults.push(["TRAJECTA_WORK_ROOT", root]);
  const commands: Record<string, unknown> = {};
  for (const [label, engine, values, args] of [
    [identity, "identity", defaults, ["--profile", opts.profile]],
    [work, "work", root ? [["TRAJECTA_HOME", root]] : [], []],
  ] as Array<[string, string, Array<[string, string]>, string[]]>) {
    if (target === "windows") {
      windowsSafe(label, "label");
      for (const [key, value] of values) windowsSafe(value, key);
      for (const arg of args) windowsSafe(arg, "profile/engine argument");
    }
    const recipe = [
      label,
      "--engine",
      engine,
      ...values.flatMap(([key, value]) => ["--default", key, value]),
      "--",
      ...args,
    ];
    commands[label] =
      target === "windows"
        ? { command: "cmd.exe", args: ["/d", "/c", win32.join(opts.root, "bin", "trajecta-mcp.cmd"), ...recipe] }
        : { command: "/bin/sh", args: [join(opts.root, "bin", "trajecta-mcp"), ...recipe] };
  }
  const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  return {
    ".claude-plugin/plugin.json": json({
      name: identity,
      version,
      description: `Trajecta identity and work memory for profile '${opts.profile}'.`,
      author: { name: "Trajecta" },
    }),
    ".mcp.json": json({ mcpServers: commands }),
    "skills/identity-continuity/SKILL.md": fs.readFileSync(
      new URL("../assets/identity-continuity/SKILL.md", import.meta.url),
    ),
  };
}
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
export function pluginZip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const name of Object.keys(files).sort()) {
    const path = Buffer.from(name),
      bytes = files[name],
      compressed = deflateRawSync(bytes, { level: 9 }),
      crc = crc32(bytes);
    const local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(path.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, path, compressed);
    centrals.push(central, path);
    offset += local.length + path.length + compressed.length;
  }
  const end = Buffer.alloc(22),
    directory = Buffer.concat(centrals);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
/** K2: a closed complete ZIP in the destination directory, then one rename; no copy fallback. */
export function writePlugin(out: string, files: Record<string, Buffer>): void {
  const bytes = pluginZip(files),
    tmp = join(dirname(out), ".build-" + randomBytes(16).toString("hex") + ".plugin");
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, out);
  } catch (error) {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw error;
  }
}
