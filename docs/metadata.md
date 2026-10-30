# Value-free trace metadata

`foottrace/metadata` admits and queries recorded path names without pretending they
are complete replay records. It is useful when a saved projection retains stage
identities and `trace[].path`, while withholding verbs, values and patches.

```ts
import { readTraceMetadata, traceMetadata } from 'foottrace/metadata';

const scope = { sourceId: 'saved-child', runId: 'run-1', invocationId: 'child#8' };
const source = readTraceMetadata({
  scope,
  addressBasis: 'projection-local',
  commits: [
    { stage: 'Seed', stageId: 'seed', runtimeStageId: 'seed#9', trace: [{ path: 'input' }] },
    {
      stage: 'Calculate', stageId: 'calculate', runtimeStageId: 'calculate#10',
      trace: [{ path: 'total', reads: {
        keys: ['input'], kind: 'per-write', before: { commitIndex: 1, traceIndex: 0 },
      } }],
    },
  ],
});
const result = await traceMetadata(source, {
  scope, key: 'total', before: { commitIndex: 2, traceIndex: 0 },
});
// result.edges are candidate-read links, not proof of derivation.
// result.stateEffect === 'unknown'; result.complete === false.
```

The example supplies a recorded read anchor. Do not invent that anchor from a
stage's label, `readKeys`, stageReads, write position or eventual commit. If the
source has only an unanchored stage-level read list, leave `reads` absent. The
reader then returns the observed occurrences with `reads-unknown`. This is a
narrow capability: it does not reproduce a prior viewer's inferred causal walk.

## Observations and candidates

`selection` lists every related path occurrence before the exclusive cutoff:
exact, inside and around the requested key. `latestExact` is the latest observed
exact-path occurrence, for display. It is never a kill barrier. Earlier exact or
overlapping occurrences remain candidates even after a set, merge, append,
delete, no-op or unknown operation: values are unavailable, so this reader makes
no state-effect assertion. A recorded verb remains a recorded verb, not proof
that the value changed. No value is returned.

For each captured read, the library selects all prior related occurrences at
that read's explicit exclusive anchor. `edges` label them `candidate-read`, with
the captured key, position and `per-write` or conservative `stage` coverage.
These are possible recorded relationships, not semantic derivation. The
canonical path trie/relation helpers own segment matching and the established
bounded cause walker owns graph traversal. The adapter supplies no host callbacks,
ranking, synthetic root cause or replacement replay engine.

The result always carries `stateEffect: 'unknown'` and `complete: false`.
`state-effect-unknown`, `overlapping-operation`, `origin-unknown`, `reads-unknown`,
`stage-read-conservative`, `ancestry-unknown` and `original-address-unknown` are
explicit metadata gaps. A `walk-incomplete` gap retains the existing walker's
fixed reason code and affected local address when known. Keep these gaps visible.
An empty selection is not “never written”; an empty graph is not a complete
explanation.

Absent row reads are unknown, even if the source says `readsAvailable: true`.
`readsAvailable: false` withholds all read links. Explicit captured `keys: []`
is `captured-empty`: an observed empty captured set, not proof that no untracked
input, closure or external effect contributed. A nonempty set is `captured`.
`startKeys` records only boundary names; it supplies no value, origin or seed node.

## Scope, positions and mapping

Every input binds one exact `sourceId`, `runId` and `invocationId` (null for an
explicit root). Every query must repeat that scope exactly. An optional
`invocationPath` is an asserted outer-to-inner chain ending at invocationId;
without it a child has unknown ancestry. Structural admission authenticates none
of these assertions. The host establishes source ownership and any actual
ancestry before presenting them as trusted facts.

Positions are `(commitIndex, traceIndex)` within the admitted sequence. The
cutoff is exclusive, with `{commitIndex: commits.length, traceIndex: 0}` denoting
the end. Within a commit, traceIndex may range from zero to its trace length.
Indices are never clamped. A captured read anchor must be valid and at or before
its owning row, so it cannot bind that row or a later one. Empty commits retain
their positions. Repeated runtime IDs and continuation phases remain distinct
occurrences; neither labels nor phase inference substitute for addresses.

