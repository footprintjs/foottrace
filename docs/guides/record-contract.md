# The record contract

Time travel, the fold and the lenses read a finished run's **record**. They
never call the executor. So the record's shape is an interface: write it,
from any runtime, and you get the cursor, the fold, the stops, and the
Lens. This page is that interface, carried from footprintjs into foottrace 1.0.0. The
tests that enforce every line are named at the bottom.

## What a record is

A record is a plain JSON value with these fields. Only `commitLog` is
required.

| Field | Type | Required | What it is |
|---|---|---|---|
| `commitLog` | array of bundles | yes | One bundle per executed stage, in execution order. Position is the commit index. |
| `initialState` | object | no | The state the run started from — the **frozen base** every fold starts at. Absent: the fold starts from `{}` and reports `basis: 'log-only'`. |
| `executionTree` | `ExecutionTree` (9.48.0) | no | The run tree, stages linked by `next` and `children`. The readers read `id`, `runtimeStageId`, `subflowId`, the keys of `stageReads`, `next` and `children` — all optional; a live run's `StageSnapshot` tree is one. Needed only for stop kinds, grouping and read keys; the commit axis works without it. |
| `history` | array | no | An older name for `commitLog`; read when `commitLog` is absent. |

Everything else a footprintjs snapshot carries (`sharedState`,
`subflowResults`, `recorders`) is ignored by the reader.

## A bundle

One bundle is one stage's commit: what it wrote, as the log spells it.

| Field | Type | Required | Rule |
|---|---|---|---|
| `runtimeStageId` | string | yes | The stage's address: `[subflowPath/]stageId#executionIndex`. Unique in the run. The reader splits on the LAST `#` and `/`. `~` is reserved. |
| `trace` | array of rows | yes | The writes, in order. Each row is `{ path, verb, readKeys?, readAttempts?, readAttemptsOmitted?, builtOnView? }`. |
| `overwrite` | object | no | Values for `set` and `append` rows, keyed by path. Plain object. |
| `updates` | object | no | Values for `merge` rows, keyed by path. Plain object. |
| `redactedPaths` | array of strings | no | Paths a redaction policy cleared; the fold reports them. |
| `tags` | array of strings | no | Names declared for the stage at build time. Never a value. |
| `untrackedSources` | array of `'args'`, `'env'`, `'silent'` | no | Read paths the stage consumed without read tracking. Absent when the stage used none. The causal readers report the slice as possibly incomplete at such a stage. |
| `phase` | `'exit'` or `'repeat'` | no | Which continuation of a stage's execution this bundle is. The first bundle of a `runtimeStageId` is the stage's own and has no `phase`. `'exit'` is a subflow mount's exit after its merge-back bundle; `'repeat'` is a fork child's fan-out settle. Readers group bundles by `runtimeStageId` and read this field. |
| `beganAt` | whole number | no | How many commits the log held at the earliest moment one of the stage's reads saw. Written only when the stage read state and another stage committed between that moment and this commit. It dates the stage's reads: they saw state as it stood at `beganAt`, not at this commit. A bundle that holds a row marked `builtOnView` writes it by the same rule, with the moment the stage's view was taken counted as a look (law 8); on a later bundle of a stage it then speaks of that row alone. |
| `sawUntil` | whole number | no | How many commits the log held at the latest moment one of the stage's reads saw. Written only with `beganAt` and only when greater. Commits `beganAt` to `sawUntil - 1` are the stage's read window: a read may have seen any of them. |
| `stage`, `stageId` | | no | Advisory. |
| `idx` | whole number | no | The bundle's commit index in the log it was written to. Replay and the cursor derive the commit index from position and do not read it. The read window does: the commits a stage had seen are the ones whose `idx` is below its `beganAt`, so a log handed over as a slice, or without some of its bundles, still reads right. A producer that writes `beganAt` writes `idx` on every bundle, rising along the log, each a whole number up to 2^52. A bundle without `idx` is placed by the bundles around it that have one: past the bundle before it, and before the next one that says an index. Where those two show that bundles are missing, it can be any commit in the hole, and a reader counts it inside a stage's window whenever it could be there. A log where no bundle has one is read by position. |

