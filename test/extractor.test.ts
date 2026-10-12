import * as fs from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { test } from "node:test";
import { tarball } from "../tools/archive.ts";
import { sha } from "../tools/engine-lock.ts";
import { inspect, extract } from "../product/trajecta-extract.mjs";
import { temporary } from "./support.ts";
function fixture() {
  const bytes = Buffer.from("synthetic\n");
  const manifest = {
    schema: "trajecta.manifest/v1",
    version: "0.5.0",
    artifact: "foundation",
    files: { a: { size: bytes.length, sha256: sha(bytes) } },
  };
  return tarball({ a: bytes, "MANIFEST.json": Buffer.from(JSON.stringify(manifest)) }, "trajecta-0.5.0");
}
function header(raw: Buffer, offset: number) {
  const h = raw.subarray(offset, offset + 512);
  h.fill(32, 148, 156);
  h.write(
    h
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
    148,
  );
}
test("metadata first refuses every unsafe name, special type, duplicate and size/digest mismatch before writes", () => {
  const good = fixture(),
    raw = gunzipSync(good),
    size = parseInt(raw.subarray(124, 136).toString(), 8),
    second = 512 + Math.ceil(size / 512) * 512;
  for (const name of [
    "/absolute",
    "trajecta-0.5.0/../a",
    "trajecta-0.5.0/a\\b",
    "trajecta-0.5.0/C:drive",
    "trajecta-0.5.0/a:stream",
    "trajecta-0.5.0/CON.txt",
    "trajecta-0.5.0/PRN",
    "trajecta-0.5.0/a.",
    "trajecta-0.5.0/a ",
    "foreign/a",
  ]) {
    const bad = Buffer.from(raw);
    bad.fill(0, second, second + 100);
    bad.write(name, second, 100);
    header(bad, second);
    const root = temporary(),
      staging = join(root, "stage");
    assert.throws(() => extract(gzipSync(bad), "0.5.0", staging), /archive refused/);
    assert(!fs.existsSync(staging), name);
  }
  for (const type of [0, 49, 50, 51, 52, 54, 55, 76, 75]) {
    const bad = Buffer.from(raw);
    bad[second + 156] = type;
    header(bad, second);
    const staging = join(temporary(), "stage");
    assert.throws(() => extract(gzipSync(bad), "0.5.0", staging), /archive refused/);
    assert(!fs.existsSync(staging));
  }
  const entry = raw.subarray(second, raw.length - 1024);
  const duplicate = Buffer.concat([raw.subarray(0, raw.length - 1024), entry, Buffer.alloc(1024)]);
  assert.throws(() => inspect(gzipSync(duplicate), "0.5.0"), /duplicate/);
  const changed = Buffer.from(raw);
  changed[second + 512] ^= 1;
  const staging = join(temporary(), "stage");
  assert.throws(() => extract(gzipSync(changed), "0.5.0", staging), /digest/);
  assert(!fs.existsSync(staging));
  const oversized = Buffer.from(raw);
  oversized.write("00000000777\0", second + 124);
  header(oversized, second);
  assert.throws(() => inspect(gzipSync(oversized), "0.5.0"), /archive refused/);
});
test("valid extraction preserves exact bytes and rejects existing staging", () => {
  const root = temporary(),
    staging = join(root, "stage");
  const checked = extract(fixture(), "0.5.0", staging);
  assert.equal(fs.readFileSync(join(staging, "trajecta-0.5.0/a"), "utf8"), "synthetic\n");
  assert.equal(checked.manifest.files.a.sha256, sha(Buffer.from("synthetic\n")));
  assert.throws(() => extract(fixture(), "0.5.0", staging), /already exists/);
});

test("PAX accepts path only and rejects other keys before writing", () => {
  const raw = gunzipSync(fixture()),
    size = parseInt(raw.subarray(124, 136).toString(), 8),
    second = 512 + Math.ceil(size / 512) * 512;
  function withPax(value: string) {
    let length = value.length + 3;
    for (let n = 0; n < 3; n++) length = String(length).length + 1 + value.length + 1;
    const record = Buffer.from(length + " " + value + "\n"),
      h = Buffer.from(raw.subarray(second, second + 512));
    h.fill(0, 0, 100);
    h.write("PaxHeader");
    h[156] = 120;
    h.write(record.length.toString(8).padStart(11, "0") + "\0", 124);
    header(h, 0);
    return gzipSync(
      Buffer.concat([
        raw.subarray(0, second),
        h,
        record,
        Buffer.alloc((512 - (record.length % 512)) % 512),
        raw.subarray(second),
      ]),
    );
  }
  assert.equal(inspect(withPax("path=trajecta-0.5.0/a"), "0.5.0").manifest.files.a.size, 10);
  const staging = join(temporary(), "stage");
  assert.throws(() => extract(withPax("size=10"), "0.5.0", staging), /PAX/);
  assert(!fs.existsSync(staging));
});

test("verified extractor execution is addressed by bytes, never a stale filename module cache", async () => {
  const { runVerifiedExtractor } = await import("../product/src/engines.ts");
  assert.equal(
    await runVerifiedExtractor(
      Buffer.from("export function extract(){return 'first'}"),
      Buffer.alloc(0),
      "0.5.0",
      "unused",
    ),
    "first",
  );
  assert.equal(
    await runVerifiedExtractor(
      Buffer.from("export function extract(){return 'second'}"),
      Buffer.alloc(0),
      "0.5.0",
      "unused",
    ),
    "second",
  );
});
