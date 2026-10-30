---
type: added
bump: minor
---

- Optional `foottrace/metadata` ESM/CommonJS/type entry for detached value-free path occurrences and explicitly anchored candidate-read links. Metadata keeps unknown state effects, reads, ancestry and original row addresses visible; it never supplies replay state. The reader reuses the existing canonical path index and bounded traversal, with independent admission and logical work limits. Existing complete-record APIs and recorded bytes stay unchanged.
