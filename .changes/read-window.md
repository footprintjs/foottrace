---
type: fixed
bump: patch
---

- Walk back for steps that run side by side. A log is ordered by commit, so a step that read `x` when it started and committed after a sibling replaced `x` was answered with the sibling as its source, and the step whose value it really read was left out. `causalChain`, `sliceForKey`, `forwardSliceForKey`, `keyTimeline`, the cause graph and the PROV export now date a read where its step looked at state.
- A record without the fields (written by an earlier version, or by a producer that does not write them) is read as before: a read is dated at its step's commit.
- The cause graph and the PROV export keep the two fields, and each bundle's own `idx`, when they admit a bundle, and refuse a bundle whose values cannot be such stamps. A reader places a step's window by the `idx` the bundles carry, so a log handed over as a slice, with some bundles filtered out, or behind another log gives the same answer as the whole log; where the indices around a step cannot be trusted, every earlier writer is given as a possible source. A bundle that says no `idx`, in a place where the indices around it show that bundles are missing, is counted inside a step's window whenever it could be there. The two doors keep a bundle's `idx` only when it rises past the bundle before it (a missing or odd `idx` on a bundle with no stamp is left off the copy; beside a stamp it refuses the bundle) and write none of their own.
