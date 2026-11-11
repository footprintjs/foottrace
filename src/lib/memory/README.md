# memory/ — the record writer and read model

This directory owns the record, not the engine that produces it. It was extracted from FootPrint 9.48.1 without re-pinning its recorded-byte fixtures. The coordinated 9.48.2 security correction keeps copied payload fields as data through the shared private `capture/ownData.ts` helper; serving and path copying use that same rule. Historical rationale remains in Git; current laws are in the [record contract](../../../docs/guides/record-contract.md).

## One rule per owner

- Leaves: record types, encoded paths, safe nested access, value equality and merging.
- Verb law: one implementation of set/merge/append/delete replay, used by live commits and readers.
- Staging and commit: the private transaction buffer, admission, encoding, scrub bytes and bundle construction.
- Staged reads: `hardWriteCoverage.ts` checks literal path prefixes; the buffer owns hard-write keys and `RecordFrame` uses them only for an undefined read. Hard sets/deletes own their path and descendants; merges alone do not mask live fallback.
- Public writer: `SharedMemory` holds copy-on-write state, `EventLog` owns the frozen base and append-only bundles, and `RecordFrame` stages one step's reads/writes and commits them.
- Sink port (1.1.0): `RecordSink` and `memorySink` (`sink.ts`) — where a log's entries go as they land. `EventLog` delivers, counts and reports; the log's own record never depends on the sink.
- Readers: commit queries and causal analysis; slice and time-travel libraries compose these rules.

Dependency ranks are explicit in `scripts/layers.json`. The checker rejects unranked source, upward runtime edges, cycles, external imports and unresolved or opaque imports. This package loads no engine, scope, runner, provider or Node API.

## Public boundary

`foottrace` owns record types, queries, IDs and honesty codes. `foottrace/write` owns the public writer classes, their types and writer-owned freezing. `foottrace/paths` owns record paths, nested access and safe diagnostic writes. Consumers do not import private files or copy record rules.

The writer supplies an address as literal segments, commit identity and retention decisions. The record does not invent run namespaces, perform a traversal or decide what should be redacted. A frame captures its first-touch base and read evidence and applies the same law to live state and the log. `release()` resets frame-local staging. Retry, pause/resume, scope liveness, observer callbacks and runtime redaction policy belong to the consuming engine.

`freezeRecord` and `serveRecord` share registration within each module format: JSON-shaped records are shared frozen; mutable built-ins are served as protected copies. This is not a generic immutability promise for arbitrary inputs. See the root README for ownership, unsupported values and equality distinctions.

## A sink is told, never waited on (1.1.0)

`new EventLog(base, { sink, address, meta? })` hands the sink every entry as it lands: `opened` from the constructor (the base, as the sink's own copy), `commit` from `record` after the bundle is frozen and appended (the log's own bundle, as served), `note` from `note(kind, data)`, `closed` from `close(outcome, meta?)` with the log's length (`commits`). Without the second argument the log is exactly what it was: no entry, no address, the same bytes.

The record's law is that the run goes on. A sink method that throws or returns a rejected promise (watched once, through the real `Promise.prototype.then`), a sink missing a method, and an entry the log refuses to send (note data that is not a plain object surviving `structuredClone`, a note kind that takes the reserved `run.` prefix, an unknown outcome) are counted in `sinkFailures` and reported to `sink.onFailure({ entry, error })` — never thrown to the writer. A `meta` that will not copy is lost on its own, counted and reported, and its entry still goes: the base, the outcome and the length are never lost to it. The sink keeps its own copy of `meta` and note data, so a later edit by the writer cannot rewrite what was stored; `memorySink` keeps everything frozen as far as freezing reaches (a Date's time or a Map's entries stay open), so no reader can rewrite its containers either. `meta`, a note's kind and its data are opaque: stored and returned, never read. The writer's door refuses what the reader would: a base that is not a plain object, an address with a hole or a non-string segment. Because a stored record cannot be wiped, `clear()` refuses on a log that writes to a sink. A one-argument log has four own fields (`base`, `steps`, `sourceAddress`, `sourceAddressRetired`) — the sink's are added only with a sink.

```ts
import { EventLog, memorySink } from 'foottrace/write';

const sink = memorySink();
const log = new EventLog({}, { sink, address: { logRunId: 'run-1', drillPath: [] }, meta: { chart: 'pay' } });
log.note('attempt', { attempt: 1, outcome: 'timeout' }); // in the store before the run ends
log.close('failed');
sink.entries.map((e) => e.kind); // ['opened', 'note', 'closed']
log.sinkFailures;                 // 0 — or how many entries the sink did not take
```

Each entry is stored as a `RecordEntry`: the method's entry plus the method's name as `kind`; a note's own kind is stored as `note`. `readStoredRecord` (`foottrace`) reads them back — see [time travel](../time-travel/README.md).

