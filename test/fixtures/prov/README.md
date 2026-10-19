# First PROV exporter envelope pins

These two new fixtures pin the value-free P1 export only. They do not replace,
regenerate or modify the established record-byte, cause or impact fixtures.

- `record-contract.json` comes from the exact hand-built source in the
  [record contract](../../../docs/guides/record-contract.md#bring-your-own-record),
  including the delete's own `undefined` payload slot in `records.ts`. Its three
  executions, commits and write occurrences are distinct; the append remains a
  value-reconstruction gap and the missing read capture stays conservative.
- `native-compound.json` is a synthetic engine-shaped record, not a claim of a
  live engine/provider invocation. It has a governing decider, two native loop
  executions, a mount plus exit continuation, two writes to the same path in one
  commit, an untracked environment input, admitted retry attention, a redacted
  family, and an additional child scope which P1 refuses with a gap.

The source fixtures live in `records.ts`. The envelope was first captured after
the initial implementation; these extra tests were first run without the expected
files and failed because the pins were absent. They complement, rather than
replace or retroactively label, the implementation's earlier red-first tests.

Before these first pins were accepted, their full nodes, links and gap ordering
were read by hand against the approved mapping. In particular:

- generation and governing communication are standard, node-valued links;
- reads and possible derivations have only extension semantics;
- the mount has one activity and two paired commit metadata nodes;
- repeated write row ordinals remain separate entities, with the missing
  intermediate value disclosed;
- the hidden write exposes only its occurrence position, never its path/value;
- missing native capture and child-scope coverage remain incomplete.

`prov-golden.test.ts` compares the exact full JSON envelope and also checks those
semantics independently. There is no automatic re-pin switch. A future change to
either expected envelope needs an explicit review of its stated contract and
changed lines; a security or correctness defect should be fixed in code, not
hidden by refreshing expected bytes.

The PR #19 gap-budget review changed only these new envelopes' `gaps` arrays:
routine limitations now use document-level counts rather than repeated positions.
Their complete `document` objects and `complete: false` are byte-identical to the
first pins. The review-fix receipt captures the old and new hashes and gap diff;
the established record and cause fixtures remain unchanged.
