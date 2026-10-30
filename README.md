# foottrace

Execution records and the tools to read them: replay, time travel, slices, and evidence about where values came from. No flowchart engine, AI provider, or runtime dependency is required.

This package extracts FootPrint's established record layer. It does not introduce a second writer or a different replay law. The first release preserves the frozen record fixtures from footprintjs 9.48.1 and includes the coordinated 9.48.2 copy-safety correction: an own `__proto__` payload field stays data, never the copy's prototype. See the [changelog](CHANGELOG.md) for the limited rich-value behavior change.

Foottrace owns the record layer used by footprintjs 10. Older stored records remain readable without installing their original engine.

## Entry points

| Import | Responsibility |
| --- | --- |
| `foottrace` | Record types, runtime and attempt IDs, replay, time-travel cursors, causal and variable slices, honesty codes, the stored-record reader |
| `foottrace/write` | `SharedMemory`, `EventLog`, `RecordFrame`, encoding and write types, writer-owned freezing, the record sink port and `memorySink` |
| `foottrace/paths` | Record-path encoding/decoding, nested access and safe diagnostic writes |
| `foottrace/cause` | Optional bounded attention, cause and impact queries; in-memory and lazily loaded stored-record adapters |
| `foottrace/metadata` | Optional bounded path-occurrence queries for value-free projections; candidate read links, no state replay |
| `foottrace/prov` | Optional bounded, asynchronous export of one recorded scope as PROV-O JSON-LD, without values |

Every declaration has one public entry point. Producer-facing `Attention` and `AttentionKind` are type-only root exports; the cause algorithms live only on `/cause`. Existing root, `/write` and `/paths` imports retain their ESM and CommonJS doors. There are no public deep imports or `/testing` entry point. FootPrint's engine, observer channels, recorders and stores remain in `footprintjs`.

## PROV-O export (since 1.6.0)

