---
type: added
bump: minor
---

- `CausalEdge.builtOn` (`'partial-write'`): an edge no read is behind. The child's own write of the key did not replace the value, so the key still holds part of what the parent wrote. `sliceToJSON` carries it on its edges, and `formatCausalChain` prints `← built on <key>`.
- `CausalNode.preRunBase` (`{ code: 'from-initial-state', keys }`): the node wrote these keys without replacing them and no commit before it had written them, so what it left rests on the value from before the run. `sliceToJSON` carries it on its nodes.
- `KeyMoment.builtOnWriteIdx` and `KeyMoment.builtOnPreRun`, on a write moment of `keyTimeline`: the write this one was folded onto (the write moment just before it, an earlier commit of the same stage included), or that nothing in the log is under it. One number per write: follow it from the write a read names. `formatTimeline` prints `(added to the value of commit N)`.
- The code `'partial-write'` in `HONESTY_CODES`. `forwardSliceForKey` and `keyTimeline` give it as a note (`HonestyNoteCode`) for a key that was merged into or appended to, naming the commits.
- `foottrace/cause`: `GraphEdge.attribution` gains `'recorded-write'`, for a data edge that is read off the record's rows and commit order and has no read behind it. A node is named once among a node's parents: a certain read of the write underneath keeps its edge, a read that is only a possible source gives its place to this one. A graph of your own may return `'recorded-write'` on a data edge.
