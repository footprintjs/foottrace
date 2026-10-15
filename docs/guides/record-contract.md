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
| `trace` | array of rows | yes | The writes, in order. Each row is `{ path, verb, readKeys? }`. |
| `overwrite` | object | no | Values for `set` and `append` rows, keyed by path. Plain object. |
| `updates` | object | no | Values for `merge` rows, keyed by path. Plain object. |
| `redactedPaths` | array of strings | no | Paths a redaction policy cleared; the fold reports them. |
| `tags` | array of strings | no | Names declared for the stage at build time. Never a value. |
| `idx`, `stage`, `stageId` | | no | Advisory. The reader derives the commit index from position. |

A trace row's `verb` is one of exactly four: `set`, `merge`, `append`,
`delete`. `path` must be a string: a top-level key or a nested path; a nested path uses
the record's own separator (U+001F between segments), and a foreign
producer that writes only top-level keys never needs it.
The validator does not coerce another type to a string or impose a new path
syntax: empty strings and historical string spellings remain accepted.

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
- **One saved-row boundary.** `isCommitBundle(row)` applies the same checks as
  replay. Causal readers still accept typed `CommitBundle[]`, not unknown input.
  A consumer preparing a causal query from stored rows must validate every row
  in its selected prefix first; it must not discard refused rows and present
  the result as complete. The whole unreadable bundle is one replay gap,
  including any otherwise valid writes within it. Existing envelope checks and
  a trace entry's verb refusal take precedence over that entry's path refusal.
  Advisory `stage`, `stageId` and `idx` metadata remain optional.
- **Same answer, any producer.** A record footprintjs wrote and the same
  record written by hand fold to the same state. The example below is that
  record.

## What is not in this contract

- The milestone axis (`Iteration`, `LLM turn`, `Route`, `Answer`) is
  agentfootprint's tag vocabulary over this record, not part of it.
- The served receipt, injections and the story trace are agentfootprint's
  own keys in the state; the fold carries them like any key.
- A record version field. The contract is versioned by the foottrace
  version that reads it, named at the top of this page.

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
| `opened` | once, from the log's constructor | `initialState` (the fold base, the sink's own copy), `meta?` |
| `commit` | per `record`, after the bundle is frozen and appended | `bundle` (the log's own, `idx` stamped) |
| `note` | per `note(kind, data)` | `note` (the note's own kind), `data` |
| `closed` | per `close(outcome, meta?)` | `outcome` (`ok` · `failed` · `paused`), `commits` (the log's length then), `meta?` |

The laws:

1. **A sink is told, never waited on.** The bundle is in the log before the
   sink sees it, and nothing the sink does reaches the writer: a throw, a
   rejected promise or an entry the log refuses to send is counted
   (`sinkFailures`) and reported to `sink.onFailure`.
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
   The first commit entry read for an index stands; a later one for the same
   index (a redelivery or a conflict) is listed in `unread`, never compared.
6. **Complete means the writer finished.** `complete` is `true` when a
   `closed` entry covers every stored commit; its `outcome` and `meta` are the
   log's. A run killed mid-flight reads `complete: false` and keeps its notes.
7. **Bounded work.** No recursion and no walk of a stored value; work per
   entry bounded by the address limits. A record holds at most its stored
   commits plus `missingCommits` gaps, and reading stops after `entries`
   entries. Defaults (`StoredRecordLimits`, raised per call): `entries`
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
- The footprintjs engine witness `test/lib/memory/scenario/write-door-same-bytes.test.ts`
  checks that the same steps through `foottrace/write` and a flowchart give
  the same commit log and reader answers.
- `test/fixtures/hcifootprint/hcifootprint-2.6.1.test.ts` — a real
  producer's stored transitions, replayed through `foottrace/write`, give
  the stored bytes.
- `test/architecture/exports.test.ts` and `test/architecture/layering.test.ts`
  enforce three canonical doors and an engine-free source graph.
- `test/architecture/public-door-state.test.ts` and
  `test/architecture/public-helper-contracts.test.ts` exercise the helper
  contracts, including shared freeze metadata through the built ESM and CJS doors.
- `test/lib/memory/unit/record-sink.test.ts`,
  `test/lib/memory/boundary/record-sink-failures.boundary.test.ts` and
  `test/lib/memory/scenario/record-sink-same-bytes.test.ts` — the four entries
  and their order, a failing sink never reaching the writer, and the pinned
  hcifootprint bytes unchanged with a sink attached (in the log and read back).
- `test/lib/time-travel/stored-record.test.ts`,
  `stored-record.property.test.ts` and `stored-record.boundary.test.ts` — the
  stored-record laws above, every unread reason verbatim, and each limit pinned
  at its default, at its edge and past it.
- `test/lib/ids/attemptId.test.ts` — the attempt-ID round trip.
