---
type: security
bump: patch
---

- `EventLog.note(kind, data)` refuses a kind that takes the reserved `run.` prefix: the entry is counted in `sinkFailures` and reported to `sink.onFailure`, as any other refused entry is. Only `noteRun` writes those kinds. Before this, a writer's own note could be read back as run evidence, including a decision the run never made.
