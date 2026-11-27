---
type: added
bump: minor
---

- Pass `maxFields` to `recordScopesFromSnapshot` to admit larger commit values across a snapshot. The graph checks its own field limit when opening each scope.
