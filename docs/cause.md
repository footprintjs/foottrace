# Cause and impact

`foottrace/cause` reads recorded dependencies; it never reruns business code, calls a model, or accesses storage by itself. An application supplies a graph or a stored-record host. `explain(graph, nodeId)` walks the selected node's recorded data and control dependencies, identifies the earliest marked ancestors in that dependency order, and walks forward to report impact. Independent candidates remain `alternatives`; timestamps and ID order never break a causal tie. A missing or cut backward dependency withholds `rootCause`; missing evidence in either direction returns `confidence: 'incomplete'` with fixed gap codes. Confidence describes evidence coverage, not proof of a provider's internal failure.

## Module compatibility

**Module compatibility:** `/cause` provides typed `import` and `require` export conditions, matching the existing root, `/write` and `/paths` doors. ESM consumers can use `import { explain } from 'foottrace/cause'`; CommonJS consumers can use `const { explain } = require('foottrace/cause')`. Native `import('foottrace/cause')` remains available for lazy loading from either format. Use one module format consistently in an application: CommonJS and ESM have separate module instances and do not share module-local state.

For a documented refusal such as `RequirementValidationError`, inspect the known operation's fixed `code` (and fixed `message` when distinguishing error kinds), rather than using `instanceof` across module formats. The root record types and `/cause` graph ports do not require shared Foottrace class identity; their structural admission rules still apply. Query memoization remains local to each module copy. The writer's `freezeRecord` and root `serveRecord` pair must still use the same package and module format to share their private registration, as described in the [record contract](guides/record-contract.md#public-helpers-and-their-contracts).

## 1. Record per-write provenance

**For precise per-write cause queries, enable `writeProvenance: 'reads-prefix'` when recording the flow.** Step-level data edges can add false ancestors; the record adapter marks that fallback `conservative`, so those queries return incomplete evidence and alternatives rather than a definite root. This setting cannot restore provenance in old records and does not guarantee a root: complete recorded read/control and attention coverage, one supported candidate and no backward gaps are still required. Other graph adapters can provide their own precise dependency evidence.

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

## Optional exact root-read sources

An authorized host can supply `RecordScope.readSources` and the same scope's `initialState`. Exact committed observations use `recorded-read` source-to-execution edges, and forward impact reaches that consuming execution. Key-qualified output links remain conservative because the source channel does not join each occurrence to a write. Base observations are known pre-run termini. Missing, staged, child/resume and unsupported evidence retains gaps. See the [shared source contract](read-sources.md#consume-an-authorized-root-observation) for authorization, bounds and PROV meaning.

## 2. Adapt an authorized stored record

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

Direct `graph.openScope(address, { signal })` discovery rejects with a fixed `cause: record unavailable` error and a gap `code` on failure; an unavailable scope is never reported as an empty successful log. Public `explain` and `attentionList` queries turn unavailable reads into bounded incomplete findings.

## 3. Explain a selected node within bounds

The following standalone query accepts a host-supplied graph. The stored adapter from step 2 is one such graph; the declarations identify the host-owned graph and selected node.

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

Query defaults are 100 nodes, depth 20, 1,000 edges, 1,000 calls and one second. Hard ceilings are 10,000 nodes, depth 1,000, 100,000 edges/calls and 30 seconds. The same budget covers both directions and ranking. Callbacks are trusted executable code: asynchronous waiting is bounded and receives an abort signal, while synchronous callbacks must cooperate. A late synchronous result is rejected after it returns. Hosts must use non-secret node and evidence IDs; the reader does not classify arbitrary ID strings for personal information.

### Leave work capacity for impact

For a query with many ancestors and a small downstream graph, setting only `backward` is usually enough. Impact then uses whatever remains of the total budget:

```ts
import { explain, type CauseGraph } from 'foottrace/cause';
declare const graph: CauseGraph;
const finding = await explain(graph, 'selected', {
  maxNodes: 100, maxEdges: 1000, maxCalls: 1000,
  backward: { maxNodes: 70, maxEdges: 700, maxCalls: 700 },
});
```

`backward` covers the reverse walk and root ranking; `impact` covers the forward walk and impact ranking. Each accepts `maxNodes`, `maxDepth`, `maxEdges` and `maxCalls`. Every provided value must be an integer within the corresponding enclosing query limit (depth may be zero; other values start at one). Omitted fields inherit the enclosing limit. Omit both objects to retain the existing shared-budget behavior.

Add `impact` only when you also want to cap forward work. The two allowances do not have to add up to the total: the shared ceiling always applies.

There is still one total ceiling, deadline, cancellation signal and query cache. A node counts once globally and once in each direction that visits it. Every traversed edge and every dispatched graph or ranking call consumes both the total and the allowance carried by that operation. Reusing a cached graph result consumes no new call. A refused local node, edge or call does not consume its matching total allowance, and its refusal is not cached as evidence for the other direction. An edge already examined still counts when its destination node cannot be admitted. Graph-response admission remains bounded by the total edge limit.

Exhausting the backward allowance adds a named gap and withholds a confirmed root while leaving the remaining total capacity available for impact. An incomplete impact does not erase a root established from complete backward evidence. These allowances reserve work capacity, not time: an unresolved backward call can still consume the one shared deadline. They do not paginate stored records or measure provider billing.

Async hosts must return ordinary current-realm native Promises with no own `constructor`; promise wrappers are trusted host control objects, while their resolved data is untrusted. Custom thenables, subclasses and constructor/species overrides are outside this contract and the host must handle their rejections itself. The reader never mutates a promise to observe it. Ordinary native rejections are consumed and become fixed gaps; synchronous data objects' `then` accessors are never invoked.

## 4. Interpret roots, alternatives, impact and gaps

Attention marks contain a fixed reason code and evidence references, never a raw error or state value. Every mark needs a proof reference except `not-collected`, which records absence. The application decides which business conditions deserve a mark. `error`, `unknown-effect`, `gave-up`, `timeout`, `retried`, `quality-drop`, `not-collected` and `outlier` are standard kinds; future bounded kind names remain readable. An absent mark does not prove a node was healthy. `largestDrop(scores)` and `mostAffected(scores)` return optional root strategies over host-supplied, already recorded numeric scores; equal best scores remain tied and missing scores become gaps. The default uses the earliest marked ancestor, with no scoring model. An optional `rankImpact(nodes, context)` may reorder the discovered descendants, but cannot add, omit or duplicate references; failed ranking preserves the unranked references and reports a gap.

The default earliest-ancestor rule does not restrict a custom `rankRoots`: that callback receives all supported marked nodes in the backward walk, including a marked selected node, and may select a subset containing a nearer ancestor. It cannot introduce foreign or duplicate identities. This differs from `rankImpact`, which must return an exact permutation of every discovered descendant. Name the chosen root strategy when presenting its findings; a custom choice is not the default earliest-ancestor conclusion.

Record-adapter coverage is conservative: its shared scope gaps can withhold a cause when a local forward edge cap is reached, even if the visible backward path is covered. A withheld cause is unknown under those bounds; it is not proof that no cause exists.

## Established algorithms and package guarantees

Foundations: [Weiser, *Program slicing* (1981)](https://dl.acm.org/doi/10.5555/800078.802557), [Korel and Laski, *Dynamic program slicing* (1988)](https://doi.org/10.1016/0020-0190(88)90054-3), [Agrawal and Horgan, *Dynamic program slicing* (1990)](https://doi.org/10.1145/93542.93576), [Ferrante, Ottenstein and Warren, *The program dependence graph and its use in optimization* (1987)](https://doi.org/10.1145/24039.24041), and [Buneman, Khanna and Tan, *Why and Where: A Characterization of Data Provenance* (2001)](https://www.pure.ed.ac.uk/ws/files/16509989/Why_and_Where_A_Characterization_of_Data_Provenance.pdf). These are the historical techniques; this reader applies them only to dependencies present in a recording.

| Query | Established name |
| --- | --- |
| Recorded ancestors influencing a value or node | **Backward dynamic program slicing** (Weiser, 1981; Korel and Laski, 1988; Agrawal and Horgan, 1990) |
| Recorded data plus decision/control edges | **Program dependence graph** (Ferrante, Ottenstein and Warren, 1987) |
| Recorded downstream effects | **Forward slicing**, or change-impact analysis |
| Why a value exists and where it came from | **Why- and where-provenance** (Buneman, Khanna and Tan, 2001) |
| Loading only queried graph nodes/scopes | **Demand-driven, or lazy, graph traversal** |
| Default candidate selection | **Root-cause localisation on a dependency DAG**, using the earliest anomalous ancestor |

These names describe the techniques, not a claim of complete language-level instrumentation. Findings are bounded by the dependencies the producer recorded. Cause queries share one deadline and node/edge/call budget across reverse traversal, ranking and forward impact; limits, cancellation and unavailable reads become gaps. Output carries references and fixed codes, never a serialized DAG or business payload. `/cause` supports ESM and CommonJS and remains `sideEffects: false`; its unused ESM import is tested to produce the same browser bundle as no import. The package has no runtime dependencies. The cause reader shipped in 1.2.0; later engine stamping, viewer integration and agent tools are separate changes.

Package verification uses strict automatic entrypoint discovery for every door with Are the Types Wrong’s `strict` profile. No entrypoint is excluded and no resolution error is ignored.

The complete synthetic [record example](../examples/cause-record.ts) demonstrates both in-memory and stored adapters. The [record contract](guides/record-contract.md) describes the producer and writer laws.
