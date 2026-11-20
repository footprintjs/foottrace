# Cause and impact

`foottrace/cause` reads recorded dependencies; it never reruns business code, calls a model, or accesses storage by itself. An application supplies a graph or a stored-record host. `explain(graph, nodeId)` walks the selected node's recorded data and control dependencies, identifies the earliest marked ancestors in that dependency order, and walks forward to report impact. Independent candidates remain `alternatives`; timestamps and ID order never break a causal tie. A missing or cut backward dependency withholds `rootCause`; missing evidence in either direction returns `confidence: 'incomplete'` with fixed gap codes. Confidence describes evidence coverage, not proof of a provider's internal failure.

## Module compatibility

**Module compatibility:** `/cause` provides typed `import` and `require` export conditions, matching the existing root, `/write` and `/paths` doors. ESM consumers can use `import { explain } from 'foottrace/cause'`; CommonJS consumers can use `const { explain } = require('foottrace/cause')`. Native `import('foottrace/cause')` remains available for lazy loading from either format. Use one module format consistently in an application: CommonJS and ESM have separate module instances and do not share module-local state.

For a documented refusal such as `RequirementValidationError`, inspect the known operation's fixed `code` (and fixed `message` when distinguishing error kinds), rather than using `instanceof` across module formats. The root record types and `/cause` graph ports do not require shared Foottrace class identity; their structural admission rules still apply. Query memoization remains local to each module copy. The writer's `freezeRecord` and root `serveRecord` pair must still use the same package and module format to share their private registration, as described in the [record contract](guides/record-contract.md#public-helpers-and-their-contracts).

## 1. Record per-write provenance

**For precise per-write cause queries, enable `writeProvenance: 'reads-prefix'` when recording the flow.** Step-level data edges can add false ancestors; the record adapter marks that fallback `conservative`, so those queries return incomplete evidence and alternatives rather than a definite root. The same mark is used for steps that ran side by side: a step is asked what it could have read from where it looked at state (`CommitBundle.beganAt` / `sawUntil`), not from where it committed, and only when it read live state again after a sibling committed the key does it get more than one parent for that key, with `conservative`. This setting cannot restore provenance in old records and does not guarantee a root: complete recorded read/control and attention coverage, one supported candidate and no backward gaps are still required. Other graph adapters can provide their own precise dependency evidence.

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

## A value built in steps

A node is one commit's write of one key. When that write did not replace the key's value (a `merge`, an `append`, a row on a path inside the key), the value it left is made of that write and of what the write before it had left. No read is behind that dependence, so it has its own kind of edge: `attribution: 'recorded-write'`, from the node to the write just before it, read off the record's rows and commit order. It is exact. The link is by commit: when a step committed twice, its later commit's node has its earlier commit's node as parent.

```ts
// Start sets `box`. Fill merges into `box` without reading it. Use reads `box` and writes `final`.
await graph.parents(node('use', 'final')); // [ fill·box   attribution: 'per-write' ]
await graph.parents(node('fill', 'box'));  // [ start·box  attribution: 'recorded-write' ]
// A failure marked on Start is now the root cause explain() finds for `final`.
// Before this edge the walk ended at Fill, and Start was never reached.
```

Forward, a write's children include the next write of the key, when that one was folded onto it. Without exact read sources they also include every reader of the value for as long as nothing replaced it. With exact sources they include the readers whose recorded source is this commit, and a later reader is reached through the write that was folded onto this one. For these `'recorded-write'` edges the two directions are exact inverses: a child names the node among its parents, and a parent names it among its children. A test checks that, and that the way back from every child and the way forward from every parent reach the node, on every log of up to four commits with no row on a path inside a key. One exception is older than this edge and outside that test: the node of a path INSIDE a key lists the readers of the whole key among its children, and the way back from such a reader names the node of the whole key at that commit, not the node of the path.

A node is named once among a node's parents. When a read already names the write underneath: a certain read keeps its edge as it is (a step that read a key and then added to it is answered as before), and a read that is only a possible source gives its place to the `'recorded-write'` edge, which is certain. The node keeps the `conservative` gap that read brought.

### A `set` row the writer built on the view

The record's writer sometimes stores a `set` of a whole value where the step only added, and marks that row `builtOnView` (the [record contract](guides/record-contract.md) says when, and what a producer owes). In the fold the row replaces the value. It still holds what the step's view held, so the node has the write that view held as its parent, with the same `'recorded-write'` attribution:

```ts
// commitValues: 'delta'. Start sets `box`. Fill merges into `box` and sets `box.in`, reading nothing.
// The record holds ONE `set` of `box` for Fill, marked. Use reads `box` and writes `final`.
await graph.parents(node('fill', 'box'));   // [ start·box  attribution: 'recorded-write' ]
await graph.children(node('start', 'box')); // [ fill·box   attribution: 'recorded-write' ]
// Without the mark the row read as a replacement: Fill had no parent, and Start was never reached.
```

The parent is the last write of the key before the moment the view was pinned, and the commit says that moment (`viewAt`). WHY not the write just before the commit, as for a fold: the view was pinned before the commit. A write a sibling committed in between is not under the row; the row replaced it. WHY a stamp of its own and not the step's read stamps: a view is not a read by the step's code, and a step that ran beside others can have pinned its view and read state at different moments. The parent is certain. A step that also read the key keeps the read's edge, as above; where that read is only a possible source, the certain edge takes its place.

One case gives several parents: a record handed over in memory in which bundles around the commit say no index, so that it does not show where the view sits. Each write the view could have held is then a parent, and the node says `conservative`. A stored record says every bundle's index, so this cannot happen there.

The two directions are inverses for these edges too, checked on logs the real writer made under both encodings (`test/cause/built-on.property.test.ts`). A record from outside can carry a marked row on every commit and leave the place of every view open over a long stretch of the log. So one question about a node that names a key (its parents, or its children) is answered in work that grows with the log, not with its square, and stops at the cap on edges (`test/cause/built-on-view.test.ts` counts it). A node that names no key is asked once for each key its commit wrote, as it was before this edge.

A write folded onto the value from before the run has no node to point at and adds no gap of its own. Without exact read sources the node carries `conservative`, as it always has for a value with no whole write in range; that gap does not consult the record's initial state, so it is also there when the key did not exist before the run. With exact sources the pre-run state is a known end of the walk. A graph of your own may return `'recorded-write'` on a data edge; a control edge with it is refused, like any other mismatch.

A `set` row built on a view that held no write of the key has no node to point at either, and here a gap IS added: `untracked-input` (the node took in something the record cannot trace to a write). WHY this one differs: a marked `set` of the key is a whole write of it, so nothing else on the node says that part of it came from before the run. Without the gap the node read as complete with no parent, and `explain` confirmed its step as the root of a value the step only passed on. It is the gap a step that read the key from before the run and then set it has always had; here the writer took that input for the step. Like the gap above it does not consult the record's initial state, so it is also there when the key did not exist before the run. With exact sources it is not added: the pre-run state is a known end of the walk there.

```ts
// commitValues: 'delta', and `box` came with the initial state. Fill merges into `box` and sets `box.in`:
// ONE `set` of `box`, marked, built on a view that held no write of `box`. Use reads `box`.
await graph.parents(node('fill', 'box')); // []
await graph.gaps(node('fill', 'box'));    // [ untracked-input ]
// explain(final): confidence 'incomplete', Fill among the alternatives. Before: 'complete', root Fill.
```

## Optional exact root-read sources

An authorized host can supply `RecordScope.readSources` and the same scope's `initialState`. Exact committed observations use `recorded-read` source-to-execution edges, and forward impact reaches that consuming execution. Key-qualified output links remain conservative because the source channel does not join each occurrence to a write. Base observations are known pre-run termini. Missing, staged, child/resume and unsupported evidence retains gaps. See the [shared source contract](read-sources.md#consume-an-authorized-root-observation) for authorization, bounds and PROV meaning.

## Optional source links

A producer can attach `sourceLinks` version 1 to an in-memory scope or a stored scope. The channel reports what a recorded check cites for an exact output, with its own `witnessed` or `declared` standing. A witnessed link binds the check to a committed row and the consumer's admitted view. It makes no claim about whether the model used the cited value or whether the value is correct.

The host supplies `sourceLinkPolicy` to either record adapter. It grants the complete output, witness, served write and input-view locators before replay and again before a link is returned. A locator on the served key grants the entire first-commit write. A witnessed input stays valid while its selected path is unwritten. A write at or inside that path invalidates it. An ancestor write invalidates it when the selected value changes. This gives a tail append the same answer in full and delta logs. A recorded array union through the witness commit can shift which value occupies a position. An input or output beneath that union yields an `ambiguous` gap. A witness beneath it leaves the link `declared`. The replay allowance counts rows and value shape, including fields and array slots. When it runs out, the channel reports `truncated` without naming a key or exposing a count. A host that needs to hide a key’s shape can refuse all source-link locators under it. To show an origin, the policy also grants the exact origin write. With no policy the channel reports `not-permitted`. A granted view without a disclosed origin can still produce a link with the fixed `unavailable` reason.

Read `sourceLinks` and `sourceLinkGaps` on the graph page or explanation. They are supplemental evidence with their own budget and do not affect root ranking, traversal or completeness. A truncated channel keeps the recorded graph available. The base and commit log are copied together at scope admission so a cached graph reads one snapshot.

The [synthetic example](../examples/source-links.ts) creates a record, grants specific locators and reads a witnessed link. Producer-side tools can use `readSourceLinkRow` and `readServedRow` from `foottrace/cause` to check the same row contract before delivery. Call `bindSourceLinkWrites` once per scope when binding several rows:

```ts
import { bindSourceLinkWrites, type RecordScope, type SourceLinkRowLocation } from 'foottrace/cause';

declare const scope: RecordScope;
declare const locators: readonly SourceLinkRowLocation[];
const { writes, complete } = bindSourceLinkWrites(scope, locators);
// writes[i] binds locators[i]. Unfilled slots on an incomplete result are unknown.
```

The batch admits the scope once and shares its replay across at most 256 locators. It preserves their order. If its allowance runs out, it retains the bindings already resolved and reports `complete: false`. A producer with a recorded channel keeps those bindings and reports the `budget-exhausted` limitation. The original `bindSourceLinkWrite` remains the single-locator form.

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

The stored adapter loads a requested log through the host, reuses `readStoredRecord`, and retains incomplete-record and gap evidence. A file that holds its own [run evidence](../src/lib/run-evidence/README.md) fills `reads`, `controlDeps` and `attention` where the host omits them; a host's map always wins. Without admitted subflow observations this remains a local-log graph; a known mounted seed reports its missing input crossing as `scope-boundary`. With the optional port below, only exact referenced scopes are loaded through the same authorized host. A graph instance caches admitted scope snapshots; create a new instance to refresh a record that is still being written. Bind each host/graph/cache to one authorization domain or authorize before every query: a cache hit does not call `loadLog` again. Never share a global graph whose loader consults a changing request identity. Subflow containment is a navigation relationship, not automatically a causal dependency. Scope, execution, write position and optional key qualify node identities. The host must authorize each storage scope; cross-service and cross-run causal stitching remain outside this candidate. Lazy loading is real only when the host loader fetches a requested scope: expanding a cursor over an already loaded snapshot is an in-memory drill.

Direct `graph.openScope(address, { signal })` discovery rejects with a fixed `cause: record unavailable` error and a gap `code` on failure; an unavailable scope is never reported as an empty successful log. Public `explain` and `attentionList` queries turn unavailable reads into bounded incomplete findings.

When a scope fails to load, `graph.parents` and `graph.children` each return an incomplete page with one fixed gap. `node-limit` means the record exceeds the reader's limits. `invalid-data` means the data could not be admitted as plain data. An unavailable host or record, a timeout, and cancellation use `unavailable`, `timeout`, and `cancelled` respectively. The gap contains no record content. `explain` reports the specific reason once in each affected direction and omits the generic `not-collected` gap for that failure.

A long tool result or message can be admitted as an immutable string. `maxFields` still limits the number of fields, and the reader continues to require plain data. The same configured number independently caps the UTF-16 units charged for equal-length text comparisons of the selected value. A large unselected string does not use that comparison allowance. When that work runs out, the affected page reports `truncated`. Reading a record can still take at least one pass over its text. On Node's V8 engine, native set union reuses the string hash when one is already present, and may compare independently created equal strings. The union is part of replay and keeps its recorded semantics.

## Optional native subflow observations

`RecordScope.subflows` (and the stored host's same field) supplies a value-free
`RecordSubflows` record: `{version: 1, status, mounts, collections}`. Each mount
names its actual runtime execution ID and complete child `LogAddress`, with
optional input/output handoffs. Collections belong once to their enclosing
parent scope. The exported readonly types describe the closed fields and
limitation codes; unknown versions, fields, aliases and inconsistent identities
retain a fixed gap alongside safe local evidence.

An output-v1 handoff identifies the actual parent mapping commit/path and the
closed child snapshot's exclusive cutoff. An input handoff identifies the actual
child seed commit/path and the parent's saved exclusive cutoff. The reader uses
that prefix, so a later overwrite cannot replace the recorded source. Literal
root names such as `a.b` remain literal; they are not split into nested paths.

A native snapshot adapter supplies unique, immediate-child runtime-ID entries,
not static aliases or the latest convenient visit. Its inventory status must
always be `partial`: pauses, early exits, capture-only recording, new/resumed
runs and checkpoints can omit results. Native twins and result counts do not
certify all invocations. An explicit host-owned `captured` inventory asserts only
its supplied scope; neither status creates a storage or authenticity receipt.

For an authorized native adapter, copy each actual input/output observation
without changing its addresses, landed indexes, paths, limitations or status.
Copy the enclosing snapshot's `fanoutCollections.collections` once into
`subflows.collections` (or an empty list if absent), keeping inventory `partial`.
Each participating native scope supplies its explicit port, including a partial
empty inventory for a source scope with no retained outgoing metadata. A plain
legacy scope remains local: its drill address alone does not opt it into parent
discovery or wider impact. An output join into an undeclared source scope keeps
a boundary gap; no query-order-dependent registry supplies missing opt-in.
The host remains responsible for authorization and loading every referenced
child/parent log. Ordinary stored entries do not implicitly contain this
separate snapshot metadata.

Recorded prefixes describe observed accesses, not proof that an output used a
value. Their graph links use `stage` attribution and a `conservative` gap,
including an empty capture. Missing, resumed, private or otherwise unsupported
seed sources retain boundary gaps. Independent later constants and standalone
root baselines retain their local meaning. A `complete` result describes its
admitted evidence scope, never provider-internal or whole-run causal proof.

Whole-scope fan-out observations remain nontraversable. The record preserves
actual ITEMS-order slot identities and the committed parent array write; it
does not invent per-key reads or infer `items[index]` derivation. Unknown child
identities omit the whole slot with partial/missing-child-record coverage. Zero
branches retain the existing local read evidence.

Field/scope/edge and source-resolution work caps remain enforced. Partial
inventories, unavailable scopes and forward-only limits make impact incomplete
without disqualifying independently supported backward evidence. Refresh by
creating a new graph instance; retain the existing authorization/cache boundary.

## Ask what a live log collected

A scope passed to `createRecordGraph` may carry a native `capture` note and a
separate `captureWitness`. Take the witness from the record itself. Supply the
served record's full log address (`logRunId` and `drillPath`), producing leg ID,
native half-open commit interval, actual boundary status and `source: 'live'`.
The witness address must match the scope and the note. Its interval must agree
with the admitted commit indices. A resumed leg witnesses only its own segment
and a parent witnesses only its own log. Copying these fields from the note
would give it its own authority.

```ts
const captureWitness = {
  logAddress: servedAddress,
  runId: producingLeg,
  commits: { from: segmentStart, to: segmentEnd },
  boundary: boundaryStatus,
  source: 'live',
} satisfies CaptureWitness;
const graph = createRecordGraph([{ ...scope, captureWitness }]);
const answer = await graph.captureCoverage(
  servedAddress,
  { channel: 'reads', mode: 'full', from: 0, to: 12 },
  { signal: controller.signal },
);
```

`covered` means a local, completed interval collected the requested channel
with enough detail. Check the actual observations before saying there was no
matching read. A disabled channel returns `not-collected`. `partial` and
`failed` carry fixed reasons. Missing, unbound, malformed and unknown newer
notes return `collection-unknown`. Pass `crossing: 'worker'` or
`crossing: 'transport'` to retain that gap. Saved scopes stay unknown in this
API. An optional note never suppresses an observed writer or creates a link.
A legacy note with contradictory read or write tracking and channel status is
malformed, so the entire note is refused.

The root package's `findReadSources` also reports an `absenceReason` when
there is no visible writer for a valid read. `redacted` means a redaction at or
above the queried key could hide a writer within the read's bound.
`never-written` describes writes in the supplied log through that bound.
The result always carries a separate `initialStatePresence` of `present`,
`absent`, or `unknown` based on the optional plain `initialState` record.

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

### Return backward evidence for a viewer

Set the optional boolean `includeBackward: true` to return the reverse walk that `explain` already performed:

```ts
const finding = await explain(graph, selectedNodeId, {
  includeBackward: true,
  maxNodes: 50, maxDepth: 10, maxEdges: 100, maxCalls: 200, timeoutMs: 500,
});
// finding.backward: BackwardResult | undefined
// { nodes, edges, confidence, gaps }
```

`backward.nodes` includes the selected node and admitted discovered ancestors. Discovery order is not a chain or execution order; a bounded or cancelled walk can discover a node without inspecting all its facts. Draw relationships only from `backward.edges`, which retain each admitted relationship's `kind`, `attribution` and evidence references, including parallel relationships and shared ancestors. Backward edge direction is **dependent → recorded parent**, the direction of investigation. Impact edges point **cause → dependent**. Neither direction is a structural flowchart transition, and a recorded read does not prove that a particular output was derived from it.

The backward result is frozen and carries its own confidence and gaps, captured after backward traversal and root ranking, before impact traversal. A complete backward result can coexist with incomplete impact and top-level confidence. The existing `rootCause` rule is unchanged: one supported candidate and complete backward evidence are required, while a complete unmarked graph can still have no root. Partial evidence retains admitted links and named gaps; it never becomes an invented complete trail. Hosts must preserve those gaps and distinguish alternatives from a confirmed root.

This option reuses the existing walk; it dispatches no additional graph/storage calls and adds no separate work allowance or deadline. Omitted or `false` keeps the existing result shape, bytes and graph-call order. Other values and accessor properties are refused before graph dispatch. Storage authorization, exact run/visit binding, ID privacy and application-specific labels remain the host's responsibility.

### Explain coverage for one adjacency page

A host graph may put evidence-bearing reasons on the page returned by `parents()` or
`children()` using optional `Adjacency.gaps`. Parent-page reasons belong only to backward
coverage; children-page reasons belong only to impact. `CauseGraph.gaps(id)` remains
node-wide and contributes to both directions, including for callers using it directly.

```ts
import { explain, type Adjacency, type CauseGraph } from 'foottrace/cause';

const missingParents: Adjacency = {
  edges: [], complete: false,
  gaps: [{ code: 'not-collected', nodeId: 'source', evidence: ['proof:missing-parent-page'] }],
};
// A host returning missingParents from parents() withholds a confirmed root.

const graph: CauseGraph = {
  parents: () => ({ edges: [], complete: true }),
  children: () => ({
    edges: [], complete: false,
    gaps: [{ code: 'not-collected', nodeId: 'source', evidence: ['proof:missing-child-page'] }],
  }),
  attention: () => [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:source'] }],
  gaps: () => [],
};
const result = await explain(graph, 'source', { includeBackward: true });
// rootCause: 'source'; backward.confidence: 'complete'.
// impact and overall confidence: 'incomplete'; retain the child-page proof reference.
```

`complete` describes edge enumeration. Explicit admitted reasons remain limitations even
when it is `true`. For `false` with an omitted or empty page list, the existing fixed
`not-collected` reason at that node remains. A nonempty page list explains that incomplete
page without a second reference-free fallback. Node-wide reasons do not replace this
page-specific fallback. Omission preserves the legacy admitted page's object shape.

Each visited node and direction permits at most 32 supplied reasons jointly across the
node-wide list and its current page, counted before de-duplication. Node-wide admission
occurs first and is cached; parents and children retain separate cached pages. An overflow
refuses that whole page with fixed `invalid-data`, retaining admitted node-wide reasons.
Existing diagnostic refusals do not consume supplied-reason slots. Each reason retains
the existing closed code vocabulary, 16-reference limit and 512-character reference bound;
all admitted records and lists are detached and frozen. Other walk limits are unchanged.

This host-port addition does not migrate the native record adapter's direct node-wide
`gaps()` contract or restore missing record evidence. Hosts still own authorization and
must supply non-secret identities and evidence references.

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

### Host root strategies

`rankRoots(candidates, context, walk)` receives all supported marked nodes in the backward walk, including the investigated node if it was marked. It may select a nearer ancestor. The frozen `walk` has the investigated `nodeId`, visited `nodes`, traversed `edges`, and the default rule's `candidates`. Its edges are the same objects exposed by `includeBackward`. Use `pathTo` from `foottrace/cause` to find a path through those edges, including a subset chosen by the host. This reads the existing walk without asking the graph for more data.

Return a list of selected node IDs or `{ select, withheld }`. Each optional withheld entry names a node visited by the walk and supplies a host `reason` code of at most 64 characters. The result includes `withheldRoots` only when nonempty. Withholding preserves coverage and confidence. A named root has no alternatives. Tied selections remain alternatives. An empty selection with withheld roots keeps the walk's default candidates as alternatives, while the list `[]` leaves them empty. An investigated node may be a root, and is excluded from its own alternatives.

Selections and withheld entries must have distinct identities, and selected IDs must belong to the marked candidates. Strategy results are copied from bounded own data fields. The library bounds what it reads, and the host owns the work performed inside its traps. Name the chosen root strategy when presenting its findings.

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

These names describe the techniques, not a claim of complete language-level instrumentation. Findings are bounded by the dependencies the producer recorded. Cause queries share one deadline and node/edge/call budget across reverse traversal, ranking and forward impact; limits, cancellation and unavailable reads become gaps. Output carries bounded references and fixed codes, never business payloads. `/cause` supports ESM and CommonJS and remains `sideEffects: false`; its unused ESM import is tested to produce the same browser bundle as no import. The package has no runtime dependencies. The cause reader shipped in 1.2.0; later engine stamping, viewer integration and agent tools are separate changes.

Package verification uses strict automatic entrypoint discovery for every door with Are the Types Wrong’s `strict` profile. No entrypoint is excluded and no resolution error is ignored.

The complete synthetic [record example](../examples/cause-record.ts) demonstrates both in-memory and stored adapters. The [record contract](guides/record-contract.md) describes the producer and writer laws.
