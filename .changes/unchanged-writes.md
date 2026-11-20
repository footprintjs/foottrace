---
type: added
bump: minor
---

- `findUnchangedWrites` and the optional `causalChain` evidence show matched stages that tracked a write without changing the value. The separately labelled edge and gaps preserve the commit log's existing value attribution. The opt-in edge adds `'unchanged-write'` to `CausalEdge['kind']`, so exhaustive TypeScript switches need a case for it.
