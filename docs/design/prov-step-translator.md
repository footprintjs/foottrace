# Internal per-commit PROV translation

P1.1 extracts the structural step translator without changing the published
`exportProv` contract. There is no new public entry point or live recorder.

## Boundary

`translateCommit(context, commit)` is a lazy generator of owned node and gap
facts. It accepts one admitted commit, an ID builder, read-only accepted activity
identities, prepared execution facts, a privacy oracle and canonical coverage
results. It has no record, output sink, work budget, clock, storage or network.
It does not update the commit or context.

The driver applies each effect in order. It sends back whether a node fitted the
existing output allowance and remembers activity/entity IDs only after acceptance.
An activity refusal still permits scope-gap processing and a commit attempt; a
commit refusal skips its rows. Row coverage is lazy, so a refused write prevents
inspection of later rows. The translator retains no list of pending output nodes.

The canonical coverage readers stay in the driver adapter. Their results are
supplied as facts; the translator does not introduce a second coverage rule.
Whole-view admission and privacy preparation still precede the first output.
In particular, a late redaction must hide earlier names, and a continuation can
supply an execution's untracked-input fact before its first activity is emitted.

## Scheduling and limits

The after-run order stays: record header and structural commits, then control
communications, attention, and read/candidate relations. Those aggregate readers
and their temporal key index are unchanged. All work, relation, byte and node
charging stays at the original driver boundary, in the original order. A future
live driver must separately design aggregate scheduling and its fail-closed
privacy policy; this refactor does not claim complete streaming support.

A live adapter must never pass raw input directly to the translator. Its inputs
must first receive the same bounded ownership and admission guarantees. It must
supply a privacy oracle that is safe before any name leaves the process, and must
acknowledge emission before treating an identity as available. The translator
remains internal until that real consumer is designed and reviewed.

## Compatibility proof

Both existing PROV golden files stay byte-identical. Boundary tests exercise
independent translation, opaque names, continuation identities, accepted parents,
and acknowledgment-dependent cutoffs. Differential probes against the published
1.6.0 package additionally compare exact outputs and errors across tight admission
and output limits. Existing record/cause fixtures and public exports are unchanged.
