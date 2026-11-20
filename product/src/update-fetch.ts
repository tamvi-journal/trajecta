import * as fs from "node:fs";
import { join } from "node:path";
import { UPDATE_BASE, REDIRECT_HOSTS, FETCH_TIMEOUT_MS } from "./update-source.ts";
import { verifyMetadata } from "./release.ts";
import { digest, regular } from "./install-fs.ts";

export async function fetchUpdateFile(path: string, cap: number, from?: string): Promise<Buffer> {
  if (from) {
    const file = join(from, path.replace("latest/download/", "").replace("download/", ""));
    if (!regular(file)) throw new Error("missing update file: " + file);
    const fd = fs.openSync(file, "r");
    try {
      if (fs.fstatSync(fd).size > cap) throw new Error("update file exceeds size cap");
      const buffer = Buffer.alloc(cap + 1);
      let count = 0,
        read = 0;
      do {
        read = fs.readSync(fd, buffer, count, buffer.length - count, null);
        count += read;
      } while (read && count < buffer.length);
      if (count > cap) throw new Error("update file exceeds size cap");
      return buffer.subarray(0, count);
    } finally {
      fs.closeSync(fd);
    }
  }
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let url = new URL(UPDATE_BASE.replace(/\/$/u, "") + "/" + path);
  for (let hops = 0; ; hops++) {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (hops > 0 && !REDIRECT_HOSTS.includes(url.hostname))
    )
      throw new Error("update transport URL refused");
    const response = await fetch(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = response.headers.get("location");
      if (!next) throw new Error("update redirect missing location");
      url = new URL(next, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("update fetch failed");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > cap)) {
      await response.body.cancel();
      throw new Error("update file exceeds size cap");
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > cap) throw new Error("update file exceeds size cap");
        chunks.push(value);
      }
      // Fetch detects truncation too; the explicit length law also covers local fixtures.
      if (length !== null && !response.headers.get("content-encoding") && size !== Number(length))
        throw new Error("truncated update file");
      return Buffer.concat(chunks);
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
export async function fetchIndex(from?: string): Promise<{ bytes: Buffer; signature: string }> {
  const bytes = await fetchUpdateFile("latest/download/index.json", 1024 * 1024, from);
  const signature = await fetchUpdateFile("latest/download/index.json.sig", 64 * 1024, from);
  return { bytes, signature: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(signature) };
}

/** Fetch exact index-pinned metadata; only the verified chain can authorize its signer. */
export async function fetchReleaseMetadata(
  version: string,
  expectedDigest: string,
  keys: readonly string[],
  from?: string,
) {
  if (!/^[0-9A-Za-z.-]+$/u.test(version)) throw new Error("invalid update version");
  const bytes = await fetchUpdateFile("download/v" + version + "/release.json", 64 * 1024, from);
  if (digest(bytes) !== expectedDigest) throw new Error("index/release digest mismatch");
  const signature = await fetchUpdateFile("download/v" + version + "/release.json.sig", 64 * 1024, from);
  const metadata = verifyMetadata(
    bytes,
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(signature),
    keys,
  );
  if (metadata.version !== version || metadata.size > 256 * 1024 * 1024)
    throw new Error("update release size/version refused");
  return { bytes, metadata };
}
