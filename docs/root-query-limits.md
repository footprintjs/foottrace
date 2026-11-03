# Bounded root slice queries

`causalChain`, `sliceForKey`, `forwardSliceForKey` and `keyTimeline` validate
limits before reading the log or invoking a reads provider, including empty logs
and missing anchors. Limits must be safe integers in the ranges below. Invalid
configuration throws `TypeError` (`SLICE_CONFIGURATION_INVALID`); requests above
a maximum are refused, never silently clamped.

| Option | Default | Hard maximum | Applies to |
| --- | ---: | ---: | --- |
| `maxDepth` | 20 | 1000 | Backward and forward DAGs (zero allowed) |
| `maxNodes` | 100 | 10000 | Backward and forward DAGs, including the root |
| `maxEdges` | 1000 | 100000 | Edges across the entire backward/forward DAG |
| `maxReads` | 1000 | 100000 | Read occurrences across the entire forward DAG |
| `maxMoments` | 1000 | 100000 | Timeline moments |
| `maxWork` | 1000000 | 10000000 | All four queries |
| `timeoutMs` | 1000 | 30000 | All four queries |

Except for depth, the minimum is one. Output limits apply to the complete query,
not separately to each node. A backward or forward cut carries `root.truncated`
with `byDepth`, `byNodes`, and optional `byEdges` / `byReads`. The flat JSON
projections retain these fields; the formatters name the limiting option.
Forward slices also carry a `truncated` honesty note. Timelines return the first
`maxMoments` moments in chronological order, preserving read-before-write order
at the same commit, with `truncated: { byMoments: true }` and a `truncated` note.
An exact fit is complete: a marker appears only when output was actually omitted.

```ts
import { keyTimeline, SliceQueryError, sliceForKey } from 'foottrace';

const controller = new AbortController();
try {
  const slice = sliceForKey(log, 'total', reads, {
    maxNodes: 200,
    maxEdges: 1000,
    timeoutMs: 500,
    signal: controller.signal,
  });
  const timeline = keyTimeline(log, 'total', reads, { maxMoments: 2000 });
  // Treat slice.root?.truncated / timeline.truncated as incomplete evidence.
} catch (error) {
  if (!(error instanceof SliceQueryError)) throw error;
  // error.code: SLICE_CANCELLED | SLICE_TIMEOUT | SLICE_WORK_LIMIT
}
```

Stops throw `SliceQueryError` rather than returning an empty, missing, or
apparently complete answer. One deadline and work owner spans `sliceForKey`'s
anchor/value preparation and its causal traversal. `maxWork` charges commits,
trace rows, recorded read-key counts, path characters, callback read keys, and
traversal checkpoints. Input admission finishes before index/value preparation;
an exhausted input allowance refuses the whole query, never analyzes a prefix
of the log. An aborted signal is checked before preparation and before/after
callbacks; abort is checked before timeout when both have occurred.

These APIs remain synchronous. Stops are cooperative checkpoints, not preemption:
a callback, a synchronous index build, or a value fold must return before the
next check. An abort scheduled on this same event loop cannot run during the
query. `maxWork` bounds the charged units, not every internal comparison,
payload byte, or CPU instruction. Callers needing preemption of untrusted code
or large value payloads should run the query in a worker they can terminate.
No timer, abort listener, or background task is retained by a query.

## Migration

This is a breaking change. Replace `Infinity`, oversized budgets and fractional
limits with legal finite allowances. Full timelines and forward read lists now
need an explicit allowance above the bounded default, within the hard maximum.
Handle `SliceQueryError` and all truncation reasons before treating results as
complete evidence. For longer histories, select a smaller scope or use bounded
queries; there is no unlimited escape hatch. The `/cause` record adapter keeps
its own smaller adjacency allowance and reports newly hidden edges/reads as an
`edge-limit` gap rather than complete adjacency.
