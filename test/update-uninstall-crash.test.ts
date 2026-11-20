import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { canonical } from "../product/src/update-json.ts";
import { encodeState, decodeState } from "../product/src/update-state.ts";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI, tree } from "./support.ts";

const k0 = testKey(),
  k1 = testKey();
function invoke(
  f: ReturnType<typeof signedFixture>,
  verb: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, verb, "--root", join(f.root, "install"), ...args],
    { env: { ...f.env, ...env }, encoding: "utf8" },
  );
}
function installing(f: ReturnType<typeof signedFixture>, env: Record<string, string> = {}) {
  return invoke(
    f,
    "install",
    [
      "--release",
      f.release,
      "--db",
      join(f.root, "identity/example.sqlite3"),
      "--work-root",
      join(f.root, "work"),
      "--no-user-bin",
    ],
    env,
  );
}
function setup(rotated: boolean) {
  // Install with the fixture's ephemeral embedded key, then simulate an older
  // installed binary that trusts the rotation from K0, as a rollback would.
  const signer = rotated ? k1 : k0,
    f = signedFixture(signer),
    r = installing(f);
  assert.equal(r.status, 0, r.stderr);
  if (!rotated)
    fs.writeFileSync(
      join(f.root, "install/update-state.json"),
      encodeState({
        schema: "trajecta.update-state/v2",
        floor: 10,
        accepted: null,
        rotations: [],
      }),
    );
  if (rotated) {
    const body = { schema: "trajecta.rotation/v1", from: k0.anchor, to: k1.anchor, sequence: 1 };
    const rotation = { ...body, signature: k0.sign(Buffer.from(canonical(body))).trim() };
    fs.writeFileSync(
      join(f.root, "install/update-state.json"),
      encodeState({
        schema: "trajecta.update-state/v2",
        floor: 10,
        accepted: null,
        rotations: [rotation as any],
      }),
    );
    f.env.TEST_TRUST_ANCHOR = k0.anchor;
  }
  return f;
}
for (const rotated of [false, true])
  for (const confirm of [false, true]) {
    test("step-6 kill recovery " + (rotated ? "K1" : "K0") + " consent=" + confirm, () => {
      const points = [
        "U:temps",
        "U:claims",
        "U:owned",
        "U:recovery-cleanup",
        "U:state-decided",
        ...(confirm ? ["U:state-removed"] : []),
        "U:current",
        "U:lock-released",
        ...(confirm ? ["U:root"] : []),
      ];
      for (const point of points) {
        const f = setup(rotated),
          root = join(f.root, "install");
        const killed = invoke(f, "uninstall", [], {
          TEST_KILL_AT: point,
          ...(confirm ? { TEST_CONFIRM_RESET: "yes" } : {}),
        });
        assert.notEqual(killed.status, 0, point);
        const hasState = fs.existsSync(join(root, "update-state.json"));
        const beforeRemoval = ["U:temps", "U:claims", "U:owned", "U:recovery-cleanup", "U:state-decided"];
        assert.equal(hasState, !confirm || beforeRemoval.includes(point), point);
        if (["U:state-removed", "U:recovery-cleanup", "U:state-decided"].includes(point)) {
          const stateBefore = hasState ? fs.readFileSync(join(root, "update-state.json")) : undefined;
          const candidate = rotated ? signedFixture(k0) : f;
          const args = [
            "--release",
            candidate.release,
            "--db",
            join(f.root, "identity/example.sqlite3"),
            "--work-root",
            join(f.root, "work"),
            "--no-user-bin",
          ];
          const noTTY = invoke(f, "install", args);
          if (!hasState) {
            assert.equal(noTTY.status, 1, point);
            assert.match(noTTY.stderr, /previous uninstall ended without update state/);
            assert.equal(fs.readFileSync(join(root, "current"), "utf8"), "uninstalling\n");
            assert(!fs.existsSync(join(root, "update-state.json")));
            const retry = invoke(f, "install", args, { TEST_CONFIRM_RESET: "yes" });
            assert.equal(retry.status, 0, retry.stderr);
          } else {
            assert.equal(noTTY.status, 0, noTTY.stderr);
            assert(fs.readFileSync(join(root, "update-state.json")).equals(stateBefore!));
          }
        } else if (beforeRemoval.includes(point)) {
          const retry = invoke(f, "uninstall", ["--resume"], confirm ? {} : { TEST_CONFIRM_RESET: "yes" });
          assert.equal(retry.status, 0, point + ": " + retry.stderr);
          assert.equal(fs.existsSync(join(root, "update-state.json")), confirm, point);
        } else {
          // After current unlink there is no sentinel-based implicit consent.
          assert(!fs.existsSync(join(root, "current")), point);
          const candidate = rotated ? signedFixture(k0) : f;
          const retried = invoke(f, "install", [
            "--release",
            candidate.release,
            "--db",
            join(f.root, "identity/example.sqlite3"),
            "--work-root",
            join(f.root, "work"),
            "--no-user-bin",
          ]);
          assert.equal(retried.status, 0, retried.stderr);
          assert.equal(
            decodeState(fs.readFileSync(join(root, "update-state.json")), k0.anchor).floor,
            confirm ? 1 : 10,
            point,
          );
        }
      }
    });
  }
