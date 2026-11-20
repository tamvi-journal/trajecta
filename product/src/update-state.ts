import * as fs from "node:fs";
import { hostname } from "node:os";
import { owner } from "./install-lock.ts";
import { TRUST_ANCHOR } from "./trust.ts";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { canonical, parseCanonical, fields, positiveSequence } from "./update-json.ts";
import { atomic, digest, regular, syncDir } from "./install-fs.ts";
import { base64 } from "./release.ts";

export type Rotation = {
  schema: "trajecta.rotation/v1";
  from: string;
  to: string;
  sequence: number;
  signature: string;
};
export type UpdateState = {
  schema: "trajecta.update-state/v2";
  floor: number;
  accepted: null | { sequence: number; index_sha256: string };
  rotations: Rotation[];
};
export type Index = {
  schema: "trajecta.index/v1";
  sequence: number;
  expires: string;
  latest: string;
  releases: { version: string; release_sha256: string }[];
  rotations: Rotation[];
};
export const STATE_RECOVERY = "update state missing or corrupt; run trajecta update --reset-state";
export function signatureMatches(bytes: Buffer, signature: string, anchor: string): boolean {
  const key = createPublicKey({ key: base64(anchor), format: "der", type: "spki" });
  return key.asymmetricKeyType === "ed25519" && verify(null, bytes, key, base64(signature, 64));
}
function rotationFields(rotation: any): void {
  fields(rotation, ["schema", "from", "to", "sequence", "signature"]);
  if (
    rotation.schema !== "trajecta.rotation/v1" ||
    !positiveSequence(rotation.sequence) ||
    typeof rotation.from !== "string" ||
    typeof rotation.to !== "string" ||
    typeof rotation.signature !== "string"
  )
    throw new Error("invalid rotation");
  for (const anchor of [rotation.from, rotation.to]) {
    const key = createPublicKey({ key: base64(anchor), format: "der", type: "spki" });
    if (anchor.endsWith("\n") || key.asymmetricKeyType !== "ed25519") throw new Error("invalid rotation key");
  }
  base64(rotation.signature, 64);
}
function walkRotations(rotations: Rotation[], anchor: string, ceiling: number): string[] {
  const keys = [anchor];
  let previous = 0;
  for (const statement of rotations) {
    rotationFields(statement);
    const { signature, ...body } = statement;
    if (
      statement.from !== keys.at(-1) ||
      statement.sequence < previous ||
      statement.sequence > ceiling ||
      keys.includes(statement.to) ||
      !signatureMatches(Buffer.from(canonical(body)), signature, statement.from)
    )
      throw new Error("invalid rotation chain");
    keys.push(statement.to);
    previous = statement.sequence;
  }
  return keys;
}
export function stateKeys(state: UpdateState, anchor: string): string[] {
  return walkRotations(state.rotations, anchor, state.floor);
}
export function encodeState(state: UpdateState): Buffer {
  const line = canonical(state);
  return Buffer.from(line + "\nsha256:" + digest(Buffer.from(line)) + "\n");
}
export function decodeState(bytes: Buffer, anchor: string): UpdateState {
  const lines = bytes.toString("utf8").split("\n");
  if (lines.length !== 3 || lines[2] !== "" || lines[1] !== "sha256:" + digest(Buffer.from(lines[0])))
    throw new Error(STATE_RECOVERY);
  const state = parseCanonical(Buffer.from(lines[0]));
  fields(state, ["schema", "floor", "accepted", "rotations"]);
  if (state.schema !== "trajecta.update-state/v2" || !positiveSequence(state.floor) || !Array.isArray(state.rotations))
    throw new Error(STATE_RECOVERY);
  if (state.accepted !== null) {
    fields(state.accepted, ["sequence", "index_sha256"]);
    if (
      !positiveSequence(state.accepted.sequence) ||
      state.accepted.sequence > state.floor ||
      !/^[a-f0-9]{64}$/u.test(state.accepted.index_sha256)
    )
      throw new Error(STATE_RECOVERY);
  }
  stateKeys(state, anchor);
  // Decode to ordinary records only after duplicate and canonical validation.
  return {
    ...state,
    accepted: state.accepted && { ...state.accepted },
    rotations: state.rotations.map((r: Rotation) => ({ ...r })),
  };
}
export function readState(root: string, anchor: string): UpdateState {
  try {
    const path = join(root, "update-state.json");
    if (!regular(path)) throw new Error(STATE_RECOVERY);
    return decodeState(fs.readFileSync(path), anchor);
  } catch {
    throw new Error(STATE_RECOVERY);
  }
}
function requireStateLock(root: string): void {
  const path = join(root, ".lock");
  const held = regular(path) ? owner(fs.readFileSync(path)) : null;
  if (!held || held.pid !== process.pid || held.hostname !== hostname())
    throw new Error("update state write requires the owning install lock");
}
/** Called only while the caller owns the install lock. Never used by --check. */
export function clearStateTemp(root: string): void {
  requireStateLock(root);
  const path = join(root, "update-state.json.tmp");
  if (regular(path)) {
    fs.unlinkSync(path);
    syncDir(root);
  }
}
export function writeState(root: string, state: UpdateState): void {
  clearStateTemp(root);
  atomic(join(root, "update-state.json"), encodeState(state), "update-state");
}
export function parseIndex(bytes: Buffer): Index {
  const index = parseCanonical(bytes);
  fields(index, ["schema", "sequence", "expires", "latest", "releases", "rotations"]);
  if (
    index.schema !== "trajecta.index/v1" ||
    !positiveSequence(index.sequence) ||
    typeof index.expires !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(index.expires) ||
    !Number.isFinite(Date.parse(index.expires)) ||
    new Date(index.expires).toISOString() !== index.expires.replace("Z", ".000Z") ||
    !Array.isArray(index.releases) ||
    !index.releases.length ||
    !Array.isArray(index.rotations)
  )
    throw new Error("invalid update index");
  let previous = "";
  for (const row of index.releases) {
    fields(row, ["version", "release_sha256"]);
    if (
      typeof row.version !== "string" ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(row.version) ||
      row.version <= previous ||
      !/^[a-f0-9]{64}$/u.test(row.release_sha256)
    )
      throw new Error("invalid index release");
    previous = row.version;
  }
  if (!index.releases.some((r: any) => r.version === index.latest)) throw new Error("index latest is not listed");
  for (const rotation of index.rotations) rotationFields(rotation);
  return index;
}
function freshness(index: Index, now: number): void {
  if (Date.parse(index.expires) <= now)
    throw new Error("update index expired (" + index.expires + "); nothing changed");
}
export function decideIndex(bytes: Buffer, signature: string, state: UpdateState, anchor: string, now = Date.now()) {
  const index = parseIndex(bytes);
  freshness(index, now);
  if (index.sequence < state.floor) throw new Error("update index replay; nothing changed");
  const hash = digest(bytes),
    keys = stateKeys(state, anchor);
  if (state.accepted && hash === state.accepted.index_sha256) return { index, state, keys, known: true };
  if (state.accepted && index.sequence === state.accepted.sequence)
    throw new Error("conflicting update index; nothing changed");
  if (!signatureMatches(bytes, signature, keys.at(-1)!)) throw new Error("update index signature mismatch");
  if (
    index.rotations.length < state.rotations.length ||
    state.rotations.some((r, i) => canonical(r) !== canonical(index.rotations[i]))
  )
    throw new Error("incomplete rotation history");
  for (const rotation of index.rotations.slice(state.rotations.length))
    if (rotation.sequence !== index.sequence) throw new Error("rotation sequence differs from index");
  const next: UpdateState = {
    schema: "trajecta.update-state/v2",
    floor: Math.max(state.floor, index.sequence),
    accepted: { sequence: index.sequence, index_sha256: hash },
    rotations: index.rotations,
  };
  return { index, state: next, keys: stateKeys(next, anchor), known: false };
}
export function resetIndex(bytes: Buffer, signature: string, manifestFloor: number, anchor: string, now = Date.now()) {
  const index = parseIndex(bytes);
  freshness(index, now);
  if (index.sequence < manifestFloor) throw new Error("update index below manifest floor");
  const keys = walkRotations(index.rotations, anchor, index.sequence);
  const signer = walkRotations(
    index.rotations.filter((r) => r.sequence < index.sequence),
    anchor,
    index.sequence,
  ).at(-1)!;
  if (!signatureMatches(bytes, signature, signer)) throw new Error("update index signature mismatch");
  const state: UpdateState = {
    schema: "trajecta.update-state/v2",
    floor: Math.max(manifestFloor, index.sequence),
    accepted: { sequence: index.sequence, index_sha256: digest(bytes) },
    rotations: index.rotations,
  };
  return { index, state, keys, known: false };
}

/** Step 7, for the update writer. The caller already owns the single install lock. */
export function acceptIndex(root: string, bytes: Buffer, signature: string) {
  requireStateLock(root);
  const decision = decideIndex(bytes, signature, readState(root, TRUST_ANCHOR), TRUST_ANCHOR);
  if (!decision.known) writeState(root, decision.state);
  return decision;
}
