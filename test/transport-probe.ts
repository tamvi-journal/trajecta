import { enginePath } from "../product/src/engines.ts";
if (process.argv[1] === enginePath("identity") && process.env.TEST_TRANSPORT_PROBE) {
  if (process.env.TEST_TRANSPORT_PROBE === "signal") {
    process.stdout.write("probe ready\n");
    process.on("SIGINT", () => {
      process.stderr.write("probe SIGINT\n");
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      process.stderr.write("probe SIGTERM\n");
      process.exit(143);
    });
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } else if (process.env.TEST_TRANSPORT_PROBE === "self-signal") {
    process.kill(process.pid, "SIGTERM");
    await new Promise(() => {});
  } else {
    const input: Buffer[] = [];
    process.stdin.on("data", (b) => input.push(Buffer.from(b)));
    if (!process.stdin.isTTY) await new Promise<void>((done) => process.stdin.on("end", done));
    process.stdout.write(
      JSON.stringify({
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        env: process.env,
        tty: [Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY), Boolean(process.stderr.isTTY)],
        stdin: Buffer.concat(input).toString("hex"),
      }) + "\n",
    );
    process.stderr.write("probe stderr\n");
    process.exit(Number(process.env.TEST_EXIT_CODE ?? 0));
  }
}
