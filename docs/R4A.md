# R4 PR 4a: foundation acceptance

Contract: identity R4 spec at 98313ac, plus the P4a-1–4 settlements in identity
PR #43 at 5169a1fefc67ac674aadbc350d35e59e2d6dfd4b, merged as
e4de9f30b55da8488a9f5e30443ed029d7e7b7e9. This implementation still requires
Aux and Lam review at its exact head before merge.

## Ownership and evidence

The product owns packaging, version and transport. The pinned engines own all
history, approval, retrieval and write semantics. The adapter is the only runtime
module that resolves or imports engines. The product never opens SQLite.
The test-only oracle inspectors and preloads are not shipped.

No installed artifact, running service, real store, MCP configuration or plugin is
changed by this PR. The artifact is a verification foundation, not a release.
No signing key, release workflow/environment, product tag or npm publication exists.

The only direct main push was the initial LICENSE + README stub. GitHub refused
main protection with HTTP 403: “Upgrade to GitHub Pro or make this repository
public to enable this feature.” The repository remains private. Every subsequent
change is in this draft PR.

## Build and pin

Use Node 22.19+ or Node 24:

```sh
node --experimental-strip-types tools/pin-engines.ts identity FULL_SHA
node --experimental-strip-types tools/pin-engines.ts work FULL_SHA
node --experimental-strip-types tools/vendor-engines.ts
node --experimental-strip-types tools/compat.ts --write
node --experimental-strip-types tools/build-release.ts
node --experimental-strip-types test/run.ts --fetch
```

The pin command is an explicit reviewed update. No install-time engine fetching
exists. Builder checkouts reside only in this clone's .isolation/upstream.
All engine and profile files are pinned individually; extra, missing or changed
bytes refuse. Identity root profiles go to engines/trajecta_identity/profiles,
preserving the engine lookup. Runtime engine copies are generated and ignored by
Git; the lock and exact commits are the reviewable source.

The tarball uses sorted ustar entries, zero mtime/uid/gid, 0644/0755 modes and gzip
with no time or filename. MANIFEST authenticates the exact payload inventory and
omits itself. Foundation has no bin/ or publication sequence. Release mode
refuses unless all four native wrapper files exist and are non-empty regular files.
Wrappers and full release acceptance belong to 4c; publication sequence to 4d.

Product version is read from product/package.json only. compat.json is generated
from that file, the engine lock and pinned storage/runtime certifications; CI
requires byte-identical regeneration. Runtime artifacts record the actual Node
and SQLite bundled on each runner. This is compatibility evidence, not a release
or update freshness declaration.

## Gates

- Identity: all 189 cli-v1 scenarios plus the original MANIFEST gate; preserve
  every original comparator. A separate direct-vendored versus product comparison
  requires identical stdout, stderr, exit and entire resulting file tree/hashes.
  All engine CLI bytes run through inherited stdio. The corpus's test-only
  terminal/clock/fault seams are applied equally in both children; real PTY tests
  additionally run without that seam.
- Work: run every untouched pinned work test. A preload pairs every CLI invocation
  with the vendored direct command, restoring the same root first and supplying
  identical deterministic clock/UUID inputs. Stdout/stderr/exit/signal and complete
  history bytes are exact. No work test or comparator is removed or weakened.
- POSIX script(1): actual accepted and mistyped retract receipts, all three
  isatty streams, Ctrl-C. A separate parent-only signal test proves forwarding
  and a child self-signal proves POSIX re-raising. Windows interactive confirmation
  is deferred to M8; pipe refusal and native exit tests run automatically there.
- Authority lint and independent source scan: all shipped product source and
  production build tools; adversarial bypass fixtures must fail both.
- Write trace: Node fs sync/callback/promise/stream writes and native SQLite
  writable opens/SQL are audited. Trace control-file writes use saved functions.
  The parent makes no filesystem writes. Child store writes must have engine
  provenance and stay in the explicitly isolated store roots; a forbidden write
  is rejected before effect.
- Offline: unpack the real artifact into an isolated home, remove profile env
  overrides, remove Git/npm from PATH, disable Node network connections/fetch/DNS,
  then version, default example init/retrieve, and work round trip.
- Build: two identical tarballs, exact MANIFEST inventory/digests, bad lock and
  MANIFEST regressions, release-without-wrappers refusal.

## Deferred M2 acceptance (explicit scope split)

- **4b:** installer bootstrap and doctor differential authority/write trace;
  installer signature/release metadata verification and compatibility inspection.
- **4c:** OS-native wrappers/bin, plugin and K6 acceptance.
- **4d:** every §12.3 M2 update case: signed metadata and rotation chain (including
  remembered rotation after rollback), sequence replay/expiry and every persisted
  state transition, missing/corrupt state and typed reset/floor, downgrade and
  same-version behavior, compatibility refusal, and product TTY migrate-to --using.

M3 installer/crash/uninstall and work issue #12 concurrency carry are 4b. M4
upgrade and M5 plugin follow their owning PRs. M8 gates the eventual release.
Exact engine migrate-to stays unguarded and frozen; the product's migration
confirmation belongs only to 4d.
