---
type: added
bump: minor
---

- The list form of an execution tree, `ExecutionChain`: an array of stages in the order they ran, with a fork's children in `ExecutionTree.branches`, one array each. Its depth is how far forks nest, not how long the run was. A run of 30,000 stages in the linked form is 30,000 levels deep, and `structuredClone` and `JSON.stringify` run out of stack on it; footprintjs 12 writes the list form. `keysReadFromExecutionTree`, `commitStops`, `tagStops`, `timeTravel` and the PROV export read both forms; the linked form (`next`, `children`) reads as before. `commitStops` and a strategy's `stopsFor` take `ExecutionTree | ExecutionChain`. The PROV export reads a chain as one level, so a long run no longer meets `maxDepth` (128 by default). A malformed `branches` is refused (`keysReadFromExecutionTree`, naming its index) or recorded as a gap without dropping its valid siblings (PROV).
