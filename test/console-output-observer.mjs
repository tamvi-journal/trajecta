// Test-only stream tee: preserve the real console descriptors and write result.
import * as fs from "node:fs";
const prefix = process.env.TEST_CONSOLE_CAPTURE;
if (!prefix) throw new Error("isolated console capture prefix required");
fs.writeFileSync(
  prefix + ".meta.json",
  JSON.stringify({
    pid: process.pid,
    argv: process.argv,
    stdin_tty: process.stdin.isTTY === true,
    stdout_tty: process.stdout.isTTY === true,
    stderr_tty: process.stderr.isTTY === true,
  }) + "\n",
  { flag: "wx" },
);
for (const [stream, suffix] of [
  [process.stdout, ".stdout"],
  [process.stderr, ".stderr"],
]) {
  fs.writeFileSync(prefix + suffix, Buffer.alloc(0), { flag: "wx" });
  const original = stream.write;
  stream.write = function (chunk, encoding) {
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    fs.appendFileSync(prefix + suffix, bytes);
    return Reflect.apply(original, this, arguments);
  };
}
