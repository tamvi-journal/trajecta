/** Pre-verification JSON subset: strings, safe integers, arrays, objects, booleans and null.
 * No engine code can run while a bootstrap is authenticating its first payload. */
export type UpdateJson = null | boolean | string | number | UpdateJson[] | { [key: string]: UpdateJson };
export function codePointOrder(a: string, b: string): number {
  const left = Array.from(a),
    right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
}
export function canonical(value: any): string {
  if (typeof value === "string") {
    for (const char of value) {
      const point = char.codePointAt(0)!;
      if (point >= 0xd800 && point <= 0xdfff) throw new Error("surrogate in update JSON");
    }
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return String(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort(codePointOrder)
        .map((key) => canonical(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  throw new Error("invalid update JSON value");
}
export function parseCanonical(bytes: Buffer): any {
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let offset = 0;
  function fail(): never {
    throw new Error("invalid canonical update JSON");
  }
  function string(): string {
    if (source[offset++] !== '"') fail();
    let out = "";
    while (offset < source.length) {
      const ch = source[offset++];
      if (ch === '"') return out;
      if (ch.charCodeAt(0) < 32) fail();
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const escape = source[offset++];
      if (escape === "u") {
        const digits = source.slice(offset, offset + 4);
        if (!/^[0-9a-fA-F]{4}$/u.test(digits)) fail();
        out += String.fromCharCode(parseInt(digits, 16));
        offset += 4;
      } else {
        const escapes: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (!Object.hasOwn(escapes, escape)) fail();
        out += escapes[escape];
      }
    }
    return fail();
  }
  function value(depth: number): UpdateJson {
    if (depth > 64) fail();
    const ch = source[offset];
    if (ch === '"') return string();
    if (ch === "{" || ch === "[") {
      offset++;
      const object = ch === "{",
        end = object ? "}" : "]";
      const out: any = object ? Object.create(null) : [];
      if (source[offset] === end) {
        offset++;
        return out;
      }
      for (;;) {
        if (object) {
          const key = string();
          if (Object.hasOwn(out, key) || source[offset++] !== ":") fail();
          out[key] = value(depth + 1);
        } else out.push(value(depth + 1));
        if (source[offset] === end) {
          offset++;
          return out;
        }
        if (source[offset++] !== ",") fail();
      }
    }
    for (const [word, result] of [
      ["null", null],
      ["true", true],
      ["false", false],
    ] as const)
      if (source.startsWith(word, offset)) {
        offset += word.length;
        return result;
      }
    const number = /^-?(?:0|[1-9][0-9]*)/u.exec(source.slice(offset));
    if (!number) fail();
    offset += number[0].length;
    const result = Number(number[0]);
    if (!Number.isSafeInteger(result) || Object.is(result, -0)) fail();
    return result;
  }
  const result = value(0);
  if (offset !== source.length || canonical(result) !== source) fail();
  return result;
}
export function fields(value: any, keys: string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== keys.slice().sort().join("\0")
  )
    throw new Error("invalid update fields");
}
export const positiveSequence = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
