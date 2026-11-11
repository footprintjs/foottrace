---
type: changed
bump: minor
---

- Record bytes, for a commit whose `set` row the writer built on the stage's view, and for no other: the row carries `builtOnView: true`, and the bundle carries `beganAt` when another commit landed between the stage's first touch of state and its own commit (the moment the view was taken counts as a look at state for such a commit). A stage that only wrote, with no such row, is still not dated. Under the default encoding this reaches only a stage whose rows would not fold back to what it read; under `commitValues: 'delta'` it also reaches every stage that merged into a key and wrote a path inside it. A test that pins record bytes of such a stage sees the added field.
- `FedBasis` and the type of `CausalEdge.builtOn` each gain a member (`'built-on-view'`). A `switch` over either that is checked for exhaustiveness needs the new case.
