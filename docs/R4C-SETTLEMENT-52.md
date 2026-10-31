# R4c: settled Windows host inventory and encoded-command boundary

Normative: identity PR #52, merge
`9d4e48ecbfc40d6000bcd084d8368ecda27357a9`, R4 §13.8.
Lam approved the full spec content at `abde845`. This implements that
settlement on product draft #3; it does not close all Windows M5 gates.

## Encoder

`product/src/templates.ts` owns `encodePowerShell`. It appends the minimum
0–2 ASCII spaces to the rendered script until the UTF-16LE byte length is
divisible by three, encodes it, then refuses cmd delimiters `=`, `,`, `;`
with the existing typed `TemplateError`. The literal PowerShell render stays
available as the encoder's input; only its encoded invocation needs padding.
Production wrappers, test refusal/framing payloads and the no-op pre-warm
share this function. The template FOR lines are unchanged; no `^=` patch.

Coverage includes the original failing 33-character root, minimal padding
and exact decoded-source preservation, a post-encoder fault seam for each
delimiter, and 1,000 deterministic mixed roots through both wrappers.
The generated roots cover all original padding classes and reach 240 UTF-16
code units. Every rendered line is checked against 8,000 characters.
Goldens retain A/B and the token-literal root and add Windows roots for each
original padding class. The two existing token-root cmd goldens change;
their literal template and non-cmd golden bytes do not.

## Host inventory and purity

The test inventory resolves the test's own USERPROFILE and LOCALAPPDATA.
It admits exactly the seven profile-relative §13.7 entries plus LOCALAPPDATA
itself and its three named Microsoft/Windows/Caches ancestors, all dirs in
that second list. It never admits arbitrary descendants or files there.

Both cold-home layouts, preservation of pre-existing entries, consecutive
start byte stability and the pre-warm exit check remain. Every existing
whole-tree name/SHA comparison around a wrapper run remains exact, with no
exclusions. Raw cold-start bytes/SHA remain in `windows-host-a.json`.

Native acceptance captures 18 rows: three original root padding classes,
CLI/MCP, and real NOTINSTALLED / controlled NODEPATH / real OK. Each plain
run has a whole-tree purity check; a separate observer records count/first
line bytes and must preserve the exact plain stdout/stderr/exit outcome.
The existing good/malformed framing and exact refusal cases also use the
production encoder. `windows-padding-m5.json` records all outcomes before
asserting, including tree differences if any.

The controlled NODEPATH row is explicitly **not** the real 8.3-disabled
acceptance fixture. That gate remains open, as do any other previously
unproven native Windows M5 requirements. Green implementation CI alone
does not declare a Windows console Ctrl-C limitation or full M5 completion.

## Historical diagnosis retained

The original bisection remains in `test/windows-bisection-b.ts`. Its
unchanged 47-character-root real validator had 5,106 UTF-16LE bytes and
6,808 unpadded Base64 characters; it worked under every tested command
shape. The old usage traces came from replacement stubs with 200/188
Base64 characters, ending in `==` / `=` respectively, not that validator.

Native run `41175403994` at `86e9c23` confirmed both one-variable
interventions in all 16 observations: remove padding by trailing spaces,
or escape `=` only inside FOR. Both yielded count `310d0a` and exact
NOTINSTALLED/NODEPATH records. The old failing count was `39350d0a`.
Its 5,001-byte usage wire had SHA-256
`7bdfacb64fe84affbde9f584a4c1715a71730f5f5f1046ae0171d5d2314e64e4`.

Bisection run `41176688077` at `a55d4d3` kept these payloads distinct;
unpadded no-op sizes and the real validator did not reproduce usage.
The exact source sent via stdin without a terminal newline exited zero
with empty streams; it was not claimed to have produced the record or
proposed as a design. Those facts and earlier receipts are historical
evidence. Current diagnostic refusal stubs now obey the settled encoder.

No engine/pin/corpus/schema, trust anchor, bootstrap, extractor, template
FOR line or production writer change is part of this settlement.

## Follow-up: node whitelist options were syntactically dead

Native run `41190048158` at `fc8d325` passed the existing nine Windows
tests, then the new exact M5 test caught cmd syntax stderr on every real
OK row. Aux confirmed an implementation defect, not a spec change: the
space inside the whitelist's `delims` value must be its final character.
The two template whitelist lines now move that space to the end, preserving
the exact character multiset. The encoded PowerShell FOR line stays unchanged.

The FOR/IF source audit enumerates the encoded-command capture (empty
delims followed by eol), the field parser (tokens then delims), and the
whitelist (eol then delims with the space last). No other FOR options form
or quoted IF options string was found. The native smoke gates enumerate
every FOR/IF line and require every nonempty template line and every named
branch to execute in a test copy, with byte-identical plain/traced outcomes.
The cases include all refusal/sentinel/status branches, all three absolute
path prefixes, invalid version/relative paths, a space-bearing valid Node
alias and nonzero child exit forwarding.

Controlled canonical OK records point to real isolated copies of the
running Node with `(`, `)` or `&` in their names. Each current wrapper must
emit only the exact generic refusal, exit one, and leave the Node-start
preload marker absent. Captured input bytes must match the emitted record.
A historical test-only old-options control demonstrates the dead guard
falling through and starting the forbidden alias. Trace writes and these
markers are harness effects only. The 18-row M5 test is unchanged.
