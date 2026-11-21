---
type: added
bump: minor
---

- Optional commit `outsideInputs` records declared public source names and observed native call targets. Causal walks and slice views surface this evidence without changing the legacy `UntrackedSource` type or the value fold.
