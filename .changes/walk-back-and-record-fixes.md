---
type: fixed
bump: patch
---

- Backward slices: a stage that wrote one key more than once in a commit is followed through the reads behind its last write. A per-write edge used the first trace row on the key, so reads made between the two writes were missed. `formatCausalChain` names the key the shown child read; it named the key of whichever child had found the node first.
- Forward queries (`keyTimeline`, `forwardSliceForKey`): an execution's reads are dated once, at its first bundle. A continuation bundle (`phase: 'repeat'` or `'exit'`) recorded them again, which made a stage a reader of writes made after it ran.
- `sliceToJSON` and `formatSlice` keep the note of a slice that has no writer in range (a redaction hid the write) and no longer say that value came from before the run. Slice, timeline and causal-chain text shows a nested key as its segments joined by ` › `; it printed the path separator, a control character.
- `commitStops` and `timeTravel` read an execution tree from a file safely: a null child no longer throws, and a node that points back at itself no longer loops for ever.
- `deepEqual`: two different values could compare equal after a set had tried and refused to pair their members, and the net-change filter then dropped a real change. A set of primitives is compared in one pass.
- `RecordFrame`: a write after `commit()` with no `release()` starts on committed state as it stands. It used to diff against the base from before that commit, so a write that restored a value was dropped and live state kept the wrong value.
- `setNestedValue`, `updateNestedValue`, `SharedMemory.setValue` and `updateValue`: a write whose path runs through a primitive or null replaces it with a container, as replay does. It threw a TypeError.
- `commitValues: 'delta'`: an array with a hole and a named property is recorded as a `set`. It was recorded as an `append`, and replay lost the property and filled the hole.
