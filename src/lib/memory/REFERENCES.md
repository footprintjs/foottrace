# References for memory/

Where the ideas in this folder come from, and what is ours. A source is listed only when a rule here rests on it. Each entry names the file that uses it and says what was taken.

## The walk back (`backtrack.ts`)

- Mark Weiser. *Program Slicing.* IEEE Transactions on Software Engineering SE-10(4), 352–357, 1984. https://doi.org/10.1109/TSE.1984.5010248
  Taken: the question. From one value, follow what it was computed from, backward.
- Manu Sridharan, Stephen J. Fink, Rastislav Bodík. *Thin Slicing.* PLDI 2007, 112–122. https://doi.org/10.1145/1250734.1250748
  Taken: follow by default only what produced the value (data edges), and keep the reasons a statement ran (control) as a separate, labelled kind of edge.

## When a step read (`readWindow.ts`, `RecordFrame.ts · observe`, `recordCommit.ts · seenOf`)

The problem: a log is ordered by commit, and steps that run side by side do not read in that order.

- Leslie Lamport. *Time, Clocks, and the Ordering of Events in a Distributed System.* Communications of the ACM 21(7), 558–565, 1978. https://doi.org/10.1145/359545.359563
  Taken: the warning. An order put on events (here: commit order) can place one event before another that it did not, and could not, affect. Whether it did needs its own evidence.
- H. T. Kung, John T. Robinson. *On Optimistic Methods for Concurrency Control.* ACM Transactions on Database Systems 6(2), 213–226, 1981. https://doi.org/10.1145/319566.319567
  Taken: the two numbers and the test. A transaction notes how many transactions had committed when it started and when it finished reading. The ones that can have changed what it read are those that committed between the two and wrote something it read. `beganAt` and `sawUntil` are those two numbers, and `readSourcesOf` is that test.
  Changed: they use the test to throw the transaction's work away and run it again. A step here is never run again for this; its answer is kept, and the writers the test finds are reported as possible sources.
- Hal Berenson, Phil Bernstein, Jim Gray, Jim Melton, Elizabeth O'Neil, Patrick O'Neil. *A Critique of ANSI SQL Isolation Levels.* SIGMOD 1995, 1–10. https://doi.org/10.1145/223784.223785
  Taken: what a view pinned at the start means. A reader that works on committed state as it stood when it started (snapshot isolation) reads from the last committer before its START, not before its commit. That is why `beganAt` alone gives an exact answer.
- Jens Krinke. *Static Slicing of Threaded Programs.* PASTE 1998, 35–42. https://doi.org/10.1145/277631.277638
  Taken: the kind of edge. A dependence on a write made by a thread running at the same time (interference dependence) is a different thing from a dependence on an earlier write, and a slice has to show both. Here these are the edges marked `written-while-running`.

Ours, not taken from a source:

- The two numbers go on the commit record only when they say something, so a run whose steps go one after another keeps its bytes.
- The window ends at the step's last look at LIVE state, not at its commit. The two read tiers of `RecordFrame` make that possible, and it is why a step that only read its first view answers exactly however many siblings committed before it.
- Every source of a read whose key was written in the window is marked as possible on the edge itself (`ReadOverlap`), with the reason.
- One rule serves the backward walk, the forward walk, the key timeline, the cause graph and the PROV export.
