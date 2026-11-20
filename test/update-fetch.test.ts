import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import https from "node:https";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { canonical } from "../product/src/update-json.ts";
import { signedFixture, testKey } from "./install-fixture.ts";
import { CLI, tree } from "./support.ts";

test("local HTTPS: valid check is pure; redirect, scheme, caps, timeout and truncation fail closed", async () => {
  const key = testKey(),
    f = signedFixture(key),
    root = join(f.root, "install");
  const installed = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      CLI,
      "install",
      "--root",
      root,
      "--release",
      f.release,
      "--db",
      join(f.root, "identity/example.sqlite3"),
      "--work-root",
      join(f.root, "work"),
      "--no-user-bin",
    ],
    { env: f.env, encoding: "utf8" },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const cert = join(f.root, "cert.pem"),
    pem = join(f.root, "tls.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      pem,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const tlsKey = fs.readFileSync(pem);
  fs.unlinkSync(pem);
  const bytes = Buffer.from(
    canonical({
      schema: "trajecta.index/v1",
      sequence: 10,
      expires: "2099-01-01T00:00:00Z",
      latest: "0.5.0",
      releases: [{ version: "0.5.0", release_sha256: "a".repeat(64) }],
      rotations: [],
    }),
  );
  const signature = key.sign(bytes);
  let mode = "ok",
    requests = 0;
  const server = https.createServer({ key: tlsKey, cert: fs.readFileSync(cert) }, (req, res) => {
    requests++;
    if (mode === "host" || mode === "http") {
      res.writeHead(302, { location: mode === "host" ? "https://example.invalid/index" : "http://127.0.0.1/index" });
      res.end();
      return;
    }
    const url = new URL(req.url!, "https://127.0.0.1");
    if (mode.startsWith("redirect-")) {
      const hop = Number(url.searchParams.get("hop") ?? "0");
      if (hop < Number(mode.slice("redirect-".length))) {
        res.writeHead(302, { location: url.pathname + "?hop=" + (hop + 1) });
        res.end();
        return;
      }
    }
    if (mode === "redirect-loop") {
      res.writeHead(302, { location: req.url });
      res.end();
      return;
    }
    if (mode === "large-header") {
      res.writeHead(200, { "content-length": 1024 * 1024 + 1 });
      res.end();
      return;
    }
    if (mode === "large-stream") {
      res.writeHead(200);
      res.end(Buffer.alloc(1024 * 1024 + 1));
      return;
    }
    if (mode === "timeout") return;
    if (mode === "truncated") {
      res.writeHead(200, { "content-length": bytes.length + 10 });
      res.write(bytes);
      setImmediate(() => res.destroy());
      return;
    }
    const body = url.pathname.endsWith(".sig") ? Buffer.from(signature) : bytes;
    if (mode === "gzip") {
      const zipped = gzipSync(body);
      res.writeHead(200, { "content-encoding": "gzip", "content-length": zipped.length });
      res.end(zipped);
    } else res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "https://127.0.0.1:" + (server.address() as any).port;
  async function invoke(url = base, timeout = "700") {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, "update", "--check", "--root", root], {
      env: { ...f.env, TEST_UPDATE_BASE: url, TEST_FETCH_TIMEOUT: timeout, NODE_EXTRA_CA_CERTS: cert },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    return { status, stdout, stderr };
  }
  try {
    const before = tree(root),
      ok = await invoke();
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(tree(root), before);
    mode = "gzip";
    const compressed = await invoke();
    assert.equal(compressed.status, 0, compressed.stderr);
    assert.deepEqual(tree(root), before);
    mode = "redirect-5";
    const fiveStart = requests,
      five = await invoke(base, "5000");
    assert.equal(five.status, 0, five.stderr);
    assert.equal(requests - fiveStart, 12, "index and signature each follow exactly five redirects");
    assert.deepEqual(tree(root), before);
    for (mode of ["redirect-6", "redirect-loop"]) {
      const start = requests,
        refused = await invoke(base, "5000");
      assert.equal(refused.status, 1, mode);
      assert.equal(refused.stderr, "trajecta: update redirect limit exceeded\n", mode);
      assert.equal(requests - start, 6, "the sixth redirect is refused before another request");
      assert.deepEqual(tree(root), before, mode);
    }
    for (mode of ["host", "http", "large-header", "large-stream", "timeout", "truncated"]) {
      const result = await invoke();
      assert.equal(result.status, 1, mode + ": " + result.stderr);
      assert.deepEqual(tree(root), before, mode);
    }
    const count = requests,
      result = await invoke(base.replace("https:", "http:"));
    assert.equal(result.status, 1);
    assert.equal(requests, count);
    assert.deepEqual(tree(root), before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
