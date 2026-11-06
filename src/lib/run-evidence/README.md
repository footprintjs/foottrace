# run-evidence/ — why a stage ran, from the file alone

A stored log says what a run wrote. This folder holds what else an offline reader needs to say why: which execution led to which, what a decider weighed, why a stage stopped early, and what was still running when a process died.

| File | One job |
| --- | --- |
| `kinds.ts` | The stored shapes and their bounds, shared by writer and reader |
| `rows.ts` | What the reader hands back: channels and rows |
| `fields.ts` | The own-data primitives every row check is built from |
| `admit.ts` | One row, checked as untrusted input. Admitted whole or refused whole |
| `logFold.ts` | One flat pass over a log, and the checks that need the whole log |
| `control.ts` | Which decision let an execution run: one forward pass, no walk |
| `channels.ts` | Each kind of fact, and how far to trust its absence |
| `read.ts` | `readRunEvidence`, the one door |

**Why these shapes.** `EventLog` writes `opened.collects`, `commit.about`, three `run.*` notes and `closed.runNotes`. They are optional fields and notes because a new top-level entry kind breaks every earlier reader. Nothing else is stored: the control map and the narrative are folded at read time. The writer serves each value first, so a masked threshold is already a hole with `thresholdRedacted` on disk, and nothing here masks anything a second time.

```ts
import { readRunEvidence, readStoredRecord } from 'foottrace';

const evidence = readRunEvidence(readStoredRecord(entries), 'run-1');
evidence.control('manual/junior#7'); // { status: 'collected', decider: 'manual/assign#6', label: 'Medium risk', gaps: [] }
evidence.decisions.rows[0]?.evidence?.rules; // what it weighed
evidence.running.rows; // a killed run: the innermost subflow still open. The stage inside it stays unknown.
```

## How far to trust an absence

Every channel says one of three things, and so does `control(id)`.

| Status | Means | An empty channel means |
| --- | --- | --- |
| `collected` | The writer collected it and the log is whole | None happened |
| `partial` | Never closed, a `seq` hole, a lost commit, a limit, a refused row. `gaps` says which, from the one `GapCode` registry | None SEEN |
| `not-collected` | This log holds no such facts. `why` says `no-collects`, `newer-writer`, `invalid-collects`, `reads-off` or `no-log` | Nothing at all |

A file with no `collects`, including every file an older writer made, reads `not-collected` and never "nothing happened".

`collected` with no decision means no declared decider or selector ran. An `if` inside a stage is not a decision and was never recorded.

`control(id)` never says ungoverned by accident. No `decider` under `collected` means a whole chain to the true root. A parentless execution that is not the root reads `partial` (`resumed-leg`). A parent no given log holds reads `partial` (`log-not-given`). A stage with no `about` reads `not-collected` (`no-about`). Following `resumes` reads `conservative`, because stages after a re-entry may be over-attributed to the branch it continued.

`about.reads` joins `bundle.untrackedSources`, which reads `partial` (`untracked-input`): that stage also read what no name shows.

## Threat model: a record file is untrusted input

- **Own data only.** Accessors, custom prototypes and sparse arrays are refused, and no getter runs. A field nobody named is never read or copied, so a newer writer can add one without a version bump.
- **Hostile keys.** Everything keyed by id lives in a `Map`. Ids must pass the runtimeStageId grammar. A `__proto__` key in a payload stays an own data field.
- **Caps.** `RUN_EVIDENCE_LIMITS` (`foottrace/write`), raised per call: rules, conditions, inputs, text, read names, payload and forged-threshold depth and size, one field budget per call. Past a cap the row goes to `unread` and the channel reads `partial` (`truncated`). There is no partial row and no recursion.
- **Forged rows.** Refused: a decision with no commit in its log, a `parent` or `resumes` at or after its child, a mount's first execution that does not lead in, `run.stage` and `about` that disagree. A duplicate `seq` or `about` keeps the first. Every edge points backward, so a chain cannot cycle, and a chain's length costs one pass over the rows. A huge `seq` or `runNotes` allocates nothing: holes are counted by arithmetic.
- **Logs not given.** Only the logs of the legs named are read. A chain into any other log stays `partial`, even when the store holds that log.
- **Text reaching a model.** A label, a reason, a `matchError`, a payload, an error message and a summary are data. Bound and quote them; never treat them as instructions. An `unread` reason names a field and never echoes the file.

Integrity is not authentication. These checks catch inconsistent edits, not a careful forger, and storage authorization stays the host's.
