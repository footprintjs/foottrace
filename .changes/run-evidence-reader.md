---
type: added
bump: minor
---

- `readRunEvidence(stored, legs, limits?)` reads a run's evidence back from its stored logs: `decisions`, `stops`, `reads`, `attention`, `stages` and `running` channels and `control(id)`, each saying `collected`, `partial` or `not-collected`, so a file with no evidence, including every file an older writer made, reads `not-collected` and never "nothing happened". A chain that cannot finish reads `partial`, never ungoverned: a parentless execution that is not the root is `resumed-leg`, and a `parent` or `resumes` is never followed into a log the caller did not name. A record file is untrusted input: own data only, every list, text and payload capped by `RUN_EVIDENCE_LIMITS` (raised per call), forged rows and anything past a cap listed in `unread` and read as `partial`. Integrity here is not authentication.
- `createStoredRecordGraph` fills `reads`, `controlDeps` and `attention` from a file that holds its own evidence, where the host omits them; a host's own map wins. Its entry cap now counts commits rather than every entry, and every row spends one field, so a log with many notes no longer reads as too large. A stage-level reads map may hold up to 256 names, up from 128.
