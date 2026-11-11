/** Standalone, dependency-free signed extractor. Inspect the entire archive before writing. */
import * as fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error("archive refused: " + message);
};
// Signed metadata does not authorize unbounded memory or parser work.
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_PHYSICAL_HEADERS = 8192;
export function safePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes(":")) fail("unsafe path");
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/u.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part) ||
        /[\x00-\x1f\x7f]/u.test(part),
    )
  )
    fail("unsafe path");
  return value;
}
function text(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("invalid UTF-8 metadata");
  }
}
function field(bytes) {
  const zero = bytes.indexOf(0);
  if (zero >= 0 && bytes.subarray(zero).some((byte) => byte !== 0)) fail("embedded NUL");
  return text(zero < 0 ? bytes : bytes.subarray(0, zero));
}
function octal(bytes) {
  const value = text(bytes)
    .replace(/[\x00 ]+$/u, "")
    .trim();
  if (!/^[0-7]+$/u.test(value)) fail("invalid numeric header");
  const number = parseInt(value, 8);
  if (!Number.isSafeInteger(number) || number < 0) fail("oversized numeric header");
  return number;
}
function pax(bytes) {
  let offset = 0,
    path;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) fail("invalid PAX");
    const count = text(bytes.subarray(offset, space));
    if (!/^[1-9][0-9]*$/u.test(count)) fail("invalid PAX length");
    const end = offset + Number(count);
    if (!Number.isSafeInteger(end) || end > bytes.length || end <= space + 1 || bytes[end - 1] !== 10)
      fail("invalid PAX length");
    const record = text(bytes.subarray(space + 1, end - 1));
    if (!record.startsWith("path=") || path !== undefined) fail("PAX permits one path only");
    path = record.slice(5);
    offset = end;
  }
  if (path === undefined) fail("empty PAX");
  return path;
}
export function inspect(bytes, version) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version)) fail("invalid version");
  let tar;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_OUTPUT_BYTES });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") fail("decompressed size limit");
    throw error;
  }
  const entries = [],
    names = new Set(),
    top = `trajecta-${version}`;
  let offset = 0,
    nextPath,
    ended = false,
    physicalHeaders = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (nextPath !== undefined || offset + 1024 > tar.length || tar.subarray(offset).some((byte) => byte !== 0))
        fail("invalid terminator");
      ended = true;
      break;
    }
    if (++physicalHeaders > MAX_PHYSICAL_HEADERS) fail("physical header limit");
    const checksum = octal(header.subarray(148, 156));
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== sum || field(header.subarray(257, 263)) !== "ustar" || text(header.subarray(263, 265)) !== "00")
      fail("invalid ustar header");
    const size = octal(header.subarray(124, 136)),
      type = header[156],
      start = offset + 512;
    const end = start + Math.ceil(size / 512) * 512;
    if (end > tar.length || !Number.isSafeInteger(end)) fail("truncated entry");
    const data = tar.subarray(start, start + size);
    offset = end;
    if (type === 120) {
      if (nextPath !== undefined) fail("consecutive PAX");
      nextPath = pax(data);
      continue;
    }
    if (type !== 48 && type !== 53) fail("special entry");
    const prefix = field(header.subarray(345, 500)),
      basename = field(header.subarray(0, 100));
    let name = nextPath ?? (prefix ? prefix + "/" : "") + basename;
    nextPath = undefined;
    if (type === 53 && name.endsWith("/")) name = name.slice(0, -1);
    safePath(name);
    if (name !== top && !name.startsWith(top + "/")) fail("wrong top directory");
    if (names.has(name.toLowerCase())) fail("duplicate entry");
    names.add(name.toLowerCase());
    if (type === 53 && size !== 0) fail("nonempty directory");
    if (type === 48 && name === top) fail("top must be directory");
    entries.push({
      path: name,
      bytes: data,
      directory: type === 53,
      mode: octal(header.subarray(100, 108)) & 0o111 ? 0o755 : 0o644,
    });
  }
  if (!ended) fail("missing terminator");
  const manifestEntry = entries.find((entry) => entry.path === top + "/MANIFEST.json" && !entry.directory);
  if (!manifestEntry) fail("missing MANIFEST");
  const manifest = JSON.parse(text(manifestEntry.bytes));
  if (
    manifest.schema !== "trajecta.manifest/v1" ||
    manifest.version !== version ||
    !["foundation", "release"].includes(manifest.artifact) ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  )
    fail("invalid MANIFEST");
  const payload = new Map(
    entries
      .filter((entry) => !entry.directory && entry !== manifestEntry)
      .map((entry) => [entry.path.slice(top.length + 1), entry]),
  );
  if (payload.size !== Object.keys(manifest.files).length) fail("file inventory");
  for (const [path, expected] of Object.entries(manifest.files)) {
    safePath(path);
    const entry = payload.get(path);
    if (
      !entry ||
      !Number.isSafeInteger(expected.size) ||
      expected.size < 0 ||
      !/^[a-f0-9]{64}$/u.test(expected.sha256) ||
      entry.bytes.length !== expected.size
    )
      fail("file size or inventory");
    if (sha(entry.bytes) !== expected.sha256) fail("file digest");
  }
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = entries.find((other) => other.path.toLowerCase() === parts.slice(0, i).join("/").toLowerCase());
      if (ancestor && !ancestor.directory) fail("file is an ancestor");
    }
  }
  return { entries, manifest, manifestBytes: manifestEntry.bytes };
}
export function extract(bytes, version, staging) {
  const checked = inspect(bytes, version);
  if (fs.existsSync(staging)) fail("staging already exists");
  fs.mkdirSync(staging, { mode: 0o700 });
  for (const entry of checked.entries) {
    const path = join(staging, ...entry.path.split("/"));
    if (entry.directory) fs.mkdirSync(path, { recursive: true, mode: 0o755 });
    else {
      fs.mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
      fs.writeFileSync(path, entry.bytes, { flag: "wx", mode: entry.mode });
      if (!fs.readFileSync(path).equals(entry.bytes)) fail("write verification");
    }
  }
  return checked;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [archive, staging, version] = process.argv.slice(2);
    extract(fs.readFileSync(archive), version, staging);
  } catch (error) {
    process.stderr.write(`trajecta: ${error.message}\n`);
    process.exitCode = 1;
  }
}
