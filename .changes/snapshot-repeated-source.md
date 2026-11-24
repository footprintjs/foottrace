---
type: fixed
bump: patch
---

- Preserve each observed read and its writer when a live snapshot shares a read-source descriptor between occurrences. Live and saved snapshots now project the same scopes for repeated reads.