`addressBasis: 'projection-local'` means the rows were projected: those positions
must not be called original history positions. An optional
`originalCommitIndices` must cover every admitted commit with strictly increasing
safe nonnegative indices. It is an explicitly supplied and structurally checked
COMMIT mapping only. Results call that field `originalCommitIndex`; traceIndex
still belongs to the projection. Do not combine those coordinates into a claimed
original trace-row address. V1 offers no trace-row mapping, so a projected result
keeps `original-address-unknown` even when its commit mapping is known.
`source-local` identifies positions in the caller's named source; it does not
authenticate that source.

**Whole-source admission is atomic.** A malformed or over-limit suffix refuses
the input even when a proposed query would end earlier. No refused row is filtered
out and no history is silently reindexed. Successful earlier-cutoff selections
and edges are unchanged by a valid later suffix. Availability can change: a
larger source may exceed admission or query-work limits. A separately admitted
prefix must be explicitly identified and retain any supplied mapping.

## Data boundary and limits

Inputs and queries must be decoded inert data or trusted ordinary objects.
Admission accepts only own data descriptors on plain/null-prototype objects and
ordinary dense arrays. It refuses accessor fields, sparse arrays, symbols,
unknown fields, custom array prototypes/iteration hooks, callbacks, values,
patches and coercion/toJSON hooks. It copies the whitelisted shape and freezes all
retained and returned data. Subsequent caller mutation cannot alter a query.
Reflection can run JavaScript Proxy traps; there is no universal safe Proxy
detector. Reflection failures are normalized, but this API is **not** a sandbox
for hostile live Proxies. Trusted host ports remain a separate capability.

Hard admission limits are 10,000 commits; 128 rows per commit; 100,000 total path
occurrences; 128 keys per read set; 10,000 start keys; 1,024 UTF-16 units per name
or encoded path; 64 segments per path; 250,000 total admitted path segments;
128 invocation segments and 8,192 combined units; 2,000,000 retained string units;
and 250,000 counted fields/items. Paths use `foottrace/paths`' canonical codec:
literal dots and empty segments, including the empty encoded key, are preserved.
No string-prefix approximation or value-dependent writer claim is used.

Queries default to 100 nodes, depth 20, 1,000 edges, 1,000 calls and a cooperative
1,000ms deadline. `maxNodes` may be 1..10,000; `maxDepth` 0..1,000;
`maxEdges`1..100,000. Calls/deadline stay fixed in this version. Initial selection
that exceeds maxNodes and immediate adjacency that exceeds maxEdges are atomic
named refusals; later traversal limits appear in gaps. No partial success is
returned after an adapter capacity refusal.

`maxWork` defaults to 100,000 logical units, with an allowed range 1..1,000,000.
One shared allowance covers candidate/row/read scans, node/edge construction and
result assembly. Before each canonical index query, it is charged
`P + N*(D+1)*(ceil(log2(N+1))+1) + 2*Q`, where P is all admitted path segments,
N all admitted occurrences, D maximum admitted path depth (zero with no paths),
and Q query depth. This is a deterministic capacity-accounting weight, **not**
a count or upper bound of CPU instructions, comparator calls, allocation or
synchronous wall time. Input dimensions independently bound the helper; a
cooperative deadline cannot preempt it. A large unrelated suffix can produce a
named work-limit refusal for an earlier cutoff. No bound refusal is an empty or
complete answer. Private graph IDs/references are short tokens; full public
identities are preserved separately and never concatenated into those tokens.

`TraceMetadataError` has fixed message `TRACE_METADATA_UNAVAILABLE` and code
`invalid-data`, `invalid-handle`, `scope-mismatch`, `work-limit`, `node-limit` or
`edge-limit`. Error messages never repeat raw input. Inspect the fixed code rather
than `instanceof` when crossing module formats; ESM/CJS have separate opaque
handle registries, so create and query a handle through the same module format.

## Replay and compatibility

The opaque handle and result have no replay fields, patch/value objects or
synthesized verbs. Their types are not assignable to a replay source;
`isCommitBundle(handle/result)` is false. No implementation path adapts them to
`stateAt`. Existing replay remains permissive in its established ways: some raw
verb-bearing rows can pass its old guard, and an unrelated object can produce an
empty log-only fold rather than throw. This feature does not tighten those APIs.
Use the complete-record door for complete data and its established value-aware
writer, replay and slicing semantics. Metadata may be less informative; it never
contradicts them with a purported proven state effect.

This is an unreleased additive entry point. The package version and existing
record fixtures remain unchanged until a separately reviewed release.
