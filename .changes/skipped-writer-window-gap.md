---
type: fixed
bump: patch
---

- The saved skipped-writer reader reports a `not-collected` gap when the capture starts after a relevant recorded decision. Earlier versions could answer that no skipped writer could have changed the key without reporting the missing part of the window.
