import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { unpack } from "../tools/archive.ts";
import { build } from "../tools/build-release.ts";
import { ROOT, temporary } from "./support.ts";
import { posixWrapper, userStub, windowsWrapper } from "../product/src/wrappers.ts";
import { windowsValidator } from "../product/src/windows-validator.ts";
import { TEMPLATE_ROOTS } from "./template-roots.ts";
const modulePath = new URL("../product/src/templates.ts", import.meta.url);
const subject = fs.existsSync(modulePath) ? await import(modulePath.href) : null;

test("Windows FOR options keep the exact node whitelist with its space last", () => {
  const expected = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:;\\/._-+=,[]{}?@#$'`~ ";
  for (const name of ["trajecta.cmd.tmpl", "trajecta-mcp.cmd.tmpl"] as const) {
    const source = subject.readTemplate(name),
      options = [...source.matchAll(/^for \/f "([^"]+)"/gmu)].map((m) => m[1]);
    assert.equal(options.length, 3, "a new FOR options form requires an explicit audit");
    assert.equal(options[0], "usebackq delims= eol=`");
    assert.equal(options[1], "tokens=1-5* delims=|");
    assert.equal(options[2], "eol=| delims=" + expected, name + ": only a final space belongs in delims");
  }
});

test("§13.8 a real 33-character root never puts a cmd delimiter in its encoded validator", () => {
  const root = "C:\\" + "r".repeat(30),
    raw = windowsValidator(root),
    wrapper = windowsWrapper(root, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", false),
    encoded = wrapper.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)![1];
  assert.equal(root.length, 33);
  assert.match(Buffer.from(raw, "utf16le").toString("base64"), /=/u, "fixture must originally need padding");
  assert.doesNotMatch(encoded, /[=,;]/u);
  const decoded = Buffer.from(encoded, "base64").toString("utf16le"),
    k = [0, 1, 2].find((n) => (Buffer.byteLength(raw, "utf16le") + 2 * n) % 3 === 0)!;
  assert.equal(decoded, raw + " ".repeat(k));
  assert(!wrapper.includes("^="));
});

test("§13.8 one thousand deterministic mixed roots obey delimiter and 8000-character bounds", () => {
  let seed = 0x13_08_2026;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const alphabet = [..."abZ09 _.-@@'đ界é😀"],
    classes = new Set<number>();
  for (let i = 0; i < 1000; i++) {
    const length = i === 999 ? 240 : 3 + (next() % 238);
    let root = "C:\\";
    while (root.length < length) {
      const ch = alphabet[next() % alphabet.length];
      root += root.length + ch.length <= length ? ch : "x";
    }
    const raw = windowsValidator(root),
      original = Buffer.from(raw, "utf16le").toString("base64");
    classes.add(original.length - original.replace(/=+$/u, "").length);
    for (const mcp of [false, true]) {
      const rendered = windowsWrapper(root, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", mcp),
        encoded = rendered.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)![1];
      assert.doesNotMatch(encoded, /[=,;]/u, root);
      assert(
        rendered.split(/\r?\n/u).every((line) => line.length <= 8000),
        root,
      );
      assert.equal(Buffer.from(encoded, "base64").length % 3, 0);
      const k = [0, 1, 2].find((n) => (Buffer.byteLength(raw, "utf16le") + 2 * n) % 3 === 0)!;
      assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), raw + " ".repeat(k));
    }
  }
  assert.deepEqual([...classes].sort(), [0, 1, 2]);
});

test("§13.8 an encoder delimiter fault refuses with TemplateError", (t) => {
  assert.equal(typeof subject.encodePowerShell, "function");
  const original = Buffer.prototype.toString;
  for (const bad of ["AAA=", "AA,A", "AA;A"]) {
    const seam = t.mock.method(Buffer.prototype, "toString", function (encoding: BufferEncoding, ...args: any[]) {
      return encoding === "base64" ? bad : Reflect.apply(original, this, [encoding, ...args]);
    });
    try {
      assert.throws(() => subject.encodePowerShell("exit 0"), subject.TemplateError);
    } finally {
      seam.mock.restore();
    }
  }
});

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

test("§13.6 every rendered template matches its checked-in A/B and token-root golden bytes", () => {
  assert(subject);
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  for (const [id, root] of TEMPLATE_ROOTS) {
    const validator = subject.renderTemplate("validator.ps1.tmpl", subject.readTemplate("validator.ps1.tmpl"), {
      root,
    });
    if (id.startsWith("padding-")) {
      const original = Buffer.from(validator, "utf16le").toString("base64");
      assert.equal(original.length - original.replace(/=+$/u, "").length, Number(id.at(-1)));
    }
    for (const name of Object.keys(subject.TEMPLATE_COUNTS)) {
      const actual = subject.renderTemplate(name, subject.readTemplate(name), { root, powershell: ps, validator });
      if (name.endsWith(".cmd.tmpl"))
        assert.doesNotMatch(actual.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)![1], /[=,;]/u);
      assert.deepEqual(
        Buffer.from(actual),
        fs.readFileSync(new URL(`./fixtures/templates/${id}/${name}.golden`, import.meta.url)),
        `${id}/${name}`,
      );
    }
  }
});
