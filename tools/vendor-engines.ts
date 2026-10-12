import { vendor } from "./engine-lock.ts";
vendor(undefined, !process.argv.includes("--cached"));
