---
type: fixed
bump: patch
---

- Writing or replaying a record in a browser no longer throws `TypeError: Illegal invocation`. Since 2.3.0 the writer's commit and every replay called the browser's `structuredClone` as a method, which browsers refuse and Node allows, so in a browser no stage could commit. It is now called directly, including a `copyValue` a caller supplies.
