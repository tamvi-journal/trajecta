# R4c settlement implementation and evidence boundary

Contract: identity #50, merge 4459ead02a093edc8e2a9b7213e41de1e0d41a8d,
§13.6, plus §13.3/§13.5. The high-water current rule includes tombstones;
there is no fallback to an older generation.

The release-mode verification artifact carries the six root-independent
`bin/templates/` inputs. One count table drives build and rendering. Checked-in
A/B/token-root golden outputs cover all six. Only platform-selected outputs
are rendered. Windows validator bytes remain in memory. Pre-verification
bootstrap scripts remain external to the installed runtime payload, are still
regenerated and tested from bootstrap-build.ts, and are not installed under
root (in particular no .ps1 is installed).

Managed plugins use immutable gN directories. Recipe bytes are losslessly
parsed and written through the pinned R0 codec adapter. An explicit --db is
recorded and passed to the identity MCP entry. Four receipts commit in one
ledger replacement. Uncommitted generations are retained, never adopted.
Containment checks include real-directory identity, exclusive creation,
no-follow file reads/writes and a parent identity recheck. Current tampering
refuses without writes; moving the whole current generation creates a
tombstone before the next build. Retirement and sentinel-authorized full
uninstall converge after absent-file crashes. The rebuild helper is tested
for future 4d integration; this PR does not add the public update command.

The earlier flat-plugin crash rows are replaced explicitly by generation
creation/commit/retirement kill tests. Existing launcher crash rows, exact
comparators, engine pins, bootstrap gates and authority checks remain.
Additional local evidence covers custom-db MCP status, independent concurrent
MCP defaults, owner-PID write tracing, external no-replace link races, and the
real installed identity view through the POSIX launcher in all five signal
topologies.

This is a draft, not a release or a six-combination certification. Production
trust stays empty. GitHub billing prevents runners from starting. Native
Windows byte/framing and PowerShell tests are present but cannot be claimed
passed from macOS. Still-unverified native acceptance includes bounded
probe/descendant drain, short-path and 8.3-disabled NODEPATH cases, blocked
PowerShell policy, long-root filesystem behavior, no PowerShell ancestor at
engine startup, and real console Ctrl-C. No Windows limitation is declared
without observing it. Linux/macOS CI matrix acceptance also remains pending.
Final exact-head local counts and run IDs belong in the PR report, after a
clean frozen-head run; earlier working-tree runs are regression observations.

Fresh whole-branch source review at c0b7d0e found two implementation defects:
ancestor validation during parent-directory uninstall cleanup, and retirement
skipped on an install retry whose new generation already committed. Both have
failing-then-passing regressions. Cleanup now verifies the full owned directory
chain, and the matching-current install retry resumes retirement under its
existing lock before recording its completion. Public process-kill regressions
also cover all parent-directory cleanup boundaries and the moved-ancestor case.
