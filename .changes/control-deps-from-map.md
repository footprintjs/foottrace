---
type: added
bump: minor
---

- `controlDepsFromMap(map)`, on the root door beside `keysReadFromMap`: the lookup `causalChain` and `sliceForKey` take as `controlDeps`, made from a saved control map (a plain object from a step's `runtimeStageId` to `{ deciderId, label? }`, the shape a control recorder saves). It reads own data properties only (never the prototype, never a getter), returns an edge only when `deciderId` is a string and `label` is absent or a string, gives `undefined` for anything else and never throws at lookup time; it reads the caller's object live, as `keysReadFromMap` does. It throws a `TypeError` for an argument that is not a plain object. A `controlDeps` that is not a function (a saved map handed over as it is) is now refused at the `causalChain` or `sliceForKey` call with a `TypeError` that names the option and the helper, where it used to fail from inside the walk as "controlDeps is not a function", or not at all when the start id or key was absent.
