---
type: changed
bump: patch
---

- Reading a single replay stop with `stateAt` avoids copying plain objects and arrays twice. A replay cursor still returns an independent snapshot at each stop.
