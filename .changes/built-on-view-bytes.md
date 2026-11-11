---
type: changed
bump: minor
---

- Record bytes, for a commit whose `set` row the writer built on the stage's view, and for no other: the row carries `builtOnView: true`, and the bundle carries `viewAt` when another commit landed between the moment the stage's view was taken and its own commit. `beganAt` and `sawUntil` are written exactly as before, on every bundle, so no read is dated differently. Under the default encoding this reaches only a stage whose rows would not fold back to what it read; under `commitValues: 'delta'` it also reaches every stage that merged into a key and wrote a path inside it. A test that pins record bytes of such a stage sees the added fields.
- `FedBasis` and the type of `CausalEdge.builtOn` each gain a member (`'built-on-view'`), and `HonestyNoteCode` gains `'pre-run-view'`. A `switch` over one of them that is checked for exhaustiveness needs the new case.
- The sentence of `'from-initial-state'` in `HONESTY_CODES` is reworded: it is said of a point (the end of the range asked about, or the write a note or a node names), where it said "in the range asked about". A timeline names one write folded onto the value from before the run, and a later write in the same timeline can replace the key. The code and what it means are unchanged, and a backward slice's note keeps its words.
