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

## Run evidence rides the same doors

A log built with `collects: { reads }` also keeps what an offline reader needs to say why a stage ran: `about` beside a commit (`record(bundle, about)`, or `CommitStamp.about` through a frame), three `run.*` notes (`noteRun`, which stamps `seq` as `record` stamps `idx`) and `runNotes` on `closed`. A lost `about` or note is counted like any lost entry, and the commit still goes. `keepsEvidence` is the one question a writer's seam asks first. The bundle never changes; the shapes and their bounds are in [run-evidence](../run-evidence/README.md).

## Diagnostics are not records

The shared state path codec lives in [record-paths](../record-paths/README.md). [Recording](../recording/README.md) composes a memory log with read-source capture above both libraries; memory does not import that factory.

`setNestedValue` and `updateNestedValue` on `foottrace/paths` retain the nested-write law. Dangerous selector segments are refused before mutation; literal segment arrays preserve dotted keys; arrays concatenate without deduplication; empty collections replace. Payload keys are data. These helpers do not produce commit bundles or define a second replay law.

## Honest readers

A recorded write is not proof of semantic influence on an AI response. Slices describe recorded structure; gaps and untracked sources retain their honesty reasons. Keep those reasons when presenting results to a person or a model.

Time travel folds a detached view of saved history. It does not rerun a tool, restore an external system or resume execution. [Time travel](../time-travel/README.md) and [slicing](../slice/README.md) have focused contracts.