A trace row's `verb` is one of exactly four: `set`, `merge`, `append`,
`delete`. `path` must be a string: a top-level key or a nested path; a nested path uses
the record's own separator (U+001F between segments), and a foreign
producer that writes only top-level keys never needs it.
The validator does not coerce another type to a string or impose a new path
syntax: empty strings and historical string spellings remain accepted.

### Delivered-answer window

Under `writeProvenance: 'reads-prefix'`, `RecordFrame.noteReadAttempt(id)` records a delivered
canonical call ID separately from state `readKeys`. Each write snapshots the 32 most-recent
distinct IDs (oldest retained first) and optional `readAttemptsOmitted` together. A retained
duplicate refreshes recency; an evicted reentry may evict again. The cumulative eviction count
is not a distinct missing-ancestor count. It saturates at `Number.MAX_SAFE_INTEGER`, meaning
at least that many evictions. Delta and lossy reconstruction preserve the latest pair, not
a union. `readKeys` retains its monotonic prefix law. `discard()` clears both source fields,
leaving attempt notes; `release()` keeps the frame's prefix as before.

Empty/off/zero writer fields are absent. CauseGraph/PROV admission accepts an own safe-integer
zero and normalizes it away, preserving raw saved bytes. Present undefined, inherited,
accessor, negative, fractional and unsafe counts are invalid. A positive count requires
1..32 canonical retained IDs. Legacy rows without a counter retain existing reader budgets;
absence means no cap recorded, never complete ancestry. This is a membership bound, not an
absolute byte bound: IDs remain whole and the codec has no string-byte limit. Readers keep
their own string/work budgets.

A positive counter requires `truncated` coverage. The native record graph and value-free
PROV do not project external calls and also report `conservative`/`not-collected`. A host
that projects every retained call must preserve the omission gap; matching notes, references
or times cannot recover evicted per-write witnesses. State-key-only slices do not project
external call parents. Neither a retained ID nor an empty state-parent list proves semantic
use, remote commitment or complete external ancestry.

## The laws a producer keeps

1. **The base is frozen.** `initialState` is never rewritten. Everything
   after it is a bundle.
2. **The log is append-only.** Bundles are added at the end, never edited,
   never reordered. The commit index of a bundle is its position.
3. **One bundle per executed stage.** A stage that wrote nothing still has
   a bundle, with an empty `trace`; it is a stop the cursor can stand on.
4. **Four verbs, no fifth.** `set` replaces, `merge` deep-merges an object,
   `append` extends an array, `delete` removes. Anything else is not a
   delta the reader can fold.
5. **Addresses are unique and follow the format.** Execution index rises
   monotonically across the run and is never reset, including across a
   pause and resume.
6. **Tags are names, declared up front.** A tag is a string on a bundle,
   decided when the run was built, not a value computed while it ran.
7. **A bundle says when its stage looked at state, if that is not "just
   before its commit".** A log is ordered by commit, and stages that run side
   by side do not read in that order. A producer whose stages run one after
   another writes neither `beganAt` nor `sawUntil`. A producer that runs
   stages side by side writes `beganAt` on a stage that read state and that
   another stage committed under, and `sawUntil` when a read of that stage saw
   state again after such a commit. What counts is a read: a stage that only
   wrote says neither. `RecordFrame` does both for a writer that uses it. A producer
   that leaves them out gets every read dated at its stage's commit: a read
   made before a sibling's commit is then attributed to that sibling.
