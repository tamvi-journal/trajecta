// SemVer 2.0.0 precedence (https://semver.org/), without build metadata.
const SEMVER_NUMERIC = "(0|[1-9][0-9]*)";
const SEMVER_PRERELEASE = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
// The final assertion requires true EOF, including refusal of a trailing LF.
const SEMVER = new RegExp(
  `^${SEMVER_NUMERIC}\\.${SEMVER_NUMERIC}\\.${SEMVER_NUMERIC}(?:-(${SEMVER_PRERELEASE}(?:\\.${SEMVER_PRERELEASE})*))?(?![\\s\\S])`,
  "u",
);
export function isSemVer(value: unknown): value is string {
  return typeof value === "string" && SEMVER.test(value);
}
function readSemVer(value: string): RegExpExecArray {
  const match = SEMVER.exec(value);
  if (!match) throw new Error("invalid semantic version");
  return match;
}
function numericPrecedence(left: string, right: string): number {
  // Valid numeric identifiers have no leading zeroes; compare without a Number conversion.
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}
/** Returns -1, 0 or 1. Both inputs must be SemVer without build metadata. */
export function compareSemVer(left: string, right: string): number {
  const a = readSemVer(left),
    b = readSemVer(right);
  for (let i = 1; i <= 3; i++) {
    const order = numericPrecedence(a[i], b[i]);
    if (order) return order;
  }
  if (a[4] === undefined || b[4] === undefined) return a[4] === b[4] ? 0 : a[4] === undefined ? 1 : -1;
  const first = a[4].split("."),
    second = b[4].split(".");
  for (let i = 0; i < Math.min(first.length, second.length); i++) {
    if (first[i] === second[i]) continue;
    const leftNumeric = /^[0-9]+$/u.test(first[i]),
      rightNumeric = /^[0-9]+$/u.test(second[i]);
    if (leftNumeric && rightNumeric) return numericPrecedence(first[i], second[i]);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return first[i] < second[i] ? -1 : 1; // The grammar limits these to ASCII.
  }
  return first.length === second.length ? 0 : first.length < second.length ? -1 : 1;
}
