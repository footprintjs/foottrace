---
type: fixed
bump: major
---

- Store explicit loop hops in run evidence v2 and use the same governing-decision rule for saved and live records. A version 1 record reports partial control when a path may cross a loop re-entry.
- Migration: use a v2-capable reader with v2 writers and handle `run.loop` in exhaustive switches over run-note kinds. A reader that supports only v1 reports newer-writer for v2 evidence.
