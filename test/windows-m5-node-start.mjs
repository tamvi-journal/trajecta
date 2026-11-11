// Receipt outside the measured fixture tree, for both a version probe and engine launch.
import { appendFileSync } from "node:fs";
appendFileSync(process.env.TEST_M5_NODE_START, JSON.stringify({ pid: process.pid, argv: process.argv }) + "\n");