## When a step read (the read window)

A log is ordered by commit, and a step commits when it ends. For steps that run one after another that is also the order of their reads. For steps side by side it is not: a branch that reads `x` when it starts and commits last sits in the log after a sibling that wrote `x` in between. A reader that dated the read at the branch's commit named the sibling as the source and left out the step whose value was really read.

So the writer says when a step read state, and only when that is not "just before its own commit":

| On the step's first bundle | Written when | A reader takes it to mean |
|---|---|---|
| nothing | the step read nothing, or no other step committed between its earliest read and its commit | the step saw every commit before its own |
| `beganAt` | another step committed in that time | the step's reads are dated at `beganAt`, not at its commit |
| `beganAt` and `sawUntil` | a read of the step also saw state after such a commit | commits `beganAt` to `sawUntil - 1` are its window: a read may have seen them |

`RecordFrame` has two read tiers: the view pinned at the first touch, and live state for a key that view cannot answer. Every read the frame itself makes of state notes what it saw (`RecordFrame · sawAt`, one door, pinned by a test): for a read from the view, the log's length when the view was pinned; for a live read, its length now. `recordCommit · seenOf` decides what goes on the bundle.

WHY a read, and not every touch of state: the view is also pinned by a step's first write, and by a report that only compares. Counted as a read, a step that read early and wrote late (a subflow mount: its input mapping reads when it starts, its output mapping writes when the subflow has run) looked as if it had read again at its write, and every sibling that committed in between became a possible source of what it had read before. A check that runs only in development would also have changed the bytes of the record. (A step that really does read again later is another matter: an output mapping that reads the parent's list to add to it has read after its siblings committed, and the window is then real.) The door covers the frame's own reads only: `RecordFrame.state` is public, and a caller that reads it directly is not seen, so what it read is neither tracked nor dated.

A reader places the window by the `idx` each bundle carries, not by counting positions back, so a log handed over as a slice, without some of its bundles, or behind another log (the legs of a paused run) still reads right. That is `windowPlacement.ts`, apart from the rule on purpose: the rule speaks in positions, the stamps in indices, and turning one into the other has its own traps (its header lists five ways that looked right and were not). It takes one pass per log and never walks per step: one subtraction when the array is unbroken around the step, halving otherwise, so a wide fan-out costs no more per step than a narrow one. Where the indices around a step cannot be trusted to hold its window, the window is opened over everything before the step: possible sources, never a certain one that may be wrong. A door that takes records from outside keeps an index only when it rises past the copy before it, and writes none of its own (`admitStamps`).

WHY a bundle that says no index is read as a RANGE, not as one number: its place is known only from the bundles around it that say theirs. In an unbroken array that is one place. Where those bundles show a hole (bundles were taken out), it can be any commit in the hole, so a reader counts it inside a step's window whenever it could be there. Read as one number, next to the bundle before it, such a bundle looked older than it was and came back as the one certain source of a step that never saw it (the second reader of this change showed it). What nothing in an array shows is listed under NOT COVERED in `windowPlacement.ts`: above all, a reader names the last writer that is IN the array it was handed.

One rule reads it (`readWindow.ts · readSourcesOf`): a read of a key saw the last write before the step began, or a write of that key inside its window.

```ts
// seed writes x. slow reads x and waits. fast replaces x and commits. slow commits last.
causalChain(log, 'slow#2', reads); // slow <- seed via x        (exact: slow never looked again)
// had slow read x a second time after fast committed:
//   slow <- seed via x   overlap: 'replaced-while-running'
//   slow <- fast via x   overlap: 'written-while-running'       (both possible, the real one is among them)
```

WHY two numbers and not one: with `beganAt` alone a reader would have to treat every commit up to the step's own as possibly read, and the common case (children of a fork that each read state once, at their start) would come back as a list of maybes. `sawUntil` is absent in that case, so the answer is one certain source.

WHY the stamps are refused, not dropped, at a door that takes records from outside (`admitStamps`): a dropped stamp reads as "saw everything before its commit", the very dating the stamp corrects.

What it does not cover is listed at the top of `readWindow.ts` and of `windowPlacement.ts`. Where the idea comes from, and what is ours: [REFERENCES.md](REFERENCES.md).

## A value built in steps (what a write was folded onto)

A write does one of two things to a key. It REPLACES the value: a `set` or a `delete` of the key, or of a container around it. Or it ADDS to the value: a `merge`, an `append`, a row on a path inside the key. After a write that only added, the key holds that write and what was there before, and a step that reads the key reads both.

Every reader used to stop at the last commit that wrote the key. For a write that replaced the value that is the whole answer. For one that added, it left out the step that wrote the rest, with no note:

```ts
// Start sets box = { a: 1 }. Fill merges { b: 2 } into box WITHOUT reading it. Use reads box.
causalChain(log, 'use#2', reads);
//   before:  use <- fill via box                      (Start is missing, and it wrote `a`)
//   now:     use <- fill via box
//            fill <- start via box   builtOn: 'partial-write'
```

One rule answers it (`builtOn.ts`):

| The commit's rows for the key | The value after it | The walk |
|---|---|---|
| a `set` or a `delete` on the key, or around it | this commit's alone | ends here for this key |
| anything else: a `merge`, an `append`, rows inside the key | this write and what the last write before it left | goes on to that commit, with an edge marked `builtOn` |
| the same, and no commit before it wrote the key | this write and the value from before the run | the node says so: `preRunBase` |

WHY commit order here, when a read is dated by the read window: a write that adds is not a read by the step. It is applied when the step commits, onto state as it stands then, and every replay folds the log in that order. So what a write was folded onto is exact: the last write before its own commit, whatever the step saw while it ran. A step that ran beside others can therefore have two parents for one key, each of them certain: the write it read (dated by the window) and the write its own was folded onto.

WHY by verb and path, never by value: calling a write that added a replacement leaves a real source out. Calling a replacement an addition names one step too many. Only the first is an omission, so in doubt a write is read as adding. A `merge` that happens to overwrite the one field a value has is followed to the step that wrote the field before.

WHY no second edge when the step also read the key: `scope.box.b = 2` and `scope.list.push(x)` read the key first, and that read already leads to the earlier writer. A record whose walk was right keeps its answer byte for byte. Beside a read that is only a possible source (steps side by side) both edges stand, because the `builtOn` one is certain.

WHY the rule speaks in commits and knows nothing of steps: a step can commit more than once (a subflow mount commits and then commits its exit), and its later commit is folded onto its earlier one like any other. A reader whose nodes are commits (the cause graph, the key timeline) wants exactly that link. The backward walk's nodes are steps: it draws no edge from a step to itself and passes through the step's own earlier commit to what that one was folded onto. That pass belongs to the walk, not to the rule. The first version had it inside the rule, and the cause graph then had no way back to a step's earlier commit although its way forward reached readers from it.

One consequence for `causalChain`: its result is a DAG unless a step commits a key between two commits of another step that both add to that key. Each of the two then rests on the other, and the walk says so with an edge each way. `flattenCausalDAG`, `formatCausalChain` and `sliceToJSON` visit a node once and end on it; code that follows `parents` itself must do the same. The cause graph, with one node per commit, is always acyclic.

### A `set` row the writer made (`TraceEntry.builtOnView`)

The writer sometimes stores a `set` of a whole value where the step only added:

- under either encoding, when a step's rows would not fold back to what the step read. They are stored as `set` rows of what it read. Ordinary writes reach it: one step that merges into `a.x`, deletes `a.x` and merges into `a` leaves `set a.x`, `set a`;
- under `'delta'`, whenever a step merged into a key and also wrote a path inside it. The two rows would share storage in the bundle, so the writer stores one `set` of the key.

