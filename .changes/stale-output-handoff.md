---
type: fixed
bump: patch
---

- Refuse stale subflow output handoffs when a later commit by the same execution writes the mapped path or an overlapping path, while keeping local causal evidence available.
