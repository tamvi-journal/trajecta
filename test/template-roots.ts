/** Explicit fixtures include all three ORIGINAL (before §13.8) padding classes. */
export const TEMPLATE_ROOTS = [
  ["A", "/isolated/A"],
  ["B", "/isolated/B"],
  ["token", "/tmp/@@ROOT_SH@@"],
  ["padding-0", "C:\\golden\\a"],
  ["padding-1", "C:\\golden\\aa"],
  ["padding-2", "C:\\golden\\aaa"],
] as const;
