# R4c Windows release notes and M8 rehearsal

The Windows limitations below follow [identity §13.9](https://github.com/tamvi-journal/trajecta-identity-memory/blob/726e7c9001b8d66599272f05b969169ad04f8394/docs/specs/2026-10-11-r4-product-cutover.md#139-remaining-4c-m5-gates-codex-stops-m5-2--3--4--8--8d9a17b-aux-settlement-2026-10-31).

- **M5-3.** AppLocker enforcement could not be established on GitHub-hosted runners (receipt run 42949330918). NOT VERIFIED in 4c; deferred to independent M8 owner rehearsal; no AppLocker or WDAC claim.
- **M5-4 — LIMITATION / UNBOUNDED WRAPPER.** The Windows validator refuses a malformed or hostile Node within its own wait and drain bounds. If a descendant keeps the inherited output pipe open, the launcher can wait for EOF until that descendant exits. This wait applies on Windows and POSIX, where `$(...)` waits for EOF. M8 rehearses this case. A bounded wrapper remains separate work.
- **M5-8 — interactive Ctrl-C and window close.** The engine handles Ctrl-C as in a direct run. Windows batch then prompts `Terminate batch job (Y/N)?`. With `Y`, cmd exits 255 even when the engine exits 0. With `N`, both exit 0 in the measured runs.
  - The hosted test posted `WM_CLOSE`, and the window handle disappeared.
  - The probe received no `CTRL_CLOSE_EVENT`.
  - The test harness forced cleanup of the surviving processes after recording their state.
  - Real physical window close is NOT VERIFIED in 4c; deferred to M8 ([identity §13.10](https://github.com/tamvi-journal/trajecta-identity-memory/blob/41362ef78e2f059872b8511ca03e8d1bfc6bc22b/docs/specs/2026-10-11-r4-product-cutover.md#L926)).
  - M8 procedure (§13.10): on a real Windows desktop, for Node 22 and Node 24, run `identity view` directly and through `trajecta.cmd`, close the console with the title-bar X, and record `CTRL_CLOSE_EVENT` delivery, the output up to the close, and whether the engine (and `cmd.exe` when wrapped) is gone within 10 s. A difference between direct and wrapped, or an engine that outlives the window, is an M8 finding that needs its own settlement.

**Release gate.** Q9 (release) cannot pass while M5-3 or M5-8 physical close is unresolved, or without an explicit owner decision on each.
