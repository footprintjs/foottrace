---
type: added
bump: minor
---

- Read native capture notes through `foottrace/cause`. Coverage binds to the live log, producing leg and commit interval. Disabled channels, known gaps, capture failures and unknown versions have distinct answers. Existing recorded writer evidence stays available.
- `findReadSources` now gives an `absenceReason` when no visible writer could have reached a valid read window. The reason distinguishes a redaction from no write in the supplied log and ignores commits the reader could never have seen.
