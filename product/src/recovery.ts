import * as fs from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { atomic, beneath, digest, jsonBytes, regular, safeRoot, syncDir } from "./install-fs.ts";
import { authenticateManifest, verifyMetadata } from "./release.ts";
import { walk, type Ledger } from "./owned.ts";
import { checkpoint } from "./checkpoint.ts";

const DATA = ["node", "DIGESTS.json", "MANIFEST.json", "release.json.sig", "release.json"];
export function signedManifest(folder: string): any {
  safeRoot(folder);
  for (const name of ["release.json", "release.json.sig", "MANIFEST.json"])
    if (!regular(join(folder, name))) throw new Error(`missing signed recovery control: ${name}`);
  const metadata = verifyMetadata(
    fs.readFileSync(join(folder, "release.json")),
    fs.readFileSync(join(folder, "release.json.sig"), "utf8"),
  );
  return authenticateManifest(fs.readFileSync(join(folder, "MANIFEST.json")), metadata, "stored");
}
function matches(folder: string, name: string, expected: { size: number; sha256: string }): void {
  const path = join(folder, name);
  if (beneath(folder, path) !== name || !regular(path)) throw new Error(`missing recovery product: ${name}`);
  const bytes = fs.readFileSync(path);
  if (bytes.length !== expected.size || digest(bytes) !== expected.sha256)
    throw new Error(`recovery product mismatch: ${name}`);
}
export function productPaths(manifest: any): string[] {
  return Object.keys(manifest.files)
    .filter((name) => name.startsWith("product/"))
    .sort();
}
function impliedDirectories(manifest: any): string[] {
  const dirs = new Set<string>();
  for (const name of productPaths(manifest)) {
    let parent = dirname(name).split(sep).join("/");
    while (parent !== ".") {
      dirs.add(parent);
      parent = dirname(parent).split(sep).join("/");
    }
  }
  return [...dirs].sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? -1 : a > b ? 1 : 0));
}
function copyVerified(path: string, bytes: Buffer): void {
  safeRoot(dirname(path));
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (regular(path)) {
    if (!fs.readFileSync(path).equals(bytes)) throw new Error(`recovery copy differs: ${path}`);
    return;
  }
  const fd = fs.openSync(path, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDir(dirname(path));
}
export function createRecovery(root: string, version: string, ledger: Ledger): { list: any; anchor: string } {
  const source = join(root, version),
    destination = join(root, ".uninstall"),
    manifest = signedManifest(source);
  const files: Record<string, string> = {};
  for (const name of productPaths(manifest)) {
    matches(source, name, manifest.files[name]);
    files[name] = manifest.files[name].sha256;
  }
  const node = join(source, "node"),
    receipt = ledger.entries[version + "/node"];
  if (!regular(node) || receipt?.kind !== "file" || digest(fs.readFileSync(node)) !== receipt.sha256)
    throw new Error("version node has no matching ledger receipt");
  files.node = receipt.sha256;
  for (const name of ["MANIFEST.json", "release.json.sig", "release.json"])
    files[name] = digest(fs.readFileSync(join(source, name)));
  safeRoot(destination);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const [name, sha] of Object.entries(files)) {
    copyVerified(join(destination, name), fs.readFileSync(join(source, name)));
    if (digest(fs.readFileSync(join(destination, name))) !== sha) throw new Error("recovery copy digest mismatch");
    checkpoint("U:recovery-copy:" + name);
  }
  const list = { schema: "trajecta.recovery/v1", version, files },
    bytes = jsonBytes(list),
    path = join(destination, "DIGESTS.json");
  if (regular(path)) {
    if (!fs.readFileSync(path).equals(bytes)) throw new Error("recovery digest list differs");
  } else atomic(path, bytes, "U:recovery-list");
  checkpoint("U:recovery");
  return { list, anchor: digest(bytes) };
}
function unlinkData(folder: string, name: string, retained: string[]): void {
  const path = join(folder, name);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile()) {
    retained.push(path);
    return;
  }
  checkpoint("U:recovery-before-unlink:" + name);
  fs.unlinkSync(path);
  syncDir(dirname(path));
  checkpoint("U:recovery-after-unlink:" + name);
}
/** R46-1: shared terminal law for step 6, bootstrap fallback and fresh install. */
export function cleanupRecovery(root: string): string[] {
  const folder = join(root, ".uninstall");
  if (!fs.existsSync(folder)) return [];
  safeRoot(folder);
  const paths = walk(folder),
    products = paths.filter((path) => {
      const name = relative(folder, path).split(sep).join("/");
      return (name === "product" || name.startsWith("product/")) && !fs.lstatSync(path).isDirectory();
    });
  let manifest: any;
  if (products.length) {
    manifest = signedManifest(folder);
    for (const path of products) {
      const name = relative(folder, path).split(sep).join("/");
      if (!manifest.files[name] || !name.startsWith("product/")) throw new Error(`unknown recovery product: ${name}`);
      matches(folder, name, manifest.files[name]);
    }
  } else {
    // A last-product-unlink crash leaves the authenticated metadata available for C's empty dirs.
    // If those inert controls are already gone/invalid, no code can execute; keep unproved dirs.
    try {
      manifest = signedManifest(folder);
    } catch {
      manifest = undefined;
    }
  }
  checkpoint("U:recovery-authenticated");
  const retained: string[] = [];
  // B: neither file is read or used to establish trust.
  for (const name of DATA.slice(0, 2)) unlinkData(folder, name, retained);
  // C: only the files authenticated above, then only MANIFEST-implied empty directories.
  for (const path of products.sort()) unlinkData(folder, relative(folder, path).split(sep).join("/"), retained);
  for (const name of manifest ? impliedDirectories(manifest) : []) {
    const path = join(folder, name);
    try {
      if (!fs.lstatSync(path).isDirectory()) {
        retained.push(path);
        continue;
      }
      fs.rmdirSync(path);
      checkpoint("U:recovery-after-rmdir:" + name);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  // D: there are no remaining executable PRODUCT files.
  for (const name of DATA.slice(2)) unlinkData(folder, name, retained);
  // E: no recursive deletion; unexpected files or directories remain and are reported.
  const leftovers = walk(folder);
  if (!leftovers.length) {
    fs.rmdirSync(folder);
    syncDir(root);
    checkpoint("U:recovery-directory");
  }
  return [...new Set([...retained, ...leftovers])].sort();
}
