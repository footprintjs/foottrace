---
type: fixed
bump: patch
---

- Replaying a record in a browser no longer throws `TypeError: Illegal invocation`. Since 2.3.0 the replay called the browser's `structuredClone` as a method, which browsers refuse and Node allows; it now calls it directly, including a `copyValue` a caller supplies.
