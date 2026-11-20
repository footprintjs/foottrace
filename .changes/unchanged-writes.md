---
type: added
bump: minor
---

- `findUnchangedWrites` and `causalChainWithUnchangedWrites` show matched stages that tracked a write without changing the value. The opt-in walk adds an `'unchanged-write'` edge to `CausalEdgeWithUnchangedWrites`. The default `causalChain` and `CausalEdge` keep the existing `data` and `control` kinds.