The optional `foottrace/prov` entry exports one record as JSON-LD using
[PROV-O, a W3C Recommendation](https://www.w3.org/TR/prov-o/). The asynchronous
`exportProv(record, { base })` returns `{ document, gaps, complete }`. It includes
recorded activities, write occurrences and supported control links; it exports no
values, fingerprints, inferred people or invented times. Captured reads remain
explicit candidate evidence rather than a claim of semantic derivation.

Redacted writes retain opaque placeholders: their count and position remain
visible, while their names and values are withheld. Every P1 export returns
`complete: false`; native capture and ending attestation must first be implemented
and supported by this reader. Keep its gaps with the document. See the
[export recipe and safety limits](https://github.com/footprintjs/foottrace/blob/main/docs/prov.md)
and the [runnable example](https://github.com/footprintjs/foottrace/blob/main/examples/post-execution/prov/01-export-prov.ts).

## Value-free trace metadata — unreleased

`readTraceMetadata` and `traceMetadata` on `foottrace/metadata` admit a bounded,
value-free source and inspect its path occurrences and explicitly anchored read
candidates. A recorded path occurrence is not a proven value change or origin.
Unknown reads, overlaps and projection-local addresses remain explicit; metadata
never supplies replay state. The reader uses the canonical path index and bounded
walk, while complete-record APIs keep their established semantics. See the
[metadata contract and limits](https://github.com/footprintjs/foottrace/blob/main/docs/metadata.md).

## Write and replay

```ts
import { stateAt } from 'foottrace';
import { EventLog, RecordFrame, SharedMemory } from 'foottrace/write';

const state = new SharedMemory(undefined, { count: 0 });
const log = new EventLog(state.getState());
const frame = new RecordFrame(state, log);
frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
const count = frame.read([], 'count') as number;
frame.noteRead([], 'count');
frame.write(frame.at([], 'count'), count + 1, 'set');
frame.commit(() => ({
  stage: 'Increment', stageId: 'increment', runtimeStageId: 'increment#0',
}));
frame.release();

const result = stateAt({ initialState: log.getInitialState(), commitLog: log.list() }, 0);
console.log(result.state); // { count: 1 }
```

Writers record during execution. Readers query what was recorded; they do not reconstruct missing events or infer certainty from absent evidence. A slice can be conservative or incomplete: retain its honesty codes when presenting it to a person or a model.

See the [record contract](docs/guides/record-contract.md), [time-travel contract](src/lib/time-travel/README.md), and [slice contract](src/lib/slice/README.md).

## Evidence requirements — 1.3.0

`RequirementResult` and `readRequirementResults(unknown)` on the root door carry
one producer-issued requirement result per finding/window, the claims it
`affects`, explicit unresolved `RequirementReason` codes, check/evidence/attempt
references and available action references. Domain details are namespaced IDs;
raw subjects, payloads, credentials and executable actions do not enter this
contract. The bounded reader rejects malformed or oversized batches atomically
and returns detached frozen records. It works through the root ESM and CommonJS
doors without loading the optional cause reader.

`RequirementReason` is the twelve-code domain-evidence subset of the single
`GapCode` registry. Result and check reasons refuse trace-walk codes such as
`cycle` and `node-limit`; generic cause gaps and typed admission errors retain
their broader vocabulary.

Structural admission never authenticates a producer or establishes that a
`satisfied` assertion is true. The host verifies current query, run, caller scope,
artifact provenance and domain validity before rendering each claim. An unresolved
requirement blocks only its affected conclusions; independently supported facts
can remain. Valid-time and learned-time references are separate, and missing
validity is unknown. Action references resolve through a host-owned closed
registry, with permissions checked again at execution. See the [contract and
limits](src/lib/evidence/README.md) and [reference-only example](examples/post-execution/time-travel/08-evidence-requirements.ts).

## A record that survives the run

A log can also hand every entry to a sink **as it lands**, so a run that is killed still leaves its record behind. The sink sees four entries — `opened` (the base), `commit` (each bundle, after it is frozen), `note` (anything the writer wants kept beside the log, as it happens) and `closed` (how the log ended) — and `memorySink` is the reference adapter. Write your own for a file, a bucket or a table by implementing those four methods.

```ts
import { readStoredRecord, timeTravel } from 'foottrace';
import { EventLog, RecordFrame, SharedMemory, memorySink } from 'foottrace/write';

const sink = memorySink();
const state = new SharedMemory(undefined, { count: 0 });
const log = new EventLog(state.getState(), { sink, address: { logRunId: 'run-1', drillPath: [] } });
const frame = new RecordFrame(state, log);
frame.write(frame.at([], 'count'), 1, 'set');
frame.commit(() => ({ stage: 'Increment', stageId: 'increment', runtimeStageId: 'increment#0' }));
log.note('attempt', { attempt: 1, outcome: 'timeout' });
// … the process dies here: no log.close('ok') …

const run = readStoredRecord(sink.entries).root('run-1')!;
run.complete; // false — the log never closed
run.notes; // [{ kind: 'attempt', at, data: { attempt: 1, outcome: 'timeout' } }]
timeTravel(run.source()).last(); // the cursor over what landed
```

A failing sink never stops the writer: a throw or a rejected promise is counted (`log.sinkFailures`) and reported to `sink.onFailure`. The reader treats what storage gives back as untrusted (`Iterable<unknown>`) and checks each entry: one it does not read into a log is listed in `unread` by name, and a commit sits at its own index, so a commit the store lost is a gap the fold reports by index — never a shifted log. `complete` means the writer closed the log and the reader read it all. Its work is bounded by four documented limits (`StoredRecordLimits`, raised per call). A sink adds nothing to the log's bytes; `meta` and a note's data are opaque, stored and handed back, never read. See [time travel](src/lib/time-travel/README.md#6-a-stored-record-reads-back--even-a-run-that-never-ended-110) and the [record contract](docs/guides/record-contract.md#a-stored-record).

## Attempt IDs

An attempt under a stage execution has its own ID: `charge#4@2` is attempt 2 of `charge#4`, and `charge#4@2.1@3` is attempt 3 of the first call that stage attempt made. Counts start at 1.

```ts
import { buildAttemptId, parseAttemptId } from 'foottrace';

buildAttemptId('charge#4', 2, { ordinal: 1, attempt: 3 }); // 'charge#4@2.1@3'
parseAttemptId('charge#4@2'); // { runtimeStageId: 'charge#4', attempt: 2 }
parseAttemptId('charge#4'); // undefined — a stage execution, not an attempt
```

The parser reads from the right, so a stage ID may contain `@` or `.` and no character is newly reserved. See [ids/](src/lib/ids/README.md#attempt-ids-110).

## Paths are not interchangeable

- `idPathSegments` (root entry) splits runtime IDs on `/` and drops empty segments. `isExecutionKey` detects `#`; it is not a complete validator.
- `pathSegments` and `normaliseStateKey` (`/paths`) decode/encode record paths with the existing unit-separator codec. Empty segments and literal dots are preserved.
- `nativeGet` and `nativeHas` accept dot-selector strings or literal segment arrays. Use arrays for literal dotted keys.
- `nativeHas` recognizes own properties, including an own `undefined` and dangerous-name data keys. `nativeGet` refuses dangerous segments and returns its default for `undefined`.
- `setNestedValue` and `updateNestedValue` refuse `__proto__`, `constructor`, or `prototype` anywhere in the target address before making any write. Refusal is a silent no-op, as in 9.48.1. Payload keys are data and are not filtered. Updates retain the existing shallow object merge and duplicate-preserving array concatenation; empty arrays replace. These helpers are not the record replay merge law.

## Ownership and equality

`freezeRecord` (`/write`) operates on **writer-owned** data in place and registers mutable built-in values for safe serving. It can replace a sliced buffer view. Do not pass an object whose ownership belongs to a caller. `serveRecord` (root entry) uses that registration to serve protected copies; it does not secure an arbitrary unregistered object. The entries share one freezing module within each module format.

`deepFreeze` (`/write`) is ordinary object freezing, not full immutability of Date/Map internals, and it does not descend through an already frozen object. Do not substitute it for `freezeRecord`.

`deepEqual` is the record's equality rule, not general-purpose deep equality: absent and own-undefined properties can compare equal, signed zero compares equal, array expando properties are ignored, and Map object keys use identity. The `'copies'` option treats opaque values of the same kind as equivalent. Preserve these distinctions when using it for change detection.

## Compatibility and development

Node.js 22 or newer; develop with Node.js 24 and npm 11. Both CommonJS and ESM are provided. Browser-capable source uses no Node runtime APIs. Use one module format consistently in an application; CJS and ESM have separate module instances. For a documented refusal such as `RequirementValidationError`, inspect the known operation's fixed `code` (and fixed `message` when distinguishing error kinds), rather than using `instanceof` across module formats.

```sh
npm ci
npm run check
```

No engine is installed in this package's test environment. Engine integration and the original flowchart byte fixtures are checked separately in FootPrint. Runtime dependencies remain empty. The original file history was retained with `git filter-repo`; see [extraction evidence](docs/extraction.md).

Record bytes are part of the versioning promise: refactors never re-pin; a named law fix requires a documented minor release; any other byte change requires a major. See the [fixture policy](test/fixtures/README.md).

MIT license. Contact: sanjay@footprintjs.dev.


## Cause and impact — 1.2.0

`foottrace/cause` answers bounded, read-only cause and impact queries from recorded data and control dependencies. It never reruns business code or calls a model. Findings carry evidence references, alternatives and gaps; incomplete backward evidence withholds a definite root. Confidence describes evidence coverage, not proof of a provider's internal failure.

Enable `writeProvenance: 'reads-prefix'` in the producer for precise per-write queries. Stage-level capture remains conservative, and a reader cannot restore missing provenance in old records.

The `/cause` door provides typed ESM and CommonJS exports. Use `import { explain } from 'foottrace/cause'` in ESM or `const { explain } = require('foottrace/cause')` in CommonJS. Native `import('foottrace/cause')` remains available for lazy loading.

```ts
import type { Attention } from 'foottrace';
import { attentionList, explain, type CauseGraph } from 'foottrace/cause';

// The host owns authentication, storage, graph identities and attention rules.
// Each method receives a cancellation signal and may load only the requested node.
declare const graph: CauseGraph;
declare const selectedNodeId: string;
const marked = await attentionList(graph, {
  nodeIds: [selectedNodeId], maxNodes: 50, maxCalls: 100, timeoutMs: 500,
});
const finding = await explain(graph, selectedNodeId, {
  maxNodes: 50, maxDepth: 10, maxEdges: 100, maxCalls: 200, timeoutMs: 500,
});
// Display finding.attention, rootCause or alternatives, path, impact and gaps.
// An LLM can phrase these validated findings without inventing a cause.
```

Follow the [cause and impact manual](https://github.com/footprintjs/foottrace/blob/main/docs/cause.md) to record per-write provenance, adapt an authorized stored record, run bounded queries and interpret roots, alternatives and gaps. A complete synthetic [record example](https://github.com/footprintjs/foottrace/blob/main/examples/cause-record.ts) demonstrates both in-memory and stored adapters.


## Optional native root-read sources

`foottrace/write` provides an opt-in, value-free source descriptor for the same native scalar root read. Existing reads and record bytes stay unchanged. Authorized hosts can also supply the optional root source-evidence seam to cause and PROV readers. Exact reads establish source-to-execution usage; per-write and semantic derivation remain separate. See the [setup, bounds and limitations](https://github.com/footprintjs/foottrace/blob/main/docs/read-sources.md).
