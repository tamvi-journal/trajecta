import assert from "node:assert/strict";
import test from "node:test";
import { testKey } from "./install-fixture.ts";
import { canonical, parseCanonical } from "../product/src/update-json.ts";
import { decideIndex, resetIndex, encodeState, decodeState } from "../product/src/update-state.ts";
const a = testKey(),
  b = testKey();
const row = { version: "0.5.0", release_sha256: "a".repeat(64) };
function index(sequence: number, rotations: any[] = [], key = a, expires = "2099-01-01T00:00:00Z") {
  const bytes = Buffer.from(
    canonical({ schema: "trajecta.index/v1", sequence, expires, latest: "0.5.0", releases: [row], rotations }),
  );
  return { bytes, signature: key.sign(bytes) };
}
const initial = () => ({ schema: "trajecta.update-state/v2" as const, floor: 1, accepted: null, rotations: [] });
test("canonical boundary refuses duplicate fields, noncanonical bytes and unsafe integers", () => {
  assert.equal(canonical({ b: 1, a: "x" }), '{"a":"x","b":1}');
  for (const s of ['{"a":1,"a":1}', '{ "a":1}', '{"a":1.0}', '{"a":9007199254740993}'])
    assert.throws(() => parseCanonical(Buffer.from(s)));
});
test("state checksum and paired accepted fields fail closed", () => {
  const state = initial(),
    bytes = encodeState(state);
  assert.deepEqual(decodeState(bytes, a.anchor), state);
  assert.throws(() => decodeState(Buffer.concat([bytes, Buffer.from("x")]), a.anchor));
  assert.throws(() =>
    decodeState(encodeState({ ...state, accepted: { sequence: 2, index_sha256: "a".repeat(64) } }), a.anchor),
  );
});
test("ordered freshness/floor/known/conflict and rotation signer point", () => {
  const body = { schema: "trajecta.rotation/v1", from: a.anchor, to: b.anchor, sequence: 10 };
  const rotation = { ...body, signature: a.sign(Buffer.from(canonical(body))).trim() };
  const i10 = index(10, [rotation]),
    d = decideIndex(i10.bytes, i10.signature, initial(), a.anchor);
  assert.equal(d.state.floor, 10);
  assert.equal(d.keys.at(-1), b.anchor);
  assert.equal(decideIndex(i10.bytes, "bad", d.state, a.anchor).known, true);
  assert.throws(() => decideIndex(i10.bytes, i10.signature, { ...d.state, floor: 20 }, a.anchor), /replay/);
  const i21 = index(21, [rotation], b);
  assert.equal(decideIndex(i21.bytes, i21.signature, d.state, a.anchor).state.floor, 21);
  assert.throws(
    () => decideIndex(index(10, [], b).bytes, index(10, [], b).signature, d.state, a.anchor),
    /conflicting/,
  );
  assert.throws(() => decideIndex(index(9, [], a, "2000-01-01T00:00:00Z").bytes, "bad", d.state, a.anchor), /expired/);
  assert.equal(resetIndex(i10.bytes, i10.signature, 10, a.anchor).keys.at(-1), b.anchor);
  assert.equal(resetIndex(i21.bytes, i21.signature, 10, a.anchor).state.floor, 21);
  assert.throws(() => resetIndex(i10.bytes, i10.signature, 11, a.anchor), /floor/);
});
test("forged, broken, reordered and future rotations refuse without changing input", () => {
  const body = { schema: "trajecta.rotation/v1", from: a.anchor, to: b.anchor, sequence: 10 };
  const r = { ...body, signature: a.sign(Buffer.from(canonical(body))).trim() };
  for (const rotations of [
    [{ ...r, sequence: 11 }],
    [{ ...r, from: b.anchor }],
    [{ ...r, signature: b.sign(Buffer.from(canonical(body))).trim() }],
    [r, r],
    [{ ...r, to: a.anchor }],
  ]) {
    const i = index(10, rotations),
      state = initial(),
      before = encodeState(state);
    assert.throws(() => decideIndex(i.bytes, i.signature, state, a.anchor));
    assert.throws(() => resetIndex(i.bytes, i.signature, 1, a.anchor));
    assert(encodeState(state).equals(before));
  }
});

test("canonical update values agree with the pinned R0 writer", async () => {
  const { canonicalJson, orderedObject, pyInt } = await import("../engines/identity/src/encoding.ts");
  const obj = { text: "é𐀀😀\n\t\u0000", n: Number.MAX_SAFE_INTEGER, values: [null, true, -10] };
  const expected = canonicalJson(
    orderedObject([
      ["text", obj.text],
      ["n", pyInt(obj.n)],
      ["values", [null, true, pyInt(-10)]],
    ]),
  );
  assert.equal(canonical(obj), expected);
});

test("BOM and invalid UTF-8 are noncanonical; authorized return rotations obey the same three rules", () => {
  assert.throws(() => parseCanonical(Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("{}")])));
  assert.throws(() => parseCanonical(Buffer.from([0xc0, 0xaf])));
  const first = { schema: "trajecta.rotation/v1", from: a.anchor, to: b.anchor, sequence: 10 };
  const second = { schema: "trajecta.rotation/v1", from: b.anchor, to: a.anchor, sequence: 10 };
  const rotations = [
    { ...first, signature: a.sign(Buffer.from(canonical(first))).trim() },
    { ...second, signature: b.sign(Buffer.from(canonical(second))).trim() },
  ];
  const i = index(10, rotations);
  assert.equal(decideIndex(i.bytes, i.signature, initial(), a.anchor).keys.at(-1), a.anchor);
});
