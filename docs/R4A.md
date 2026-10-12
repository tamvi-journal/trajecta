# R4 PR 4a: foundation acceptance

Contract: identity R4 spec at 98313ac, plus the P4a-1–4 settlements in identity
PR #43 at 5169a1fefc67ac674aadbc350d35e59e2d6dfd4b, merged as
e4de9f30b55da8488a9f5e30443ed029d7e7b7e9. This implementation still requires
Aux and Lam review at its exact head before merge. The in-process §2.3
amendment is identity PR #44 at d0e1c1995dbbabbfeb2ce550d7d3e3e2eb9c4a27,
approved by Lam and merged as 560af299c3e5d511fb3db851a52a5288194f8f72.

## Ownership and evidence

The product owns packaging, version and dispatch. The pinned engines own all
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
with no time or filename and a fixed unknown-OS marker (255). CI requires identical
archive bytes across all six OS/runtime combinations as well as both local builds.
MANIFEST authenticates the exact payload inventory and
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
  The dispatcher sets argv and imports the real CLI in the same process, through
  the sole adapter. It touches no handlers, stdin, cwd, env, umask or fds and
  applies no product exit/error wrapper to engine runs. Corpus test-only
  terminal/clock/fault seams are applied at the same engine entry for both routes;
  real PTY tests additionally run without those seams.
- Work: run every untouched pinned work test. A preload pairs every CLI invocation
  with the vendored direct command, restoring the same root first and supplying
  identical deterministic clock/UUID inputs. Stdout/stderr/exit/signal and complete
  history bytes are exact. No work test or comparator is removed or weakened.
- POSIX script(1): actual accepted and mistyped retract receipts, all three
  isatty streams, and real identity view parity under terminal Ctrl-C, TTY plus
  PID-directed SIGINT, and process-group SIGTERM. Non-TTY SIGINT/SIGTERM and
  both real engine entries' PID equality run on all three OSes (Windows uses
  native process termination, compared to the direct engine exactly).
  Windows interactive confirmation is deferred to M8.
  View argv stays --port 0. A test-only socket allocation seam gives each pair
  the same bind port; no transcript byte or signal/exit handler is changed.
  A test-only PTY supervisor records the engine's native code/signal separately
  from script(1)'s status and never forwards signals.
- Dispatcher scan: pin the only observable statements to argv assignment and
  the adapter's entry import, including the complete CLI routing/error boundary,
  pure path lookup, exact built-in imports, and absence of eager/transitive product
  dependencies or top-level effects. Injected handlers, stdin reads, writes,
  env/cwd/umask changes, exits and hidden imports must fail the build gate.
- Compatibility: the pinned identity engine's real status, timeline,
  core-proposals and retrieve --readonly read v4 successfully without changing
  store bytes, mtime, sidecars or schema. Thus readable versions remain [4, 5];
  writing still requires v5. Default retrieval automatically disables tracking
  on v4, matching the frozen engine; the same purity checks also pin that path.
- Authority lint and independent source scan: all shipped product source and
  production build tools; adversarial bypass fixtures must fail both.
- Write trace: Node fs sync/callback/promise/stream writes and native SQLite
  writable opens/SQL are audited. Trace control-file writes use saved functions.
  The dispatcher makes no filesystem writes. Store writes must have engine
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
