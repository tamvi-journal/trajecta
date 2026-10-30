import * as fs from "node:fs";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { TRUST_ANCHOR, ALLOW_FOUNDATION } from "./trust.ts";
import { digest, regular } from "./install-fs.ts";
import { checkpoint } from "./checkpoint.ts";

export function requireAnchor(): void {
  if (!TRUST_ANCHOR) throw new Error("no trusted release key configured");
}
export function base64(value: string, size?: number): Buffer {
  const line = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(line) || !line)
    throw new Error("invalid base64 signature/key");
  const bytes = Buffer.from(line, "base64");
  if (bytes.toString("base64") !== line || (size !== undefined && bytes.length !== size))
    throw new Error("invalid signature/key size");
  return bytes;
}
export function verifyRelease(directory: string): { metadata: any; archive: string; extractor: string } {
  requireAnchor();
  const path = join(directory, "release.json");
  for (const file of [path, path + ".sig"]) if (!regular(file)) throw new Error("missing release metadata");
  const bytes = fs.readFileSync(path);
  const metadata = verifyMetadata(bytes, fs.readFileSync(path + ".sig", "utf8"));
  checkpoint("A:signature");
  const archive = join(directory, `trajecta-${metadata.version}.tar.gz`),
    extractor = join(directory, "trajecta-extract.mjs");
  for (const file of [archive, extractor]) if (!regular(file)) throw new Error("missing release payload");
  const tar = fs.readFileSync(archive);
  if (tar.length !== metadata.size || digest(tar) !== metadata.sha256) throw new Error("release size/SHA-256 mismatch");
  checkpoint("A:tar-digest");
  if (digest(fs.readFileSync(extractor)) !== metadata.extractor_sha256) throw new Error("extractor SHA-256 mismatch");
  checkpoint("A:extractor-digest");
  return { metadata, archive, extractor };
}
export function verifyMetadata(bytes: Buffer, signatureText: string): any {
  requireAnchor();
  const signature = base64(signatureText, 64);
  const key = createPublicKey({ key: base64(TRUST_ANCHOR), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, bytes, key, signature))
    throw new Error("release signature mismatch");
  const metadata = JSON.parse(bytes.toString("utf8"));
  if (
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(metadata.version) ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0 ||
    !/^[a-f0-9]{64}$/u.test(metadata.sha256) ||
    !/^[a-f0-9]{64}$/u.test(metadata.extractor_sha256) ||
    !/^[a-f0-9]{64}$/u.test(metadata.manifest_sha256)
  )
    throw new Error("invalid release metadata");
  return metadata;
}
export function authenticateManifest(bytes: Buffer, metadata: any, location: "extracted" | "stored"): any {
  if (digest(bytes) !== metadata.manifest_sha256) throw new Error(`${location} MANIFEST digest mismatch`);
  const manifest = JSON.parse(bytes.toString("utf8"));
  verifyArtifact(manifest, metadata);
  return manifest;
}
export function verifyArtifact(manifest: any, metadata?: any): void {
  if (manifest.artifact === "foundation" && !ALLOW_FOUNDATION) throw new Error("foundation is not a release");
  if (
    metadata &&
    (manifest.version !== metadata.version || JSON.stringify(manifest.engines) !== JSON.stringify(metadata.engines))
  )
    throw new Error("release/MANIFEST engine mismatch");
  if (manifest.node !== ">=22.19 <23 || >=24 <25") throw new Error("unsupported release Node range");
}
