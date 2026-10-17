# foottrace

Execution records and the tools to read them: replay, time travel, slices, and evidence about where values came from. No flowchart engine, AI provider, or runtime dependency is required.

This package extracts FootPrint's established record layer. It does not introduce a second writer or a different replay law. The first release preserves the frozen record fixtures from footprintjs 9.48.1 and includes the coordinated 9.48.2 copy-safety correction: an own `__proto__` payload field stays data, never the copy's prototype. See the [changelog](CHANGELOG.md) for the limited rich-value behavior change.

Foottrace owns the record layer used by footprintjs 10. Older stored records remain readable without installing their original engine.

## Four entry points

| Import | Responsibility |
| --- | --- |
| `foottrace` | Record types, runtime and attempt IDs, replay, time-travel cursors, causal and variable slices, honesty codes, the stored-record reader |
| `foottrace/write` | `SharedMemory`, `EventLog`, `RecordFrame`, encoding and write types, writer-owned freezing, the record sink port and `memorySink` |
| `foottrace/paths` | Record-path encoding/decoding, nested access and safe diagnostic writes |
| `foottrace/cause` (ESM) | Optional bounded attention, cause and impact queries; in-memory and lazily loaded stored-record adapters |

Every declaration has one public entry point. Producer-facing `Attention` and `AttentionKind` are type-only root exports; the cause algorithms live only on `/cause`. Existing root, `/write` and `/paths` imports retain their ESM and CommonJS doors. There are no public deep imports or `/testing` entry point. FootPrint's engine, observer channels, recorders and stores remain in `footprintjs`.

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

Node.js 22 or newer; develop with Node.js 24 and npm 11. Both CommonJS and ESM are provided. Browser-capable source uses no Node runtime APIs. Use one module format consistently in an application; CJS and ESM have separate module instances.

```sh
npm ci
npm run check
```

No engine is installed in this package's test environment. Engine integration and the original flowchart byte fixtures are checked separately in FootPrint. Runtime dependencies remain empty. The original file history was retained with `git filter-repo`; see [extraction evidence](docs/extraction.md).

Record bytes are part of the versioning promise: refactors never re-pin; a named law fix requires a documented minor release; any other byte change requires a major. See the [fixture policy](test/fixtures/README.md).

MIT license. Contact: sanjay@footprintjs.dev.


## Cause and impact — 1.2.0 candidate

`foottrace/cause` reads recorded dependencies; it never reruns business code, calls a model, or accesses storage by itself. An application supplies a graph or a stored-record host. `explain(graph, nodeId)` walks the selected node's recorded data and control dependencies, identifies the earliest marked ancestors in that dependency order, and walks forward to report impact. Independent candidates remain `alternatives`; timestamps and ID order never break a causal tie. A missing or cut backward dependency withholds `rootCause`; missing evidence in either direction returns `confidence: 'incomplete'` with fixed gap codes. Confidence describes evidence coverage, not proof of a provider's internal failure.

**For precise per-write cause queries, enable `writeProvenance: 'reads-prefix'` when recording the flow.** Step-level data edges can add false ancestors; the record adapter marks that fallback `conservative`, so those queries return incomplete evidence and alternatives rather than a definite root. This setting cannot restore provenance in old records and does not guarantee a root: complete recorded read/control and attention coverage, one supported candidate and no backward gaps are still required. Other graph adapters can provide their own precise dependency evidence.

**Module compatibility:** `/cause` has an `import` export condition only. CommonJS consumers must use native `import('foottrace/cause')`; `require('foottrace/cause')` is not exported, even on Node versions that support requiring ESM. Preserve native `import()` in the compiled CommonJS loader: compilers that rewrite it to `require()` need a dedicated import-preserving bridge. Existing root, `/write` and `/paths` CommonJS imports remain supported.

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

Attention marks contain a fixed reason code and evidence references, never a raw error or state value. Every mark needs a proof reference except `not-collected`, which records absence. The application decides which business conditions deserve a mark. `error`, `unknown-effect`, `gave-up`, `timeout`, `retried`, `quality-drop`, `not-collected` and `outlier` are standard kinds; future bounded kind names remain readable. An absent mark does not prove a node was healthy. `largestDrop(scores)` and `mostAffected(scores)` return optional root strategies over host-supplied, already recorded numeric scores; equal best scores remain tied and missing scores become gaps. The default uses the earliest marked ancestor, with no scoring model. An optional `rankImpact(nodes, context)` may reorder the discovered descendants, but cannot add, omit or duplicate references; failed ranking preserves the unranked references and reports a gap.

The default earliest-ancestor rule does not restrict a custom `rankRoots`: that callback receives all supported marked nodes in the backward walk, including a marked selected node, and may select a subset containing a nearer ancestor. It cannot introduce foreign or duplicate identities. This differs from `rankImpact`, which must return an exact permutation of every discovered descendant. Name the chosen root strategy when presenting its findings; a custom choice is not the default earliest-ancestor conclusion.

Query defaults are 100 nodes, depth 20, 1,000 edges, 1,000 calls and one second. Hard ceilings are 10,000 nodes, depth 1,000, 100,000 edges/calls and 30 seconds. The same budget covers both directions and ranking. Callbacks are trusted executable code: asynchronous waiting is bounded and receives an abort signal, while synchronous callbacks must cooperate. A late synchronous result is rejected after it returns. Hosts must use non-secret node and evidence IDs; the reader does not classify arbitrary ID strings for personal information.

Async hosts must return ordinary current-realm native Promises with no own `constructor`; promise wrappers are trusted host control objects, while their resolved data is untrusted. Custom thenables, subclasses and constructor/species overrides are outside this contract and the host must handle their rejections itself. The reader never mutates a promise to observe it. Ordinary native rejections are consumed and become fixed gaps; synchronous data objects' `then` accessors are never invoked.

