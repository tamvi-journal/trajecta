import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkDispatcher } from "./dispatcher-scan.ts";
import { checkAuthority } from "./authority-lint.ts";
import { verifyCompat } from "./compat.ts";
import { engineFiles, filesIn, json, order, readLock, ROOT, sha } from "./engine-lock.ts";
import { tarball, unpack, verifyManifest } from "./archive.ts";

export function build(mode: "foundation" | "release" = "foundation", fetch = true): Buffer {
  checkAuthority();
  checkDispatcher();
  verifyCompat();
  const bin: Record<string, Buffer> = {};
  if (mode === "release") {
    const required = ["trajecta", "trajecta-mcp", "trajecta.cmd", "trajecta-mcp.cmd"];
    for (const name of required) {
      const path = join(ROOT, "bin", name);
      if (!fs.existsSync(path) || !fs.lstatSync(path).isFile() || !fs.statSync(path).size)
        throw new Error(`release requires complete bin/: missing ${name}`);
      bin["bin/" + name] = fs.readFileSync(path);
    }
  }
  const lock = readLock(),
    pkg = JSON.parse(fs.readFileSync(join(ROOT, "product/package.json"), "utf8"));
  const product = Object.fromEntries(
    Object.entries(filesIn(join(ROOT, "product"))).map(([p, b]) => ["product/" + p, b]),
  );
  const payload = { ...product, ...engineFiles(lock, fetch), ...bin, LICENSE: fs.readFileSync(join(ROOT, "LICENSE")) };
  const manifest = {
    schema: "trajecta.manifest/v1",
    artifact: mode,
    version: pkg.version,
    node: pkg.engines.node,
    engines: Object.fromEntries(Object.entries(lock.engines).map(([name, pin]) => [name, pin.commit])),
    files: Object.fromEntries(
      Object.keys(payload)
        .sort(order)
        .map((path) => [path, { size: payload[path].length, sha256: sha(payload[path]) }]),
    ),
  };
  const bytes = tarball({ ...payload, "MANIFEST.json": Buffer.from(json(manifest)) }, `trajecta-${pkg.version}`);
  verifyManifest(unpack(bytes, `trajecta-${pkg.version}`));
  return bytes;
}
/** Unsigned metadata only. Signing and release publication remain separately authorized. */
export function releaseMetadata(bytes: Buffer, version: string) {
  const files = unpack(bytes, `trajecta-${version}`);
  verifyManifest(files);
  const manifestBytes = files["MANIFEST.json"];
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const extractor = files["product/trajecta-extract.mjs"];
  if (!extractor) throw new Error("release requires extractor");
  if (manifest.version !== version) throw new Error("release version mismatch");
  return {
    version,
    size: bytes.length,
    sha256: sha(bytes),
    engines: manifest.engines,
    extractor_sha256: sha(extractor),
    manifest_sha256: sha(manifestBytes),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const mode = args.includes("--release") ? "release" : "foundation";
  const at = args.indexOf("--out");
  const pkg = JSON.parse(fs.readFileSync(join(ROOT, "product/package.json"), "utf8"));
  const out = at >= 0 ? resolve(args[at + 1]) : join(ROOT, "dist", `trajecta-${pkg.version}.tar.gz`);
  const bytes = build(mode, !args.includes("--cached"));
  fs.mkdirSync(dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  process.stdout.write(json({ path: out, ...releaseMetadata(bytes, pkg.version), artifact: mode }));
}
