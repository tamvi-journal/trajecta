import { cleanupRecovery } from "../product/src/recovery.ts";
const retained = cleanupRecovery(process.argv[2]);
if (retained.length) throw new Error("retained: " + retained.join("\n"));
