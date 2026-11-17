---
type: added
bump: minor
---

- Add opt-in canonical addressed read prefixes through `RecordEncoding.nestedReadTracking`, `RecordFrame.readTracked` and `readGlobalTracked`. The actual native traversal selects namespace or root fallback without repeating the value read. A frame refuses to change name encoding after prefix capture. Default dotted prefixes and silent reads remain unchanged. Producers must keep the encoding consistent across a capture and retain its declaration with saved logs; ambiguous legacy dotted names and missing leaf reads cannot be reconstructed.
