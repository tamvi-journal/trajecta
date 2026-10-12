import { gzipSync, gunzipSync } from "node:zlib";
import { order, sha } from "./engine-lock.ts";
const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, "0") + "\0";
export function tarball(files: Record<string, Buffer>, top: string): Buffer {
  const chunks: Buffer[] = [];
  for (const name of Object.keys(files).sort(order)) {
    const path = top + "/" + name,
      bytes = files[name],
      header = Buffer.alloc(512);
    const slash = path.lastIndexOf("/");
    const short = Buffer.byteLength(path) <= 100 ? path : path.slice(slash + 1);
    const prefix = Buffer.byteLength(path) <= 100 ? "" : path.slice(0, slash);
    if (Buffer.byteLength(short) > 100 || Buffer.byteLength(prefix) > 155) throw new Error("tar path too long");
    header.write(short, 0, 100, "utf8");
    const executable = name === "product/src/cli.ts" || name === "bin/trajecta" || name === "bin/trajecta-mcp";
    header.write(octal(executable ? 0o755 : 0o644, 8), 100);
    header.write(octal(0, 8), 108);
    header.write(octal(0, 8), 116);
    header.write(octal(bytes.length, 12), 124);
    header.write(octal(0, 12), 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(prefix, 345, 155, "utf8");
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  // gzip -n semantics, plus a portable OS marker. zlib otherwise writes Darwin,
  // Unix or NTFS here, despite byte-identical tar and deflate streams.
  const compressed = gzipSync(Buffer.concat(chunks), { level: 9 });
  compressed[9] = 255; // RFC 1952: unknown OS; not part of the deflate payload or CRC.
  return compressed;
}
/** Test/build verification only; the pre-inspecting installer extractor belongs to 4b. */
export function unpack(bytes: Buffer, top: string): Record<string, Buffer> {
  const raw = gunzipSync(bytes),
    files: Record<string, Buffer> = {};
  const string = (b: Buffer) => b.toString("utf8").split("\0")[0];
  let offset = 0;
  while (offset + 512 <= raw.length && raw.subarray(offset, offset + 512).some((b) => b !== 0)) {
    const h = raw.subarray(offset, offset + 512),
      prefix = string(h.subarray(345, 500));
    const full = (prefix ? prefix + "/" : "") + string(h.subarray(0, 100));
    if (!full.startsWith(top + "/") || h[156] !== 48) throw new Error("invalid foundation archive");
    const name = full.slice(top.length + 1);
    if (name in files || name.split("/").includes("..")) throw new Error("invalid archive path");
    const sum = parseInt(string(h.subarray(148, 156)).trim(), 8);
    const copy = Buffer.from(h);
    copy.fill(32, 148, 156);
    if (sum !== copy.reduce((a, b) => a + b, 0)) throw new Error("tar checksum mismatch");
    if (
      parseInt(string(h.subarray(136, 148)), 8) !== 0 ||
      parseInt(string(h.subarray(108, 116)), 8) !== 0 ||
      parseInt(string(h.subarray(116, 124)), 8) !== 0
    )
      throw new Error("non-deterministic tar metadata");
    const size = parseInt(string(h.subarray(124, 136)), 8);
    offset += 512;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > raw.length) throw new Error("tar size");
    files[name] = raw.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
  }
  if (raw.length - offset !== 1024 || raw.subarray(offset).some((b) => b !== 0)) throw new Error("tar terminator");
  return files;
}
export function verifyManifest(files: Record<string, Buffer>): void {
  const manifest = JSON.parse(files["MANIFEST.json"].toString("utf8"));
  const payload = Object.keys(files)
    .filter((name) => name !== "MANIFEST.json")
    .sort(order);
  if (JSON.stringify(payload) !== JSON.stringify(Object.keys(manifest.files).sort(order)))
    throw new Error("MANIFEST inventory mismatch");
  for (const name of payload) {
    const record = manifest.files[name];
    if (record.size !== files[name].length || record.sha256 !== sha(files[name]))
      throw new Error(`MANIFEST file mismatch: ${name}`);
  }
}
