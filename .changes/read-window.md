---
type: fixed
bump: minor
---

- Walk back for steps that run side by side. A log is ordered by commit, so a step that read `x` when it started and committed after a sibling replaced `x` was answered with the sibling as its source, and the step whose value it really read was left out. `causalChain`, `sliceForKey`, `forwardSliceForKey`, `keyTimeline`, the cause graph and the PROV export now date a read where its step looked at state.
- `CommitBundle` gains two optional fields that `RecordFrame` writes: `beganAt` (how many commits the log held when the step first looked at state, when another step committed before it did) and `sawUntil` (how many it held when the step last read live state, when that was after such a commit). A run whose steps go one after another carries neither, so its record bytes do not change. Records of forks and other parallel steps gain `beganAt` on the steps a sibling committed under.
- A step that only read what it saw when it began has one certain source however many siblings committed first. A step that read live state again after a sibling committed the key has several possible sources: each edge carries `overlap: 'replaced-while-running' | 'written-while-running'`, `ForwardRead.overlap` and `KeyMoment.orWriteIdxs` say the same forward, and the answer carries a `'concurrent-write'` note. Three codes are added to `HONESTY_CODES`.
- A record without the fields (written by an earlier version, or by a producer that does not write them) is read as before: a read is dated at its step's commit.
- The cause graph and the PROV export keep the two fields, and each bundle's own `idx`, when they admit a bundle, and refuse a bundle whose values cannot be such stamps. A reader places a step's window by the `idx` the bundles carry, so a log handed over as a slice, or with some bundles filtered out, gives the same answer as the whole log.
