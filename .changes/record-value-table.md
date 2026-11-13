---
type: added
bump: minor
---

- Add opt-in bounded content-addressed value tables and strict canonical JSON through `foottrace/values` and `foottrace/canonical-json`; callers supply the inline redaction law before hashing, omitted writes are disclosed, missing references are refused by name, and old records remain unchanged.
