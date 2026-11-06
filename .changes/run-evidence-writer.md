---
type: added
bump: minor
---

- `foottrace/write` can keep a run's evidence beside its log: `new EventLog(base, { sink, address, collects })` writes `opened.collects`, `record(bundle, about)` and `CommitStamp.about` write `commit.about`, `noteRun` writes `run.decision`, `run.stop` and `run.stage` notes with a `seq` the log stamps, and `close` writes `closed.runNotes`. `keepsEvidence` is what a writer's seam asks first. These are optional fields and notes: readers of earlier versions read the same record, a bundle's bytes never move, and a log with no `collects` has the same entries and own fields as before. A third-party adapter that copies named fields must copy `collects`, `about` and `runNotes`; one that does not stays valid and its record reads as not collected.
