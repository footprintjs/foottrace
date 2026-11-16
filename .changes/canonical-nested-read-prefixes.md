---
type: added
bump: minor
---

- Add opt-in canonical addressed read prefixes through `RecordEncoding.nestedReadTracking` and `RecordFrame.readTracked`. The actual native traversal selects namespace or root fallback without repeating the value read. Default dotted prefixes and silent reads remain unchanged. Producers must retain the mode declaration with saved logs; ambiguous legacy dotted names and missing leaf reads cannot be reconstructed.
