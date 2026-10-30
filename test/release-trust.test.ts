import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { registerHooks } from "node:module";
import { tarball, unpack } from "../tools/archive.ts";
import { releaseMetadata } from "../tools/build-release.ts";
import { sha } from "../tools/engine-lock.ts";
import { temporary, tree } from "./support.ts";

// Both keys exist only in this test process. Neither is persisted in the fixture.
const key = generateKeyPairSync("ed25519");
const anchor = key.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const trust = new URL("../product/src/trust.ts", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url !== trust) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `export const TRUST_ANCHOR=${JSON.stringify(anchor)}; export const ALLOW_FOUNDATION=true;`,
    };
  },
});
const { verifyMetadata, authenticateManifest } = await import("../product/src/release.ts");
const { verifyVersion } = await import("../product/src/owned.ts");
function fixture() {
  const payload = {
    "product/src/example.ts": Buffer.from("export const value=1;\n"),
    "product/trajecta-extract.mjs": Buffer.from("// synthetic extractor\n"),
  };
  const manifest = {
    schema: "trajecta.manifest/v1",
    artifact: "foundation",
    version: "0.5.0",
    node: ">=22.19 <23 || >=24 <25",
    engines: { identity: "a".repeat(40), work: "b".repeat(40) },
    files: Object.fromEntries(
      Object.entries(payload).map(([path, bytes]) => [path, { size: bytes.length, sha256: sha(bytes) }]),
    ),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const archive = tarball({ ...payload, "MANIFEST.json": manifestBytes }, "trajecta-0.5.0");
  const metadata = releaseMetadata(archive, "0.5.0");
  const bytes = Buffer.from(JSON.stringify(metadata) + "\n");
  const signature = sign(null, bytes, key.privateKey).toString("base64");
  return { manifest, manifestBytes, archive, metadata, bytes, signature };
}
test("build derives the signed MANIFEST digest from its exact packed bytes", () => {
  const f = fixture();
  assert.equal(f.metadata.manifest_sha256, sha(unpack(f.archive, "trajecta-0.5.0")["MANIFEST.json"]));
  assert.equal(f.metadata.manifest_sha256, sha(f.manifestBytes));
  assert.notEqual(f.metadata.manifest_sha256, sha(Buffer.from(JSON.stringify(f.manifest))));
  assert.deepEqual(verifyMetadata(f.bytes, f.signature + "\n"), f.metadata);
  assert.deepEqual(authenticateManifest(f.manifestBytes, f.metadata, "extracted"), f.manifest);
});
test("signed metadata must contain a valid MANIFEST digest", () => {
  for (const value of [undefined, "", "f".repeat(63), "G".repeat(64)]) {
    const metadata = { ...fixture().metadata, manifest_sha256: value };
    const bytes = Buffer.from(JSON.stringify(metadata));
    assert.throws(
      () => verifyMetadata(bytes, sign(null, bytes, key.privateKey).toString("base64")),
      /invalid release metadata/u,
    );
  }
});
test("bad signature, wrong key, truncated signature and non-base64 refuse", () => {
  const f = fixture(),
    flipped = Buffer.from(f.bytes);
  flipped[0] ^= 1;
  const other = generateKeyPairSync("ed25519");
  for (const [bytes, signature] of [
    [flipped, f.signature],
    [f.bytes, sign(null, f.bytes, other.privateKey).toString("base64")],
    [f.bytes, Buffer.alloc(63).toString("base64")],
    [f.bytes, "not base64!"],
  ] as const)
    assert.throws(() => verifyMetadata(bytes, signature), /signature|base64/u);
});
test("extracted MANIFEST mismatch refuses before parsing even if semantically identical", () => {
  const f = fixture();
  for (const bytes of [Buffer.from(JSON.stringify(f.manifest)), Buffer.from("{invalid")])
    assert.throws(
      () => authenticateManifest(bytes, f.metadata, "extracted"),
      /^Error: extracted MANIFEST digest mismatch$/u,
    );
});
test("installed MANIFEST and owned.json co-tamper cannot replace the signed trust root", () => {
  const f = fixture(),
    root = temporary(),
    folder = join(root, "0.5.0");
  for (const [path, bytes] of Object.entries(unpack(f.archive, "trajecta-0.5.0"))) {
    fs.mkdirSync(join(folder, path, ".."), { recursive: true });
    fs.writeFileSync(join(folder, path), bytes);
  }
  fs.writeFileSync(join(folder, "release.json"), f.bytes);
  fs.writeFileSync(join(folder, "release.json.sig"), f.signature + "\n");
  fs.writeFileSync(join(folder, "node"), process.execPath + "\n");
  verifyVersion(folder);
  const modified = Buffer.from("export const value=2;\n");
  f.manifest.files["product/src/example.ts"] = { size: modified.length, sha256: sha(modified) };
  const forgedManifest = Buffer.from(JSON.stringify(f.manifest, null, 2) + "\n");
  fs.writeFileSync(join(folder, "product/src/example.ts"), modified);
  fs.writeFileSync(join(folder, "MANIFEST.json"), forgedManifest);
  fs.writeFileSync(
    join(root, "owned.json"),
    JSON.stringify({
      schema: "trajecta.owned/v1",
      root,
      entries: {
        "0.5.0/MANIFEST.json": { kind: "file", scope: "0.5.0", sha256: sha(forgedManifest) },
        "0.5.0/product/src/example.ts": { kind: "file", scope: "0.5.0", sha256: sha(modified) },
      },
      effects: {},
    }),
  );
  const before = tree(root);
  assert.throws(() => verifyVersion(folder), /^Error: stored MANIFEST digest mismatch$/u);
  assert.deepEqual(tree(root), before);
});
