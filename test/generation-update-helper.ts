/** Test-only caller for the narrow 4d rebuild contract; not a public update implementation. */
import { acquire, release } from "../product/src/install-lock.ts";
import { ledger } from "../product/src/owned.ts";
import { rebuildCurrent } from "../product/src/plugin-generations.ts";
const root = process.argv[2],
  held = acquire(root);
try {
  await rebuildCurrent(root, "trajecta-example", ledger(root));
} finally {
  release(root, ".lock", held);
}
