---
type: changed
bump: minor
---

- `overlapOf(sources, at)` throws a `RangeError` when `at` is not one of the sources (`sources.before` or a member of `sources.during`). It used to answer `'written-while-running'` for such a position: a mark on a commit the read could not have seen. A caller that passes each source it took from `sources` is not affected.
