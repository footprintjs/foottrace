---
type: changed
bump: patch
---

- A standalone state replay freezes its detached plain-object and array state directly, avoiding a second full copy. Cursor snapshots retain their private working copy.