8. **A `set` row says when it was built on what was there.** A reader takes
   `set` at its word: the value after it owes nothing to the value before
   it. A producer that writes a `set` of an earlier value plus a change
   (because one compact row could not hold the stage's writes) puts
   `builtOnView: true` on that row. The mark says: this row holds what the
   path held in the stage's view of state, with the stage's own writes folded
   in. It belongs on a `set` row only, and only where the stage did not set
   or delete the path itself. Such a commit is dated like a read (law 7):
   the moment its view was taken counts as a look at state. `RecordFrame`
   does both. A producer that writes such a row without the mark, and records
   no read of the key, has left the earlier writers out of every walk back,
   and no reader can tell.

## What the reader promises

- **The fold.** `stateAt(record, commitIdx)` replays the base plus every
  bundle up to and including that index, and hands back a frozen state with
  its **basis** (`'initial+log'` or `'log-only'`), the redacted paths, and
  the bundles it could not read as `skipped`. The record is never touched.
- **Stops.** `timeTravel(record)` derives stops from the log: a `start`,
  one `commit` stop per bundle, an `end`. `tagStops(names)` is a strategy
  handed as `{ strategy }` that keeps only the bundles carrying any of the
  names. With an `executionTree`, stops also carry the stage's kind.
- **Gaps, not refusals.** A bundle the reader cannot read becomes a gap
  `{ index, reason }` in `skipped`. The rest of the record still folds. The
  reasons, exactly:
  - `not an object (null | array | <type>)`
  - `runtimeStageId is missing | a <type>, not a string`
  - `trace is missing | a <type>, not an array`
  - `updates is not a plain object` · `overwrite is not a plain object`
  - `trace[i].verb is missing | "<verb>", not set | merge | append | delete`
  - `trace[i].path is missing | null | an array | a <type>, not a string`
  - only in a stored log read back by `readStoredRecord` (1.1.0), where the
    store holds no readable commit for the index: `no readable commit entry for
    this index`
- **Reads are dated by the stamps.** Every reader that follows a read to its
  writer (`causalChain`, `sliceForKey`, `forwardSliceForKey`, `keyTimeline`,
  the cause graph, the PROV export) asks one rule: a read saw the last write
  before the stage began, or a write inside its read window. With no write of
  the key in the window the source is certain. With one, every source of that
  read is marked `overlap: 'replaced-while-running' | 'written-while-running'`
  and the answer carries a `'concurrent-write'` note: possible sources, the
  real one among them. The window is placed by the `idx` each bundle carries,
  so a log handed over as a slice, without some of its bundles, or behind
  another log reads the same. Where the indices around a stage do not rise
  and cannot be trusted to hold its window, every earlier writer of the key
  is given as a possible source: none certain, none left out. A bundle that
  says no `idx`, where the indices around it show that bundles are missing,
  is counted inside the window whenever it could be there: a possible source,
  never a certain one. The fold does not read the stamps. A door that takes
  records from outside (the cause graph, the PROV export) keeps a bundle's
  own `idx` only when that is a whole number past the bundle before it. On a
  bundle with no stamp any other `idx` is left off the copy, and the door
  writes none of its own, so one odd `idx` cannot move another stage's window
  and a guessed one is never read as a said one. It refuses a bundle whose
  stamps cannot be stamps, or whose stamps sit beside such an `idx`; it never
  drops them.
- **A write that only added is followed to what it was added to.** A `set` or
  a `delete` of a key, or of a container around it, replaces the key's value.
  Any other write (a `merge`, an `append`, a row on a path inside the key)
  was folded onto what the last write before it had left, in commit order,
  and the value is made of both. Every reader that follows a value to its
  writers goes on from such a write to that commit: `causalChain` and
  `sliceForKey` with an edge marked `builtOn: 'partial-write'` (and
  `preRunBase` on the node when no commit before it wrote the key),
  `forwardSliceForKey` by not ending a value's life there (a
  `'partial-write'` note names the commits), `keyTimeline` with
  `builtOnWriteIdx` or `builtOnPreRun` on the write moment, the cause graph
  with an edge of attribution `'recorded-write'`. The rule is by commit: a
  stage that committed twice has its later commit folded onto its earlier
  one, and the readers whose answers are commits (the timeline, the cause
  graph) link them. `causalChain` answers in stages, draws no edge from a
  stage to itself, and is a DAG unless one stage commits a key between two
  commits of another that both add to it; then each rests on the other and
  there is an edge each way. The test is by verb and path, never by value:
  a `merge` that overwrote the only field a value had is still followed.
  One writer too many, never one too few. A stage that also read the key
  keeps its one edge, the read's.