test("post-E missing state, byte guard and unexpected marker refuse with protected data intact", () => {
  for (const foreign of ["none", "update-state.reset", "extra", "bad-sentinel"]) {
    const f = setup(false),
      root = join(f.root, "install");
    const killed = invoke(f, "uninstall", [], { TEST_KILL_AT: "U:state-decided" });
    assert.notEqual(killed.status, 0);
    fs.unlinkSync(join(root, "update-state.json"));
    if (foreign === "bad-sentinel") fs.writeFileSync(join(root, "current"), "uninstalling\r\n");
    else if (foreign !== "none") fs.writeFileSync(join(root, foreign), "");
    const before = tree(root),
      r = installing(f);
    assert.equal(r.status, 1, r.stderr);
    const after = tree(root);
    delete before[".lock"];
    delete after[".lock"];
    for (const name of Object.keys(before).filter((n) => n.startsWith(".lock.claim."))) delete before[name];
    for (const name of Object.keys(after).filter((n) => n.startsWith(".lock.claim."))) delete after[name];
    assert.deepEqual(after, before);
    assert(!fs.existsSync(join(root, "update-state.json")));
  }
});

test("K1 bootstrap fallback uses persisted chain before cleanup; losing state refuses before extraction", async () => {
  const { bootstrapSource } = await import("../tools/bootstrap-build.ts");
  for (const missing of [false, true]) {
    const f = setup(true),
      root = join(f.root, "install");
    const killed = invoke(f, "uninstall", [], { TEST_KILL_AT: "U:owned", TEST_CONFIRM_RESET: "yes" });
    assert.notEqual(killed.status, 0);
    if (missing) fs.unlinkSync(join(root, "update-state.json"));
    const before = tree(join(root, ".uninstall"));
    const url =
      "data:text/javascript;base64," + Buffer.from(bootstrapSource()).toString("base64") + "#trajecta-bootstrap";
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        "await import(process.env.TEST_BOOTSTRAP_URL)",
        "--",
        "--resume-uninstall",
        "--root",
        root,
        "--release",
        f.release,
      ],
      {
        env: { ...f.env, TEST_BOOTSTRAP_URL: url },
        encoding: "utf8",
      },
    );
    if (missing) {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /needs --reset-state/);
      assert.deepEqual(tree(join(root, ".uninstall")), before);
      assert(!fs.readdirSync(root).some((name) => name.startsWith(".staging-")));
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(Object.keys(tree(root)), ["update-state.json"]);
      assert.equal(decodeState(fs.readFileSync(join(root, "update-state.json")), k0.anchor).rotations.length, 1);
    }
  }
});
