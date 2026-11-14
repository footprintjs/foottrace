---
type: added
bump: major
---

- Add opt-in bounded host observation records through the existing sink framing, with exact expected subject matching, once-only closure and explicit missing/omitted evidence. Structural completeness remains unauthenticated and does not establish causation, customer delivery or durability.

- Migration: observation gaps and omissions add eleven keys to `HONESTY_CODES` and widen exported `HonestyCode`; exhaustive switches and `Record<HonestyCode, ...>` consumers must handle the added cases. This requires a major release even though observation capture is opt-in and existing stored wire formats are unchanged. The separately reviewed release proposal must run the major-version consumer compatibility process; this feature does not bump or publish a package version.