- **A `set` row built on what was there is followed to it.** A row marked
  `builtOnView` (law 8) replaces the value in the fold and still holds what
  the stage's view held. Every reader takes the mark as a read of the path,
  made for the stage, at the commit that carries the row, and dates it by
  that commit's own stamps: `causalChain` and `sliceForKey` with an edge
  marked `builtOn: 'built-on-view'`, `forwardSliceForKey` with a read marked
  `builtOnView` and one edge to that row (`basis: 'built-on-view'`),
  `keyTimeline` with `builtOnWriteIdx` on the write moment (or
  `builtOnViewIdxs` when the view could have held several writes), the cause
  graph with an edge of attribution `'recorded-write'`. It is never counted
  as a read by the stage's code: the timeline shows no read moment for it. A
  door that takes records from outside keeps the mark and refuses one that
  cannot be a mark (another value, or another verb).
- **A reader names the writers that are in the array.** Every reader that
  takes a commit log takes it as the history before each stage: the source of
  a read is the last writer of the key that is in the array. A bundle that was
  taken out may have written the key later, and a log joined after another
  may have lost its own first commits; the answer then names an earlier
  writer as certain, and nothing in the answer marks it. That holds with or
  without the stamps. Hand over the whole log, or treat the answer as "the
  last writer among these bundles". (`readStoredRecord` does know which
  commits a stored log lost, and reports each as a gap.) When two logs are
  handed over one after the other (the legs of a paused run), the first
  bundle of the second must say its `idx`: that index not rising is what
  shows a reader where the second log begins.
- **One saved-row boundary.** `isCommitBundle(row)` applies the same checks as
  replay. Causal readers still accept typed `CommitBundle[]`, not unknown input.
  A consumer preparing a causal query from stored rows must validate every row
  in its selected prefix first; it must not discard refused rows and present
  the result as complete. The whole unreadable bundle is one replay gap,
  including any otherwise valid writes within it. Existing envelope checks and
  a trace entry's verb refusal take precedence over that entry's path refusal.
  `stage`, `stageId` and `idx` remain optional for replay.
- **Same answer, any producer.** A record footprintjs wrote and the same
  record written by hand fold to the same state. The example below is that
  record.

## What is not in this contract

- The milestone axis (`Iteration`, `LLM turn`, `Route`, `Answer`) is
  agentfootprint's tag vocabulary over this record, not part of it.
- The served receipt, injections and the story trace are agentfootprint's
  own keys in the state; the fold carries them like any key.
- A record version field. The contract is versioned by the foottrace
  version that reads it.
- A check that a `set` row with no mark really replaced the value. The mark
  of law 8 is the producer's word. A producer that writes a `set` of an
  earlier value plus a change and leaves the mark off is read as having
  replaced the value, and the writers of that earlier value are left out.
  `RecordFrame` marks the two cases in which it writes such a row itself:
  under either encoding, rows that would not fold back to what the stage
  read (one stage that merges into `a.x`, deletes `a.x` and merges into `a`
  is recorded as `set a.x`, `set a`); and under `commitValues: 'delta'`, any
  stage that merged into a key and wrote a path inside it.
- Which of a stage's looks at state a marked row was built on. A bundle says
  when its stage first and last looked. When the key was written between
  those two, each of those writes is named as a possible source of the row,
  and none as the certain one. On a stage's first bundle the moment the view
  was taken joins the stage's read window, so a read that stage made later
  is dated by the wider window.

## Bring your own record

