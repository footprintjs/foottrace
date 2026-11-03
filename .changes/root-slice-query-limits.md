---
type: changed
bump: major
---

- Bound root backward/forward slices and key timelines with validated hard ceilings, explicit output truncation and cooperative abort/timeout/work stops. Migration: replace unlimited or oversized limits, request finite timeline/read allowances, handle `SliceQueryError`, and inspect every truncation reason before treating a query as complete. See `docs/root-query-limits.md` for the limits and synchronous checkpoint semantics.
