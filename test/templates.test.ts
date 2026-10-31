import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { unpack } from "../tools/archive.ts";
import { build } from "../tools/build-release.ts";
import { ROOT, temporary } from "./support.ts";
import { posixWrapper, userStub, windowsWrapper } from "../product/src/wrappers.ts";
const modulePath = new URL("../product/src/templates.ts", import.meta.url);
const subject = fs.existsSync(modulePath) ? await import(modulePath.href) : null;

test("§13.6 canonical six-template table drives release inventory and two identical builds", () => {
  assert(subject, "canonical template renderer is not implemented");
  const names = Object.keys(subject.TEMPLATE_COUNTS).sort();
  assert.deepEqual(names, [
    "trajecta-mcp.cmd.tmpl",
    "trajecta-mcp.sh.tmpl",
    "trajecta.cmd.tmpl",
    "trajecta.sh.tmpl",
    "user-stub.sh.tmpl",
    "validator.ps1.tmpl",
  ]);
  const a = build("release", false),
    b = build("release", false);
  assert.deepEqual(a, b);
  const files = unpack(a, "trajecta-0.5.0"),
    manifest = JSON.parse(files["MANIFEST.json"].toString());
  assert.equal(manifest.artifact, "release");
  assert.deepEqual(
    Object.keys(files)
      .filter((p) => p.startsWith("bin/"))
      .sort(),
    names.map((n) => "bin/templates/" + n),
  );
  for (const name of names)
    assert.deepEqual(files["bin/templates/" + name], fs.readFileSync(join(ROOT, "bin/templates", name)));
  assert(
    !Object.keys(files).some((name) => name.endsWith(".ps1")),
    "pre-verification bootstrap is external, never installed under root",
  );
});
test("§13.6 single-pass golden rendering never rescans token-shaped roots or shell data", () => {
  assert(subject, "canonical template renderer is not implemented");
  for (const root of ["/isolated/A", "/isolated/B", "/tmp/@@ROOT_SH@@", "/tmp/'\"$ ` folder"]) {
    const bytes = fs.readFileSync(join(ROOT, "bin/templates/user-stub.sh.tmpl"), "utf8");
    const quoted = "'" + root.replaceAll("'", "'\\''") + "'";
    const expected = `#!/bin/sh\nR=${quoted}\n[ -f "$R/bin/trajecta" ] || { printf 'trajecta: not installed at %s; run the installer, or remove %s\\n' "$R" "$0" >&2; exit 1; }\nexec /bin/sh "$R/bin/trajecta" "$@"\n`;
    assert.equal(subject.renderTemplate("user-stub.sh.tmpl", bytes, { root }), expected);
    assert.equal(userStub(root), expected);
  }
  assert.notEqual(posixWrapper("/isolated/A", false), posixWrapper("/isolated/B", false));
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  assert.notEqual(windowsWrapper("C:\\A", ps, false), windowsWrapper("C:\\B", ps, false));
});
test("§13.6 build refuses missing, extra, duplicated-token and malformed-token templates", () => {
  assert(subject, "canonical template renderer is not implemented");
  for (const kind of ["missing", "extra", "duplicate", "unknown", "stray"]) {
    const folder = join(temporary(), "templates");
    fs.cpSync(join(ROOT, "bin/templates"), folder, { recursive: true });
    const path = join(folder, "user-stub.sh.tmpl");
    if (kind === "missing") fs.unlinkSync(path);
    else if (kind === "extra") fs.writeFileSync(join(folder, "extra.tmpl"), "foreign");
    else fs.appendFileSync(path, kind === "duplicate" ? "@@ROOT_SH@@" : kind === "unknown" ? "@@OTHER@@" : "@@broken");
    assert.throws(() => build("release", false, folder), subject.TemplateError, kind);
  }
});