```ts
import { stateAt, tagStops, timeTravel } from 'foottrace';

const record = {
  initialState: { count: 0, items: [] },
  commitLog: [
    { runtimeStageId: 'seed#0',   trace: [{ path: 'count', verb: 'set' }],    overwrite: { count: 1 } },
    { runtimeStageId: 'grow#1',   trace: [{ path: 'items', verb: 'append' }], overwrite: { items: [10] }, tags: ['milestone:step'] },
    { runtimeStageId: 'forget#2', trace: [{ path: 'count', verb: 'delete' }], overwrite: { count: undefined } },
  ],
};

const tt = timeTravel(record);              // start, three commit stops, end
stateAt(record, 1).state;                   // { count: 1, items: [10] }
stateAt(record, 2).state;                   // { items: [10] }
timeTravel(record, { strategy: tagStops(['milestone:step']) }).stops; // start, the tagged stop, end
```

The full example, run as an integration test, is
`examples/post-execution/time-travel/06-bring-your-own-record.ts`.

## Writing a record

A record can be written by hand, as above, or through `foottrace/write`:
the record layer the engine itself writes with. There is no wrapper, so a
record written this way comes from the same code — and the same bytes — as one
a flowchart wrote, and it keeps the laws above by construction:

| Class | What it is | The laws it keeps |
|---|---|---|
| `SharedMemory` | The heap: live state, one generation per commit | — |
| `EventLog` | The log: the base (a copy of the state it is given) and the bundles, each frozen as it is recorded | 1, 2 |
| `RecordFrame` | One step: its reads (`read`, and `noteRead` to name a read on the rows), its writes (`write(path, value, verb, scrub?)` at `at(path, key)`), and one `commit` | 3, 4 |

- **One step, one frame, one bundle.** `commit(stampOf)` records the bundle
  the step staged — the empty bundle when it staged nothing — named by the
  stamp: `stage`, `stageId`, `runtimeStageId`, and optionally `tags` —
  names you declare up front (law 6), never a value the step computed.
- **Addresses are yours to keep unique** (law 5): build them with
  `buildRuntimeStageId` and one `createExecutionCounter` from
  `foottrace`, never reset.
- **The two dials** are the frame's encoding (`useEncoding`):
  `commitValues: 'full' | 'delta'` (a grown array is an `append` of its tail
  under `'delta'`) and `writeProvenance: 'off' | 'reads-prefix'` (each row
  names the reads noted before it, `readKeys`).
- **A secret** is written with the bytes of a redaction verdict: the scrub
  `{ whole: true }` puts `'REDACTED'` in the log at the path, and
  `{ fields: [...] }` at each field inside the value; the heap keeps the value.
