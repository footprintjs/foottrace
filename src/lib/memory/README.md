# memory/ — the record writer and read model

This directory owns the record, not the engine that produces it. It was extracted from FootPrint 9.48.1 without re-pinning its recorded-byte fixtures. The coordinated 9.48.2 security correction keeps copied payload fields as data through the shared private `capture/ownData.ts` helper; serving and path copying use that same rule. Historical rationale remains in Git; current laws are in the [record contract](../../../docs/guides/record-contract.md).

## One rule per owner

- Leaves: record types, encoded paths, safe nested access, value equality and merging.
- Verb law: one implementation of set/update/append/delete replay, used by live commits and readers.
- Staging and commit: the private transaction buffer, admission, encoding, scrub bytes and bundle construction.
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

The record's law is that the run goes on. A sink method that throws or returns a rejected promise, a sink missing a method, and an entry the log refuses to send (note data that is not a plain object surviving `structuredClone`, an unknown outcome) are counted in `sinkFailures` and reported to `sink.onFailure({ entry, error })` — never thrown to the writer. The sink keeps its own copy of `meta` and note data, so a later edit by the writer cannot rewrite what was stored. `meta`, a note's kind and its data are opaque: stored and returned, never read. Because a stored record cannot be wiped, `clear()` refuses on a log that writes to a sink.

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

## Diagnostics are not records

`setNestedValue` and `updateNestedValue` on `foottrace/paths` retain the nested-write law. Dangerous selector segments are refused before mutation; literal segment arrays preserve dotted keys; arrays concatenate without deduplication; empty collections replace. Payload keys are data. These helpers do not produce commit bundles or define a second replay law.

## Honest readers

A recorded write is not proof of semantic influence on an AI response. Slices describe recorded structure; gaps and untracked sources retain their honesty reasons. Keep those reasons when presenting results to a person or a model.

Time travel folds a detached view of saved history. It does not rerun a tool, restore an external system or resume execution. [Time travel](../time-travel/README.md) and [slicing](../slice/README.md) have focused contracts.
