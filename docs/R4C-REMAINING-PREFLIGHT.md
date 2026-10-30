# R4c remaining contract preflight

Contract read: identity `dbcaaf66015cc65800fdd871ea20e5d352e08300`, R4 §13.3 and §13.5 in full, with §§2.2, 5.2, 5.3 and 13.1–13.4 still binding. The earlier Windows byte-reader STOP is **settled** by identity #49. No weaker reader is proposed.

This draft is implementation in progress, not a completed M3/M5 certification. Two newly reproduced questions need settlement; the affected packaging/profile-routing decisions are stopped. Existing engine pins and exact comparators are unchanged.

## S4: portable release `bin/` versus install-bound wrappers

§2.2 requires one deterministic, cross-matrix `artifact: release` archive carrying the four OS-native wrappers under `bin/`. The four must be real launchers; the foundation settlement explicitly rules out placeholder launchers. §13.1 binds every generated shell's root as one quoted literal. §13.5 also binds the actual install root inside the Windows validator, and the install machine's checked absolute system PowerShell path in the cmd wrapper. Both values become known at install, not release build.

The generated shared wrappers are correctly built in Phase A for the chosen root, carried with the version rename, hashed into the plan and copied unchanged in Phase C. Their bytes necessarily differ by root. A read-only render probe produced:

| Render                   | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| POSIX root `/isolated/A` | `103588950f175fca9a5c5ee56f99743c827c0660e28a94294a5b57459f75d73d` |
| POSIX root `/isolated/B` | `00c9986ba5a104b73f0311d4631673db197602cf89cbda05674dc33a2f555f9d` |
| Windows root `C:\A`      | `7d017961f5d7caec8b39e77203eb79770c69945f20a6d08e8bb2710e3337dd55` |
| Windows root `C:\B`      | `a06cade281558773dd100699e6687957b7336ddc81e44bcd8925d2034aa5fc99` |

The Windows probe pins the same `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` for both renders. Different valid system PowerShell paths are another build-time unknown.

**Question:** what exactly does the portable tarball's `bin/` contain? A template-only representation would need an explicit amendment to the OS-native-wrapper/no-placeholder requirement. Alternatively, an explicitly separate archive launcher design needs its own contract. This draft supplies neither invented placeholders nor a silently host-bound release artifact. The existing release build continues refusing missing/incomplete `bin/`; the verification artifact remains `foundation` pending settlement.

## S5: custom install `--db` versus the frozen MCP identity recipe

The existing 4b install API accepts an arbitrary explicit database path. §13.2 freezes the plugin identity arguments to `--profile <p>` and only allows four environment-default keys. None of those keys selects a database basename.

Native macOS reproduction, ephemeral test key only in process memory, all roots temporary:

1. Install with `--profile example --db <temp>/identity/custom.sqlite3`.
2. Public identity init succeeds; `custom.sqlite3` exists.
3. Start the generated identity recipe through `/bin/sh <root>/bin/trajecta-mcp ... -- --profile example`.
4. Send one `tools/call` for `identity_status`.
5. Exact structured result reports `db: <temp>/identity/example.sqlite3`, `store: uninitialized`.

No real store was read or written. The MCP status read creates no second store. The mismatch is between the successful install's bootstrap target and the frozen profile-derived MCP target.

**Question:** should install refuse a custom basename when it builds a plugin, should the recipe be amended to carry `--db`, or is a distinct intended rule required? The draft follows the frozen recipe and makes no one-runtime/engine change or invented refusal.

## Infrastructure, distinct from either contract question

GitHub prevented **every job from starting** at `954489751f64219969ec816a847fff7cd51166c2`:

- Windows contract run `41107091660` (Node 22/24).
- Full six-combination run `41107091730`.
- Annotation: “The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings”.

This is not Windows test evidence. No validator-native pass, Windows console limitation, short-path success, blocked-PowerShell acceptance or six-combination certification is claimed. Billing/account settings were not changed. No gate, comparator or workflow diff was relaxed.