Such a row says `set`, and in the fold it does replace the value. What it holds is the value as the step's VIEW held it, with the step's own writes folded in. Read as a plain replacement, the walk ended there and left out every step whose write was still in the value, with no note. (Found by this rule's own property test, and under the default encoding by its second reader.)

A reader cannot follow what the record does not say, and the writer is the only one who knows. So the writer marks the row:

```ts
// commitValues: 'delta'. Start sets a = { s: 1 }. Fill merges { m: 1 } into a and sets a.in, reading nothing.
log[1].trace;
//   { path: 'a.in', verb: 'set' }
//   { path: 'a',    verb: 'set', builtOnView: true }   the writer's row: what the view held, and Fill's writes
causalChain(log, 'use#0', reads);
//   before:  use <- fill via a                          (Start is missing, and it wrote `s`)
//   now:     use <- fill via a
//            fill <- start via a   builtOn: 'built-on-view'
```

A reader takes the mark as a READ of the path, made for the step, at the commit that carries the row (`builtOn.ts · readFromView`):

| Question | Answer | Why |
|---|---|---|
| What is under the row? | the source of a read of the path, by the read rule (`readWindow.ts`) | the row holds what the VIEW held, and the view was pinned before the commit. A fold is dated at the commit: it would name what a sibling committed in between, and the row replaced that |
| Dated by what? | the moment the view was pinned: `viewAt` on the commit that carries the row | a later commit of a step has a view of its own, pinned after the earlier one. And the view is not a read of the step's code: see below |
| Is it a read by the step? | no | no code of the step asked for the key, so a forward answer and the timeline keep it apart from the steps' reads |

WHY the mark is absent on a `set` the step made itself: such a row replaced the value because the step said so, and nothing older is in it. The writer knows which is which. It marks a row only when no `set` or `delete` of the step covers the path (`hardWriteCoverage.ts · viewMark`).

WHY `viewAt` is a stamp of its own, and not part of the read window (`beganAt`, `sawUntil`). Those two date the reads of the step's CODE, on its first bundle. The view is pinned by the frame's first touch of state, which may be a write. The first form of this change counted the pin as one more look. Then a step that wrote first and read live state later had that read dated as if it could have seen older writes: one certain source became two possible ones, and a row's own source was only "possible" whenever its step had looked twice. Both answers were weaker than what the writer knew. Said on its own, a row has one exact source, and no read is dated differently than before:

```ts
// Fill writes `a` first (that pins its view), Other then replaces `a` and writes `flag`, Fill reads `flag`.
log[2];   // fill: { ..., viewAt: 1 }        no beganAt: its one read saw state just before its commit
causalChain(log, 'use#0', reads);
//   fill <- start via a      builtOn: 'built-on-view'     one source, certain
//   fill <- other via flag                                the read, certain as before
```

WHAT changes in the record, and nothing else does:

- `builtOnView: true` on such a row;
- `viewAt` on a commit that holds one, when another commit landed between the moment the view was pinned and that commit. A commit whose view was the state just before it says nothing.

`beganAt` and `sawUntil` are byte for byte what they were, on every bundle.

What each reader says:

| Reader | A write that only added | A `set` row the writer built on the view |
|---|---|---|
| `causalChain`, `sliceForKey` | `CausalEdge.builtOn: 'partial-write'` on the edge to the write underneath; `CausalNode.preRunBase` when nothing in the log is underneath. Text: `← built on box` | `builtOn: 'built-on-view'` on the edge to the write the view held |
| `forwardSliceForKey` | a value's life does not end at a write that only added, so the readers after it are readers of this value too. A `'partial-write'` note names the commits it crossed | the commit is a reader of the value its view held, marked `ForwardRead.builtOnView`, and it feeds that row alone (`basis: 'built-on-view'`) |
| `keyTimeline` | on the WRITE moment: `builtOnWriteIdx`, or `builtOnPreRun`. One number per write: a list on every read would grow with the square of a loop that appends and reads | `builtOnWriteIdx`, the write the view held. No read moment: the step read nothing |
| `foottrace/cause` | an edge with `attribution: 'recorded-write'` from a node to the write just before it, and from that write forward. Its nodes are commits, so it asks the rule for each node by its own commit and names a node once | the same edge to the write the view held |

One case has more than one write under such a row: an array that does not show where the view sits. `viewAt` is an index of the log, and a log handed over as a slice, or with rows taken out, can hold bundles that say no index. The place of the view is then a range (`windowPlacement.ts`, as for a read). Each write inside it is named as a POSSIBLE source: an edge with `overlap` from the walk, `builtOnViewIdxs` on the timeline's write moment, `conservative` on the cause graph's node. None is called certain and none is left out.

What the rule does not cover is listed at the top of `builtOn.ts`. The one that matters: a producer other than `RecordFrame` that writes a `set` of an earlier value plus a change and neither marks it nor records a read (the record contract says what a producer owes). Where the idea comes from, and what is ours: [REFERENCES.md](REFERENCES.md).

## Run evidence rides the same doors

A log built with `collects: { reads }` also keeps what an offline reader needs to say why a stage ran: `about` beside a commit (`record(bundle, about)`, or `CommitStamp.about` through a frame), three `run.*` notes (`noteRun`, which stamps `seq` as `record` stamps `idx`) and `runNotes` on `closed`. A lost `about` or note is counted like any lost entry, and the commit still goes. `keepsEvidence` is the one question a writer's seam asks first. The bundle never changes; the shapes and their bounds are in [run-evidence](../run-evidence/README.md).

## Diagnostics are not records

The shared state path codec lives in [record-paths](../record-paths/README.md). [Recording](../recording/README.md) composes a memory log with read-source capture above both libraries; memory does not import that factory.

`setNestedValue` and `updateNestedValue` on `foottrace/paths` retain the nested-write law. Dangerous selector segments are refused before mutation; literal segment arrays preserve dotted keys; arrays concatenate without deduplication; empty collections replace. Payload keys are data. These helpers do not produce commit bundles or define a second replay law.

## Honest readers

A recorded write is not proof of semantic influence on an AI response. Slices describe recorded structure; gaps and untracked sources retain their honesty reasons. Keep those reasons when presenting results to a person or a model.

Time travel folds a detached view of saved history. It does not rerun a tool, restore an external system or resume execution. [Time travel](../time-travel/README.md) and [slicing](../slice/README.md) have focused contracts.
