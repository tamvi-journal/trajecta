/** Child-only deterministic clocks/UUIDs, identical on both sides of the comparison. */
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
if (process.env.TEST_WORK_SEED) {
  const NativeDate = Date,
    now = Number(process.env.TEST_WORK_NOW);
  class FixedDate extends NativeDate {
    constructor(...args: any[]) {
      super(...((args.length ? args : [now]) as [any]));
    }
    static now() {
      return now;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  let index = 0;
  crypto.randomUUID = () => {
    const hex = crypto
      .createHash("sha256")
      .update(process.env.TEST_WORK_SEED! + ":" + index++)
      .digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  syncBuiltinESMExports();
}
