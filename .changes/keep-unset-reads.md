---
type: fixed
bump: patch
---

- Keep tracked reads of unset keys when walking saved execution trees, so causal walks see the same read names before and after a JSON round-trip.
