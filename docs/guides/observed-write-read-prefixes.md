# Completed reads observed before a write

An exact source identifies the recorded version a read observed. It does not identify which expression used that value. An ignored read and a read used in arithmetic can have the same proxy observations.

Native writers can opt in when opening a new read-source record:

```ts
import { SharedMemory, RecordFrame, createReadSourceRecord } from 'foottrace/write';

const state = new SharedMemory(undefined, { amount: 4 });
const record = createReadSourceRecord(
  state,
  { logRunId: 'example', drillPath: [] },
  {
    writeReadPrefixes: true,
  },
);
const frame = new RecordFrame(state, record.log);
const owner = { runtimeStageId: 'calculate#0', attemptId: 'calculate#0@1' };
frame.useReadSourceOwner(owner);
const amount = frame.readWithSource([], 'amount', owner).value as number;
frame.write(['total'], amount * 2, 'set');
frame.commit(() => ({ stage: 'Calculate', stageId: 'calculate', runtimeStageId: owner.runtimeStageId }));
frame.release();
const sources = record.snapshot(); // version 2; save beside this exact native log
```

`useReadSourceOwner` retains only owner data until a real access creates a frame. It never moves the first-touch state boundary. Clear pending ownership with `useReadSourceOwner()` before preparing another actual attempt; clearing an already touched incarnation fails capture closed. Release/discard clears the pending owner. A host must supply actual native identities, never guessed stage names or model-selected labels.

Source format 2 adds a completion sequence to each retained read and a `writeReadPrefixes` sidecar. Each output entry names a native commit and trace row, frame, owner and attempt, plus the completed observation frontier and read count. Reservation order is not completion order: a pending outer read may finish after an inner write. The writer records the frontier during staging, then binds it to the actual committed row. A shared per-frame sequence avoids copying every previous read onto every write.

The first supported outputs are unique scalar root `set` writes. Repeated paths, aggregate/no-op writes, nested/composite fields, merges, deletes and unmapped owners do not gain a precise association. Staged source generations remain unsupported by the cause reader. The source-v2 sidecar has independent immutable wire ceilings, constrained by the existing configured `maxOccurrences`, `maxOrigins` and overall `maxBytes`. Sidecar data spends that same byte allowance. Exhaustion is explicit partial evidence. These are retained-data/work allowances, not a claim about arbitrary author hooks, Proxy traps, total CPU or peak memory.

Pass the source snapshot and authorized execution bindings through the existing `RecordScope.readSources` seam. Cause output queries exclude later completed reads, expose `write-prefix:<commit>:<row>` references and retain a conservative gap for possible contributors. The constant-assignment counterexample therefore cannot gain a semantic root. PROV keeps `ft:PossibleDerivation` with `ft:attribution: observed-before-write`; it never turns the temporal observation into `prov:wasDerivedFrom`.

Admission checks the source address/segment, owner/attempt, frame, completion and frame counts, native committed row, scalar output and privacy. Each frame also records its actual committed trace-row count, including unsupported outputs: deleting a captured prefix is refused by the standalone decoder. The native reader then reconciles the entire captured inventory against the actual retained log; editing a count alone cannot silently hide a native output. Partial write-prefix coverage makes forward impact incomplete, independently of complete backward read evidence. Path hashing and repeated privacy comparisons spend the caller's work allowance before scanning.

Missing, inconsistent, discarded, redacted or over-budget evidence stays unknown. Admission is structural consistency, not producer authentication. Someone able to coherently rewrite all stored witnesses may also rewrite their unkeyed checksum; host authorization or a separately trusted signature policy remains a distinct boundary.

If a read's matching later output has an unavailable association, forward impact stays incomplete and the reader invents no output edge. Active or discarded read/output linkage also stays incomplete. Unrelated frames and outputs staged before that read do not create a link or downgrade its independent evidence. These forward uncertainties do not alter an independently complete backward explanation.

Migration: this is a breaking public type change and its release fragment requests a major release. Readers must explicitly accept source format 2 before a writer enables it. Older readers refuse it. The new `ReadSourceSnapshot.version` union includes `2`, so exhaustive TypeScript consumers and assignments that assumed `version: 1` must add that case. Format 1 remains readable and disabling this option retains its original source and log bytes; that runtime property is not a blanket source-compatibility claim. No package version is bumped by this feature PR. The reviewed major release must use the dependency-order release-candidate and consumer adoption train.
