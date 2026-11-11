# R4c Windows byte-validation STOP

**Historical evidence; settled by identity #49 (`dbcaaf66015cc65800fdd871ea20e5d352e08300`).**
§13.5 authorizes the pinned raw-byte PowerShell validator now implemented in this
draft. The observations below remain intact as provenance, not an active STOP.
Native certification of the replacement is still pending. See
[remaining preflight](R4C-REMAINING-PREFLIGHT.md) for current S4/S5 and CI status.

Contract: identity PR 48, merged `2edb23ad4a2daae597ce9702e80249e6804b3411`,
R4 §13.3. Existing S1–S3 settlements stay closed. This is the explicitly
required capability STOP for the native Windows byte validator.

## Observed, not inferred

Real `windows-latest` runners on Node 22.23.4 and 24.22.1 ran the committed
`test/windows-byte-preflight.ts` and `test/windows-byte-reader.cmd`.
The observer Node reports environment strings produced by native readers;
it is test instrumentation, not a proposed production validator or engine run.
Fixture bytes and inventory were checked unchanged.

Run [41095661097](https://github.com/tamvi-journal/trajecta/actions/runs/41095661097)
at `0f292691454fa530fd27695414e2e39031fd5c60` produced this distinguishing input:

| Record          | Full hex                                   | Bytes | `set /p` value        |
| --------------- | ------------------------------------------ | ----: | --------------------- |
| Valid LF        | `433a5c666978747572655c6e6f64652e6578650a` |    20 | `C:\fixture\node.exe` |
| Invalid bare CR | `433a5c666978747572655c6e6f64652e6578650d` |    20 | `C:\fixture\node.exe` |
| Invalid NUL     | `433a5c666978747572655c6e6f64652e65786500` |    20 | `C:\fixture\node.exe` |

The LF/bare-CR pair also has identical `FOR /F` file values and identical
`FOR /F(FINDSTR /r /n /c:"^")` values. `FIND /v /c ""` reports one line for
both. `FINDSTR /p` returns status 0 even for the trailing NUL in this fixture.
Thus the native text-reader/size/line-count path loses distinctions required
before the Node probe. A 20-byte length check cannot restore them.

The ASCII pointer itself also demonstrates that `set /p` is not a literal
first-LF-line reader: `0.5.0\n1.0.0\n` becomes one variable containing an
embedded LF, while `FOR /F` discards blank lines.

## Additional native-regex experiment

Run [41096590809](https://github.com/tamvi-journal/trajecta/actions/runs/41096590809)
at `9704dfd53eff5472911b7b2bdc5c2088e6c19a7b`, and its push counterpart
41096576224, preserve the failed experiment in both Node jobs.

For the valid seven-byte pointer `302e352e300a0a`, `FINDSTR /r /c:".$"`
returns 1. The next attempted negated-printable pattern,
`FINDSTR /r /c:"[^ -~]"`, does not return before the 15-second test timeout.
The assertion records `fixture: pointer-lf`, `ETIMEDOUT`, the exact stdout,
and `NONASCII` as its last completed stage. The timeout is evidence of this
experiment's failure, not a contract timing tolerance or a retry policy.

## Disposition

No production Windows validator is shipped. These observations disprove the
attempted native text-reader path, not every mathematically possible cmd
program. I cannot establish the required byte-exact validator within the
currently agreed native/pre-Node boundary, so §13.3 requires STOP rather than
shipping a permissive check or silently introducing a helper.

Settlement requested: authorize a precisely scoped read-only raw-byte validator
in the Windows native stage (for example system PowerShell, also checking file
and directory reparse attributes), or supply an approved cmd-only method.
Keep all current pointer, sentinel, refusal, no-write and argv laws unchanged.
No Node/product entry may run before the checks under the current contract.

The extractor's independent 64 MiB/8192-physical-header hardening is implemented
and has red/green tests. Plugin/wrapper integration remains incomplete. No
Windows console Ctrl-C limitation is declared without observing that gate.
