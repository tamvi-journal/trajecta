import * as fs from "node:fs";
import { join } from "node:path";
import { acquire, release, type Owner } from "../product/src/install-lock.ts";
let held: Owner | undefined,
  root = "";
process.on("message", (message: any) => {
  if (message.action === "acquire") {
    root = message.root;
    try {
      held = acquire(root);
      fs.writeFileSync(join(root, "test-holder"), held.token, { flag: "wx" });
      process.send!({ result: "held", token: held.token });
    } catch (error) {
      process.send!({ result: "busy", error: (error as Error).message });
    }
  } else if (message.action === "release") {
    fs.unlinkSync(join(root, "test-holder"));
    release(root, ".lock", held!);
    held = undefined;
    process.send!({ result: "released" });
  }
});
process.send!({ result: "ready" });
