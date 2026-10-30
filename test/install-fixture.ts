import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { registerHooks } from "node:module";
import { tarball, unpack } from "../tools/archive.ts";
import { sha } from "../tools/engine-lock.ts";
import { build, releaseMetadata } from "../tools/build-release.ts";
import { ROOT, temporary, isolatedEnv } from "./support.ts";
let foundationPayload: Record<string, Buffer> | undefined;
export function testKey() {
  const keys = generateKeyPairSync("ed25519");
  const anchor = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { anchor, sign: (bytes: Buffer) => sign(null, bytes, keys.privateKey).toString("base64") + "\n" };
}
export function useTestKey(key: ReturnType<typeof testKey>): void {
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.endsWith("/product/src/trust.ts")) return nextLoad(url, context);
      return {
        format: "module",
        shortCircuit: true,
        source: `export const TRUST_ANCHOR=${JSON.stringify(key.anchor)}; export const ALLOW_FOUNDATION=true;`,
      };
    },
  });
}
export function signedFixture(key: ReturnType<typeof testKey>, version = "0.5.0", synthetic = false) {
  const root = temporary(),
    release = join(root, "release");
  fs.mkdirSync(release);
  let payload: Record<string, Buffer>;
  if (synthetic)
    payload = {
      "product/src/a.ts": Buffer.from("export const a=1;\n"),
      "product/deep/b.ts": Buffer.from("export const b=2;\n"),
      "product/trajecta-extract.mjs": fs.readFileSync(join(ROOT, "product/trajecta-extract.mjs")),
    };
  else {
    foundationPayload ??= unpack(build("foundation", false), "trajecta-0.5.0");
    payload = { ...foundationPayload };
    delete payload["MANIFEST.json"];
    const pkg = JSON.parse(payload["product/package.json"].toString());
    pkg.version = version;
    payload["product/package.json"] = Buffer.from(JSON.stringify(pkg, null, 2) + "\n");
  }
  const manifest = {
    schema: "trajecta.manifest/v1",
    artifact: "foundation",
    version,
    node: ">=22.19 <23 || >=24 <25",
    engines: { identity: "98313ac335a533732630b2ba7039180e4bb89dcf", work: "5c696187eb5df5be7341f88296c5462488a5ae27" },
    files: Object.fromEntries(
      Object.entries(payload)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, bytes]) => [path, { size: bytes.length, sha256: sha(bytes) }]),
    ),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const bytes = tarball({ ...payload, "MANIFEST.json": manifestBytes }, `trajecta-${version}`),
    metadata = releaseMetadata(bytes, version);
  const metadataBytes = Buffer.from(JSON.stringify(metadata, null, 2) + "\n"),
    signature = Buffer.from(key.sign(metadataBytes));
  fs.writeFileSync(join(release, `trajecta-${version}.tar.gz`), bytes);
  fs.writeFileSync(join(release, "trajecta-extract.mjs"), payload["product/trajecta-extract.mjs"]);
  fs.writeFileSync(join(release, "release.json"), metadataBytes);
  fs.writeFileSync(join(release, "release.json.sig"), signature);
  const env = {
    ...isolatedEnv(root),
    PATH: dirname(process.execPath) + (process.platform === "win32" ? ";" : ":") + (process.env.PATH ?? ""),
    NODE_OPTIONS: "--import=" + new URL("./install-hook.ts", import.meta.url).href,
    TEST_TRUST_ANCHOR: key.anchor,
  };
  fs.cpSync(join(ROOT, "engines/trajecta_identity/profiles"), env.TRAJECTA_IDENTITY_PROFILES, { recursive: true });
  return { root, release, env, version, manifest, payload, manifestBytes, metadata, metadataBytes, signature };
}
export function recoveryFixture(f: ReturnType<typeof signedFixture>): string {
  const folder = join(f.root, "install/.uninstall");
  fs.mkdirSync(folder, { recursive: true });
  for (const [name, bytes] of Object.entries(f.payload).filter(([name]) => name.startsWith("product/"))) {
    fs.mkdirSync(dirname(join(folder, name)), { recursive: true });
    fs.writeFileSync(join(folder, name), bytes);
  }
  fs.writeFileSync(join(folder, "MANIFEST.json"), f.manifestBytes);
  fs.writeFileSync(join(folder, "release.json"), f.metadataBytes);
  fs.writeFileSync(join(folder, "release.json.sig"), f.signature);
  fs.writeFileSync(join(folder, "node"), "INERT -- must never execute\n");
  fs.writeFileSync(join(folder, "DIGESTS.json"), "untrusted inert list\n");
  return folder;
}
