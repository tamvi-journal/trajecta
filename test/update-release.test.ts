import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { signedFixture, testKey, useTestKey } from "./install-fixture.ts";
import { createHash } from "node:crypto";
import { tree } from "./support.ts";
const k0 = testKey(),
  k1 = testKey(),
  outside = testKey();
test("index-pinned metadata permits every chain signer and refuses an outside signer or altered digest", () => {
  for (const signer of [k0, k1, outside]) {
    const f = signedFixture(signer),
      mirror = join(f.root, "mirror"),
      folder = join(mirror, "v0.5.0");
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(join(f.release, "release.json"), join(folder, "release.json"));
    fs.copyFileSync(join(f.release, "release.json.sig"), join(folder, "release.json.sig"));
    const env = { ...f.env, TEST_TRUST_ANCHOR: k0.anchor },
      before = tree(f.root);
    const script = `const {fetchReleaseMetadata}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "product/src/update-fetch.ts")).href)});
      try {await fetchReleaseMetadata("0.5.0",process.argv[1],${JSON.stringify([k0.anchor, k1.anchor])},process.argv[2]);}
      catch(error){console.error(error.message);process.exitCode=1;}`;
    let result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script, f.metadata.manifest_sha256, mirror],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /index\/release digest mismatch/);
    result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        script,
        createHash("sha256").update(f.metadataBytes).digest("hex"),
        mirror,
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status, signer === outside ? 1 : 0, result.stderr);
    if (signer === outside) assert.match(result.stderr, /signature mismatch/);
    assert.deepEqual(tree(f.root), before);
  }
});

test("valid chain verifies an installed K1 version; lost history asks for reset, K0 remains readable", async () => {
  useTestKey(k0);
  const { verifyVersion } = await import("../product/src/owned.ts");
  for (const signer of [k0, k1]) {
    const f = signedFixture(signer),
      folder = join(f.root, "install/0.5.0");
    fs.mkdirSync(folder, { recursive: true });
    // The fixture's payload and signed controls are unchanged, as installed by Phase B.
    for (const [name, bytes] of Object.entries(f.payload)) {
      const path = join(folder, name);
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.writeFileSync(path, bytes);
    }
    fs.writeFileSync(join(folder, "MANIFEST.json"), f.manifestBytes);
    fs.copyFileSync(join(f.release, "release.json"), join(folder, "release.json"));
    fs.copyFileSync(join(f.release, "release.json.sig"), join(folder, "release.json.sig"));
    fs.writeFileSync(join(folder, "node"), process.execPath + "\n");
    assert.equal(verifyVersion(folder, [k0.anchor, k1.anchor]).version, "0.5.0");
    if (signer === k1) assert.throws(() => verifyVersion(folder, [k0.anchor]), /needs --reset-state/);
    else assert.equal(verifyVersion(folder, [k0.anchor]).version, "0.5.0");
  }
});