### Per-write provenance recipe

For precise edges between individual writes, configure the producer's record encoding with `writeProvenance: 'reads-prefix'`. `RecordFrame` captures the reads that preceded each write. For an execution that reads `a`, writes `x`, then reads `b` and writes `y`, the `x` query uses its recorded read prefix; the `y` query uses the later prefix. Without per-write provenance, the reader must conservatively consider all reads of that stage for either value and report that fallback. Later reads cannot be retroactively assigned to an earlier write. An overwritten version is distinct from the newer value, so impact follows the selected write rather than every later use of the same key name.

```ts
import { EventLog, RecordFrame, SharedMemory } from 'foottrace/write';
const state = new SharedMemory(undefined, { a: 1, b: 2 });
const log = new EventLog(state.getState());
const frame = new RecordFrame(state, log);
frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
frame.noteRead([], 'a');
frame.write(frame.at([], 'x'), 1, 'set');
frame.noteRead([], 'b');
frame.write(frame.at([], 'y'), 3, 'set');
frame.commit(() => ({ stage: 'Derive', stageId: 'derive', runtimeStageId: 'derive#0' }));
frame.release();
```

A stored host can expose one authorized log at a time:

```ts
import { createStoredRecordGraph, explain, type StoredRecordHost } from 'foottrace/cause';

// loadLog(address, { signal }) returns native entries for exactly that address,
// plus recorded read/control/attention maps when available. It checks access.
declare const host: StoredRecordHost;
const graph = createStoredRecordGraph(host, {
  maxScopes: 8, maxCommits: 256, maxFields: 20_000, maxEdges: 64, loadTimeoutMs: 500,
});
const address = { logRunId: 'run-1', drillPath: [] };
const selected = graph.nodeId(address, { runtimeStageId: 'derive#0', commitIdx: 0, key: 'y' });
const finding = await explain(graph, selected, { timeoutMs: 750, maxNodes: 50 });
// Only the requested scope is loaded; a different subflow is opened on demand.
```

The stored adapter loads a requested log through the host, reuses `readStoredRecord`, and retains incomplete-record and gap evidence. A graph instance caches admitted scope snapshots; create a new instance to refresh a record that is still being written. Bind each host/graph/cache to one authorization domain or authorize before every query: a cache hit does not call `loadLog` again. Never share a global graph whose loader consults a changing request identity. Subflow containment is a navigation relationship, not automatically a causal dependency. Scope, execution, write position and optional key qualify node identities. The host must authorize each storage scope; cross-service and cross-run causal stitching remain outside this candidate. Lazy loading is real only when the host loader fetches a requested scope: expanding a cursor over an already loaded snapshot is an in-memory drill.

### Established algorithms

Foundations: [Weiser, *Program slicing* (1981)](https://dl.acm.org/doi/10.5555/800078.802557), [Korel and Laski, *Dynamic program slicing* (1988)](https://doi.org/10.1016/0020-0190(88)90054-3), [Agrawal and Horgan, *Dynamic program slicing* (1990)](https://doi.org/10.1145/93542.93576), [Ferrante, Ottenstein and Warren, *The program dependence graph and its use in optimization* (1987)](https://doi.org/10.1145/24039.24041), and [Buneman, Khanna and Tan, *Why and Where: A Characterization of Data Provenance* (2001)](https://www.pure.ed.ac.uk/ws/files/16509989/Why_and_Where_A_Characterization_of_Data_Provenance.pdf). These are the historical techniques; this reader applies them only to dependencies present in a recording.

| Query | Established name |
| --- | --- |
| Recorded ancestors influencing a value or node | **Backward dynamic program slicing** (Weiser, 1981; Korel and Laski, 1988; Agrawal and Horgan, 1990) |
| Recorded data plus decision/control edges | **Program dependence graph** (Ferrante, Ottenstein and Warren, 1987) |
| Recorded downstream effects | **Forward slicing**, or change-impact analysis |
| Why a value exists and where it came from | **Why- and where-provenance** (Buneman, Khanna and Tan, 2001) |
| Loading only queried graph nodes/scopes | **Demand-driven, or lazy, graph traversal** |
| Default candidate selection | **Root-cause localisation on a dependency DAG**, using the earliest anomalous ancestor |

These names describe the techniques, not a claim of complete language-level instrumentation. Findings are bounded by the dependencies the producer recorded. Cause queries share one deadline and node/edge/call budget across reverse traversal, ranking and forward impact; limits, cancellation and unavailable reads become gaps. Output carries references and fixed codes, never a serialized DAG or business payload. `/cause` is ESM-only and `sideEffects: false`; its unused-import browser bundle is tested to match a bundle without the import. The package has no runtime dependencies. This is an unpublished candidate; later engine stamping, viewer integration and agent tools are separate changes.

Direct `graph.openScope(address, { signal })` discovery rejects with a fixed `cause: record unavailable` error and a gap `code` on failure; an unavailable scope is never reported as an empty successful log. Public `explain` and `attentionList` queries turn unavailable reads into bounded incomplete findings.

Record-adapter coverage is conservative: its shared scope gaps can withhold a cause when a local forward edge cap is reached, even if the visible backward path is covered. A withheld cause is unknown under those bounds; it is not proof that no cause exists.

Package verification retains strict automatic entrypoint discovery for every door except `/cause`, then checks only `/cause` with Are the Types Wrong’s `esm-only` profile. No resolution error is ignored globally; the regression test fixes that exception to this one ESM-only subpath.
