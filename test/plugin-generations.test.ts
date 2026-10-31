import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";
import { temporary, tree } from "./support.ts";
registerHooks({
  load(url, context, next) {
    if (!url.endsWith("/product/src/checkpoint.ts")) return next(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export function checkpoint(point) { globalThis.__generationGate?.(point); }",
    };
  },
});
const { acquire, release } = await import("../product/src/install-lock.ts");
const { ledger } = await import("../product/src/owned.ts");
const { canonicalProductJson } = await import("../product/src/engines.ts");
const { pluginFiles, pluginZip } = await import("../product/src/plugin.ts");
const { digest } = await import("../product/src/install-fs.ts");
const path = new URL("../product/src/plugin-generations.ts", import.meta.url);
const subject = fs.existsSync(path) ? await import(path.href) : null;
const setGate = (gate?: (point: string) => void) => {
  (globalThis as any).__generationGate = gate;
};
test("generation writer refuses without the caller owning the root lock, before any payload or ledger write", async () => {
  assert(subject);
  const root = temporary(),
    data = ledger(root),
    prepared = await subject.preparePlugin({ root, profile: "example" }),
    before = tree(root);
  await assert.rejects(subject.buildGeneration(root, prepared, data), /lock owner/);
  assert.deepEqual(tree(root), before);
});
function records(root: string, generation: number) {
  return Object.entries(ledger(root).entries).filter(
    ([, entry]) => (entry as any).plugin === "trajecta-example" && (entry as any).generation === generation,
  );
}
async function fixture() {
  assert(subject, "immutable plugin generations are not implemented");
  const root = temporary(),
    held = acquire(root),
    data = ledger(root);
  const prepare = (db = "first.sqlite3") => subject.preparePlugin({ root, profile: "example", db: join(root, db) });
  return {
    root,
    held,
    data,
    prepare,
    close: () => {
      setGate();
      release(root, ".lock", held);
    },
  };
}
test("doctor reports built/current version difference as information and keeps every artifact byte", async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare(),
      files = await pluginFiles({ root: f.root, profile: "example", db: join(f.root, "first.sqlite3") });
    const before = files[".claude-plugin/plugin.json"].toString(),
      older = before.replace('"version": "0.5.0"', '"version": "0.4.9"');
    assert.notEqual(older, before);
    files[".claude-plugin/plugin.json"] = Buffer.from(older);
    prepared.bytes = pluginZip(files);
    prepared.recipe.plugin_sha256 = digest(prepared.bytes);
    prepared.recipeBytes = await canonicalProductJson(prepared.recipe);
    await subject.buildGeneration(f.root, prepared, f.data);
    const snapshot = tree(f.root),
      chunks: string[] = [],
      write = process.stdout.write;
    try {
      process.stdout.write = ((part: any) => {
        chunks.push(String(part));
        return true;
      }) as any;
      await subject.reportPlugins(f.root, f.data);
    } finally {
      process.stdout.write = write;
    }
    assert.match(chunks.join(""), /built.*0\.4\.9.*current.*0\.5\.0/);
    assert.deepEqual(tree(f.root), snapshot);
  } finally {
    f.close();
  }
});
test("generation commit is 0-or-4, canonical recipe carries custom DB, and newer commit retires older receipts", async () => {
  const f = await fixture();
  try {
    setGate(() => {
      for (const n of [1, 2]) assert([0, 4].includes(records(f.root, n).length));
    });
    const a = await subject.buildGeneration(f.root, await f.prepare(), f.data);
    assert.equal(a.generation, 1);
    assert.equal(records(f.root, 1).length, 4);
    assert.deepEqual(fs.readdirSync(join(f.root, "plugins/trajecta-example/g1")).sort(), [
      ".planned.json",
      "recipe.json",
      "trajecta.plugin",
    ]);
    const bytes = fs.readFileSync(join(f.root, "plugins/trajecta-example/g1/recipe.json")),
      recipe = JSON.parse(bytes.toString());
    assert.equal(recipe.schema, "trajecta.plugin-recipe/v1");
    assert.equal(recipe.db, join(f.root, "first.sqlite3"));
    assert.equal(recipe.name, null);
    assert.equal(
      recipe.plugin_sha256,
      records(f.root, 1).find(([name]) => name.endsWith("/trajecta.plugin"))![1].sha256,
    );
    assert(!fs.existsSync(join(f.root, "plugins/trajecta-example/current")));
    const b = await subject.buildGeneration(f.root, await f.prepare("second.sqlite3"), f.data);
    assert.equal(b.generation, 2);
    assert.equal(records(f.root, 2).length, 4);
    assert.equal(records(f.root, 1).length, 0);
    assert(!fs.existsSync(join(f.root, "plugins/trajecta-example/g1")));
    assert.equal(
      (await subject.currentGeneration(f.root, "trajecta-example", f.data)).recipe.db,
      join(f.root, "second.sqlite3"),
    );
  } finally {
    f.close();
  }
});
test("tampered current never falls back or writes; whole-generation move tombstones high-water before another commit", async () => {
  const f = await fixture(),
    removed = temporary();
  try {
    await subject.buildGeneration(f.root, await f.prepare(), f.data);
    setGate((point) => {
      if (point === "plugin:commit:after") throw new Error("crash before retirement");
    });
    await assert.rejects(
      subject.buildGeneration(f.root, await f.prepare("second.sqlite3"), f.data),
      /crash before retirement/,
    );
    setGate();
    assert.equal(records(f.root, 1).length, 4);
    assert.equal(records(f.root, 2).length, 4);
    const g2 = join(f.root, "plugins/trajecta-example/g2"),
      recipe = join(g2, "recipe.json");
    fs.appendFileSync(recipe, " ");
    let before = tree(f.root);
    await assert.rejects(
      subject.buildGeneration(f.root, await f.prepare("third.sqlite3"), f.data),
      /modified.*g2.*move those paths/,
    );
    assert.deepEqual(tree(f.root), before);
    const skipped = await subject.rebuildCurrent(f.root, "trajecta-example", f.data);
    assert.equal(skipped, undefined);
    assert.deepEqual(tree(f.root), before);
    fs.renameSync(recipe, join(removed, "recipe.json"));
    before = tree(f.root);
    await assert.rejects(subject.buildGeneration(f.root, await f.prepare(), f.data), /modified.*g2.*move those paths/);
    assert.deepEqual(tree(f.root), before);
    assert.equal(records(f.root, 2).length, 4);
    fs.renameSync(g2, join(removed, "whole-g2"));
    setGate((point) => {
      if (point === "plugin:tombstone:after") throw new Error("crash after tombstone");
    });
    await assert.rejects(subject.buildGeneration(f.root, await f.prepare(), f.data), /crash after tombstone/);
    setGate();
    assert.equal(records(f.root, 2).length, 1);
    assert.equal(records(f.root, 2)[0][1].kind, "tombstone");
    assert.equal(await subject.currentGeneration(f.root, "trajecta-example", f.data), undefined);
    before = tree(f.root);
    assert.equal(await subject.rebuildCurrent(f.root, "trajecta-example", f.data), undefined);
    assert.deepEqual(tree(f.root), before);
    const next = await subject.buildGeneration(f.root, await f.prepare("third.sqlite3"), f.data);
    assert.equal(next.generation, 3);
    assert.equal(records(f.root, 1).length, 0);
    assert(fs.existsSync(join(removed, "whole-g2")));
  } finally {
    f.close();
  }
});
test("uncommitted generations are never adopted or traversed, and their numbers are never reused", async () => {
  const f = await fixture();
  try {
    await subject.buildGeneration(f.root, await f.prepare(), f.data);
    const leftover = join(f.root, "plugins/trajecta-example/g2");
    fs.mkdirSync(leftover);
    fs.writeFileSync(join(leftover, "foreign"), "retained owner bytes");
    const before = tree(leftover);
    const result = await subject.buildGeneration(f.root, await f.prepare(), f.data);
    assert.equal(result.generation, 3);
    assert.deepEqual(tree(leftover), before);
    assert.equal(records(f.root, 2).length, 0);
  } finally {
    f.close();
  }
});
test("containment refuses plugin and generation links without external writes; swap after exclusive mkdir is detected", async () => {
  for (const kind of ["plugins-file", "plugin-link", "generation-link", "swap", "file-swap"]) {
    const f = await fixture(),
      outside = temporary();
    fs.writeFileSync(join(outside, "marker"), "never touch");
    const external = tree(outside);
    try {
      if (kind === "plugins-file") fs.writeFileSync(join(f.root, "plugins"), "foreign");
      else {
        await subject.buildGeneration(f.root, await f.prepare(), f.data);
        if (kind === "plugin-link") {
          fs.renameSync(join(f.root, "plugins/trajecta-example"), join(f.root, "owner-moved"));
          fs.symlinkSync(
            outside,
            join(f.root, "plugins/trajecta-example"),
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        if (kind === "generation-link")
          fs.symlinkSync(
            outside,
            join(f.root, "plugins/trajecta-example/g9"),
            process.platform === "win32" ? "junction" : "dir",
          );
        if (kind === "swap")
          setGate((point) => {
            if (point === "plugin:g2:mkdir:after") {
              setGate();
              const dir = join(f.root, "plugins/trajecta-example/g2");
              fs.renameSync(dir, join(f.root, "owner-moved-g2"));
              fs.symlinkSync(outside, dir, process.platform === "win32" ? "junction" : "dir");
            }
          });
        if (kind === "file-swap")
          setGate((point) => {
            if (point === "plugin:file:after-rename:recipe.json") {
              setGate();
              const path = join(f.root, "plugins/trajecta-example/g2/recipe.json");
              fs.unlinkSync(path);
              fs.symlinkSync(join(outside, "marker"), path, "file");
            }
          });
      }
      const before = tree(f.root);
      await assert.rejects(
        subject.buildGeneration(f.root, await f.prepare(), f.data),
        (e) => e.name === "PluginDirectoryError" && /not a product-owned real directory/.test(e.message),
      );
      if (kind !== "swap" && kind !== "file-swap") assert.deepEqual(tree(f.root), before);
      assert.deepEqual(tree(outside), external);
    } finally {
      f.close();
    }
  }
});

test("plugin ownership receipts must stay in shared scope before a reader or writer accepts them", async () => {
  const f = await fixture();
  try {
    await subject.buildGeneration(f.root, await f.prepare(), f.data);
    for (const key of Object.keys(f.data.entries).filter((key) => key.startsWith("plugins"))) {
      const copy = JSON.parse(JSON.stringify(f.data));
      copy.entries[key].scope = "0.5.0";
      fs.writeFileSync(join(f.root, "owned.json"), JSON.stringify(copy));
      assert.throws(() => ledger(f.root), /plugin.*scope/);
    }
  } finally {
    f.close();
  }
});

test("full uninstall never follows a swapped ancestor after generation receipts have been removed", async () => {
  const f = await fixture(),
    outside = temporary();
  try {
    await subject.buildGeneration(f.root, await f.prepare(), f.data);
    fs.writeFileSync(join(f.root, "current"), "uninstalling\n");
    setGate((point) => {
      if (point === "plugin:remove-dir:before:plugins/trajecta-example") throw Error("crash before parent cleanup");
    });
    await assert.rejects(subject.removeAllPlugins(f.root, f.data), /crash before parent cleanup/);
    setGate();
    assert.equal(records(f.root, 1).length, 0);
    fs.renameSync(join(f.root, "plugins"), join(outside, "plugins"));
    fs.symlinkSync(
      join(outside, "plugins"),
      join(f.root, "plugins"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const external = tree(outside),
      before = fs.readFileSync(join(f.root, "owned.json"));
    const retained = await subject.removeAllPlugins(f.root, f.data);
    assert.deepEqual(tree(outside), external, "an unchanged leaf inode cannot authorize traversing a replaced parent");
    assert.deepEqual(fs.readFileSync(join(f.root, "owned.json")), before);
    assert(retained.includes(join(f.root, "plugins")));
  } finally {
    f.close();
  }
});