- **Promised:** the writing contract — the members above, one frame per step —
  and the bytes they write follow the record fixtures' re-pin policy
  (`test/fixtures/README.md`): a refactor never moves a byte. The classes also
  carry engine-facing members that are not part of it: `SharedMemory ·
  setValue` / `updateValue` (they write the heap with no bundle), `EventLog ·
  clear` (wipes the history; refused on a log that writes to a sink), `materialise` (deprecated: use `stateAt`),
  `recorded` / `bindAddress` (internal), and `RecordFrame · useAddress` (only
  before a frame's first write, which the frame does not check).

```ts
import { buildRuntimeStageId, createExecutionCounter, stateAt, tagStops, timeTravel } from 'foottrace';
import { EventLog, RecordFrame, SharedMemory } from 'foottrace/write';

const state = new SharedMemory(undefined, { count: 0, items: [] as number[] });
const log = new EventLog(state.getState()); // the frozen base (law 1)
const counter = createExecutionCounter(); // execution indices rise, never reset (law 5)

/** One step: a fresh frame, its writes, one commit — one bundle (law 3). */
function step(stageId: string, write: (frame: RecordFrame) => void, tags?: string[]) {
  const frame = new RecordFrame(state, log);
  frame.useEncoding({ commitValues: 'delta', writeProvenance: 'off' });
  write(frame);
  frame.commit(() => ({ stage: stageId, stageId, runtimeStageId: buildRuntimeStageId(stageId, counter.value++), tags }));
}

step('seed', (f) => f.write(f.at([], 'count'), 1, 'set'));
step('grow', (f) => f.write(f.at([], 'items'), [10], 'set'), ['milestone:step']); // an `append` of [10]
step('forget', (f) => f.write(f.at([], 'count'), undefined, 'delete'));
step('idle', () => {}); // wrote nothing: still a bundle, a stop the cursor can stand on

const record = { initialState: log.getInitialState(), commitLog: log.list() };
stateAt(record, 1).state; // { count: 1, items: [10] }
stateAt(record, 3).state; // { items: [10] }
timeTravel(record, { strategy: tagStops(['milestone:step']) }).stops; // start, the `grow` stop, end
```

The standalone reader example is
`examples/post-execution/time-travel/06-bring-your-own-record.ts`.

## A stored record

A log built with a sink (`new EventLog(base, { sink, address, meta? })`,
1.1.0) hands every entry to a `RecordSink` as it lands, so a run that is killed
still leaves its record. A sink stores each entry as a `RecordEntry`: the
method's entry plus the method's name as `kind`.

| `kind` | Written | Fields besides `address` (`{ logRunId, drillPath }`) and `at` (epoch ms) |
|---|---|---|
| `opened` | once, from the log's constructor | `initialState` (the fold base, the sink's own copy), `meta?`, `collects?` |
| `commit` | per `record`, after the bundle is frozen and appended | `bundle` (the log's own, `idx` stamped), `about?` |
| `note` | per `note(kind, data)` or `noteRun(kind, data)` | `note` (the note's own kind), `data` |
| `closed` | per `close(outcome, meta?)` | `outcome` (`ok` · `failed` · `paused`), `commits` (the log's length then), `meta?`, `runNotes?` |

The laws:

1. **A sink is told, never waited on.** The bundle is in the log before the
   sink sees it, and nothing the sink does reaches the writer: a throw, a
   rejected promise or an entry the log refuses to send is counted
   (`sinkFailures`) and reported to `sink.onFailure`. A `meta` the log cannot
   copy is lost on its own; its entry still goes. A log that writes to a sink
   needs a plain-object base and an address of string segments.
2. **A sink moves no byte.** The log writes the same bundles with or without
   one; notes never enter a bundle.
3. **Opaque stays opaque.** `meta`, a note's kind and its data are the
   writer's: stored and handed back, never read. The sink keeps its own copy.
4. **The reader checks what storage gives back.** `readStoredRecord` takes
   `Iterable<unknown>` (stored entries are untrusted input), groups entries by
   address (each log in arrival order), and lists an entry it does not read
   into a log in `unread` with its position and reason.
5. **A commit sits at its own index.** A lost commit and an unreadable bundle
   are gaps that keep their index — the same reason in `StoredLog.gaps` and in
   the fold's `skipped`. `closed.commits` makes a lost last commit a gap too.
   One place, one entry: the first readable commit for an index stands, the
   first `opened` stands, and every other entry for a held place (a redelivery,
   a conflict, the same object again) is listed in `unread`, never compared.
6. **Complete means the writer finished, and the reader read it all.**
   `complete` is `true` when a `closed` entry covers every stored commit (of
   covering closes, the largest length speaks; its `outcome` and `meta` are the
   log's) and no limit cut the log or stopped the read. A run killed
   mid-flight reads `complete: false` and keeps its notes.
7. **Bounded work.** No recursion, no walk of a stored value, an address read
   by index; work per entry bounded by the address limits. A record holds at
   most its stored commits plus `missingCommits` gaps (spent on the logs that
   need the fewest first), and reading stops after `entries` entries. Defaults (`StoredRecordLimits`, raised per call): `entries`
   16,777,216 · `missingCommits` 1,048,576 · `drillDepth` 1,024 ·
   `addressLength` 65,536 characters. Whatever a limit stops is listed in
   `unread` by name: never a hang, never a silent cut.

```ts
import { readStoredRecord, stateAt } from 'foottrace';

const run = readStoredRecord(entries).root('run-1')!; // entries: what the sink stored, in write order
run.complete; // false when no closing entry was stored
run.notes; // [{ kind, at, data }] — in arrival order
stateAt(run.source(), run.commitLog.length - 1); // the fold over what landed, gaps in `skipped`
```

### Run evidence beside the log

A log built with `collects: { reads: 'keys' | 'off' }` says so on `opened`
(`collects: { v, reads }`) and keeps three more facts. All of them are optional
fields or notes, so a reader that knows none of them reads the same record.

| Where | Holds |
|---|---|
| `commit.about` | On an execution's first bundle, beside it: `parent`, `resumes`, `reads` (names, at most 256 of at most 256 characters, the rest counted in `readsOmitted`), `description` (at most 512 characters), `attention` (only each mark's `kind`, `reason` and `evidence`, under the attention rule). Under `collects` it is always written, so a missing one means that stage was not collected. |
| `note` `run.decision` | `{ seq, id, by, chosen, total?, fellBack?, rationale?, evidence? }`, one per decider or selector dispatch, after its commit. |
| `note` `run.stop` | `{ seq, id, by, reason?, propagatedFrom?, pausedBy?, payload?, category?, error? }`, one per early stop. |
| `note` `run.stage` | `{ seq, id, parent? }`, for every mount at entry and any execution with no commit of its own. |
| `closed.runNotes` | How many `run.*` notes the log wrote. A lost tail shows here, a lost note as a hole in `seq`. |

The `run.` prefix is reserved. A reader treats a `run.*` kind it cannot name as a fact it may have lost, so a new kind takes a larger `collects.v`.

The writer serves every value before it reaches the log; the log masks nothing.
An adapter that copies named fields must copy `collects`, `about` and `runNotes`;
one that does not stays a good adapter, and the reader says `not-collected`.

`readRunEvidence(readStoredRecord(entries), legs)` reads them back: `decisions`,
`stops`, `reads`, `attention`, `stages` and `running` channels, and `control(id)`,
each saying `collected`, `partial` or `not-collected`. A file with no `collects`
reads `not-collected`, never "nothing happened". See
[run-evidence](../../src/lib/run-evidence/README.md) for what each status promises
and for the reader's threat model.

Attempt IDs (`buildAttemptId` / `parseAttemptId`) address one attempt under a
stage execution — `<runtimeStageId>@<n>`, and `<runtimeStageId>@<n>.<k>@<m>`
for a call's attempt — parsed from the right, so no stage-ID character is
newly reserved.

## Public helpers and their contracts

The three doors have distinct responsibilities: `foottrace` reads records and
runtime IDs, `foottrace/write` owns record creation, and `foottrace/paths` owns
record paths and nested diagnostic writes. A declaration has one public door.

ID paths and record paths use different grammars. `idPathSegments('/a//b/')`
returns `['a', 'b']`, dropping empty ID segments. Record `pathSegments` preserves
empty segments and literal dots. `normaliseStateKey` accepts either an already
encoded record path or a readonly array of segments; a string such as `'a.b'`
is a literal key. `nativeGet` and `nativeHas` accept arrays or dot-separated
strings, so decode a recorded path before passing it to them:

```ts
import { normaliseStateKey, pathSegments, nativeGet } from 'foottrace/paths';

const key = normaliseStateKey(['a.b', 'c']);
nativeGet({ 'a.b': { c: 1 } }, pathSegments(key)); // 1
```

`nativeGet` refuses `__proto__`, `constructor` and `prototype` selectors and
requires an own property at every step. `nativeHas` tests own existence,
including those names and values that are `undefined`; it does not apply the
denied-name rule. `isDeniedSegment` exposes that exact rule. The nested writers
refuse a whole selector containing a denied name before creating any containers.
Their arrays concatenate when updated, an empty array clears, and object updates
use the existing shallow merge. Payload keys remain data.

The ID helpers do not validate arbitrary strings. `isExecutionKey` checks for
the execution delimiter; `stageIdOf` returns the full prefixed stage ID, while
`splitStageId(...).localStageId` returns its final segment. `PATH_DELIMITER` and
`EXECUTION_DELIMITER` describe the ID grammar, not the record-path encoding.

`deepEqual` compares recorded state: an own `undefined` equals an absent key,
`0` equals `-0`, array expandos are ignored, and Map keys use identity. Its
default opaque-value rule is identity. Use `'copies'` only when comparing copies
of one recorded value: it considers opaque values of the same kind equal, without
inspecting their contents.

`freezeRecord` consumes a writer-owned object in place. It freezes containers,
may replace a typed-array or DataView slice with a copy of its visible bytes,
and remembers values that cannot be sealed. `serveRecord` then copies those
values and their containing paths, sharing sealed subtrees. Both functions must
come from the same installed package and module format so they share that
metadata. Passing an arbitrary object directly to `serveRecord` returns that
object unchanged; it is not a general copying or validation function.

```ts
import { serveRecord } from 'foottrace';
import { freezeRecord } from 'foottrace/write';

const record = freezeRecord({ when: new Date(5), label: { text: 'kept' } });
const held = serveRecord(record);
held.when.setTime(99);
serveRecord(record).when.getTime(); // 5
held.label === record.label; // true: a frozen subtree can be shared
```

`deepFreeze` is a guard over owned containers, not a guarantee that every
native internal slot is immutable. It skips typed-array views, leaves a Date's
time and Map/Set contents mutable, and does not descend into already frozen
objects. Its default array walk includes expandos; `'indices'` does not. The
writer's `LOG_PLACEHOLDER` is the historical `'REDACTED'` record byte.

## Enforced by

- `test/lib/time-travel/record-contract.test.ts` — the hand-built record
  folds through all four verbs; every gap reason above, verbatim; an
  unknown verb is a gap, not a merge.
- `test/lib/time-travel/stored-recording.test.ts` — a stored record drives
  the cursor with no cast.
- `test/lib/time-travel/fold-memo.test.ts` — the fold never touches the
  record, and stepping equals a fresh fold at every stop.
- `test/fixtures/hcifootprint/hcifootprint-2.6.1.test.ts` — a real
  producer's stored transitions, replayed through `foottrace/write`, give
  the stored bytes.
- `test/architecture/exports.test.ts` and `test/architecture/layering.test.ts`
  enforce six canonical code entry points (root, `/write`, `/paths`, `/cause`,
  `/prov` and `/metadata`) and an engine-free source graph.
- `test/architecture/public-door-state.test.ts` and
  `test/architecture/public-helper-contracts.test.ts` exercise the helper
  contracts, including shared freeze metadata through the built ESM and CJS doors.
- `test/lib/memory/unit/record-sink.test.ts`,
  `test/lib/memory/boundary/record-sink-failures.boundary.test.ts` and
  `test/lib/memory/scenario/record-sink-same-bytes.test.ts` — the four entries
  and their order, a failing sink never reaching the writer, and the pinned
  hcifootprint bytes unchanged with a sink attached (in the log and read back).
- `test/lib/memory/unit/record-sink-evidence.test.ts` — `collects`, `about`,
  `runNotes` and `noteRun`: copied and bounded, every refusal counted, the
  one-argument log's own fields unchanged, and a named-field adapter's view.
- `src/lib/run-evidence/*.test.ts` and `test/cause/stored-run-evidence.test.ts` —
  the fold against a real engine's recorder, the resume fold, every channel's
  status, the reader's threat model, and the stored graph filling its own maps.
- `test/lib/time-travel/stored-record.test.ts`,
  `stored-record.property.test.ts` and `stored-record.boundary.test.ts` — the
  stored-record laws above, every unread reason verbatim, and each limit pinned
  at its default, at its edge and past it.
- `test/lib/ids/attemptId.test.ts` — the attempt-ID round trip.
