/** Test-only write boundary audit; every Node process inherits the same --import. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
if (process.env.TEST_WRITE_TRACE) {
  Error.stackTraceLimit = 100; // Recursive native fs helpers must retain the engine caller in the audit stack.
  const append = fs.appendFileSync,
    realpath = fs.realpathSync.native;
  const descriptors = new Map<number, string>();
  const allowed: string[] = JSON.parse(process.env.TEST_WRITE_ROOTS!);
  const engineRoot = fileURLToPath(new URL("../engines/", import.meta.url));
  let recording = false;
  const check = (method: string, value: any) => {
    if (recording) return; // The trace control file is written only by the saved append function below.
    if (typeof value === "number") {
      if (value >= 0 && value <= 2) return;
      value = descriptors.get(value);
      if (value === undefined) throw new Error("untracked writable descriptor");
    }
    let path = resolve(value instanceof URL ? fileURLToPath(value) : String(value));
    let ancestor = path;
    while (!fs.existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    path = resolve(realpath(ancestor), relative(ancestor, path));
    const stack = new Error().stack ?? "";
    const mediated = stack.includes(engineRoot) || stack.includes(new URL("../engines/", import.meta.url).href);
    const contained = allowed.some((root) => {
      const part = relative(resolve(root), path);
      return !isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\");
    });
    const accepted = mediated && contained;
    recording = true;
    try {
      append(
        process.env.TEST_WRITE_TRACE!,
        JSON.stringify({
          pid: process.pid,
          entry: process.argv[1],
          method,
          path,
          mediated,
          accepted,
        }) + "\n",
      );
    } finally {
      recording = false;
    }
    if (!accepted) throw new Error("M2 unauthorized filesystem write: " + path);
  };
  const opens = (flags: any) =>
    typeof flags === "number"
      ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC))
      : /[wa+]/u.test(flags);
  const open = fs.openSync,
    close = fs.closeSync;
  fs.openSync = ((path: any, flags: any, ...args: any[]) => {
    if (opens(flags)) check("openSync", path);
    const fd = (open as any)(path, flags, ...args);
    descriptors.set(fd, resolve(path instanceof URL ? fileURLToPath(path) : String(path)));
    return fd;
  }) as any;
  fs.closeSync = ((fd: number) => {
    try {
      return close(fd);
    } finally {
      descriptors.delete(fd);
    }
  }) as any;
  const single = [
    "writeFile",
    "appendFile",
    "truncate",
    "mkdir",
    "unlink",
    "rm",
    "rmdir",
    "chmod",
    "chown",
    "utimes",
    "lutimes",
    "lchown",
    "lchmod",
  ];
  const descriptor = ["write", "writev", "ftruncate", "fchmod", "fchown", "futimes"];
  const pairs: Record<string, number[]> = { rename: [0, 1], copyFile: [1], cp: [1], link: [1], symlink: [1] };
  for (const suffix of ["Sync", ""])
    for (const base of [...single, ...descriptor, ...Object.keys(pairs)]) {
      const name = base + suffix,
        original = (fs as any)[name];
      if (!original) continue;
      (fs as any)[name] = (...args: any[]) => {
        for (const at of pairs[base] ?? [0]) check(name, args[at]);
        return Reflect.apply(original, fs, args);
      };
    }
  const createStream = fs.createWriteStream;
  fs.createWriteStream = ((path: any, ...args: any[]) => {
    check("createWriteStream", path);
    return (createStream as any)(path, ...args);
  }) as any;
  const asyncOpen = fs.open;
  fs.open = ((path: any, flags: any, ...args: any[]) => {
    if (opens(flags)) check("open", path);
    const callback = args.pop();
    return (asyncOpen as any)(path, flags, ...args, (error: any, fd: number) => {
      if (!error) descriptors.set(fd, resolve(String(path)));
      callback(error, fd);
    });
  }) as any;
  for (const base of [...single, ...Object.keys(pairs)]) {
    const original = (fsp as any)[base];
    if (!original) continue;
    (fsp as any)[base] = (...args: any[]) => {
      for (const at of pairs[base] ?? [0]) check("promises." + base, args[at]);
      return Reflect.apply(original, fsp, args);
    };
  }
  const promiseOpen = fsp.open;
  fsp.open = (async (path: any, flags: any, ...args: any[]) => {
    if (opens(flags)) check("promises.open", path);
    const handle = await (promiseOpen as any)(path, flags, ...args);
    descriptors.set(handle.fd, resolve(String(path)));
    for (const method of ["write", "writev", "writeFile", "appendFile", "truncate", "chmod", "chown", "utimes"]) {
      const original = handle[method];
      handle[method] = (...values: any[]) => {
        check("FileHandle." + method, handle.fd);
        return Reflect.apply(original, handle, values);
      };
    }
    return handle;
  }) as any;
  // Native SQLite bypasses node:fs. Audit its writable opens and SQL writes too.
  const sqlite = createRequire(import.meta.url)("node:sqlite");
  const NativeDatabase = sqlite.DatabaseSync;
  sqlite.DatabaseSync = new Proxy(NativeDatabase, {
    construct(target, args) {
      const path = args[0],
        writable = args[1]?.readOnly !== true;
      if (writable && path !== ":memory:") check("sqlite.open", path);
      const database = Reflect.construct(target, args);
      const exec = database.exec,
        prepare = database.prepare;
      database.exec = (sql: string) => {
        if (writable && path !== ":memory:") check("sqlite.exec", path);
        return Reflect.apply(exec, database, [sql]);
      };
      database.prepare = (sql: string) => {
        const statement = Reflect.apply(prepare, database, [sql]);
        for (const name of ["run", "get", "all"]) {
          const original = statement[name];
          statement[name] = (...values: any[]) => {
            if (
              writable &&
              path !== ":memory:" &&
              !/^\s*(?:SELECT|EXPLAIN)\b/iu.test(sql) &&
              (!/^\s*PRAGMA\b/iu.test(sql) || sql.includes("="))
            )
              check("sqlite." + name, path);
            return Reflect.apply(original, statement, values);
          };
        }
        return statement;
      };
      return database;
    },
  });
  syncBuiltinESMExports();
}
