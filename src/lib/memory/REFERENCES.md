# References for memory/

Where the ideas in this folder come from, and what is ours. A source is listed only when a rule here rests on it. Each entry names the file that uses it and says what was taken.

## The walk back (`backtrack.ts`)

- Mark Weiser. *Program Slicing.* IEEE Transactions on Software Engineering SE-10(4), 352–357, 1984. https://doi.org/10.1109/TSE.1984.5010248
  Taken: the question. From one value, follow what it was computed from, backward.
- Manu Sridharan, Stephen J. Fink, Rastislav Bodík. *Thin Slicing.* PLDI 2007, 112–122. https://doi.org/10.1145/1250734.1250748
  Taken: follow by default only what produced the value (data edges). The paper leaves the reasons a statement ran (control) out of the slice and adds them back on request; keeping them in the answer as a separate, labelled kind of edge is ours.

## When a step read (`readWindow.ts`, `RecordFrame.ts · sawAt`, `recordCommit.ts · seenOf`)

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
- The window ends at the latest moment one of the step's READS saw, not at its commit, and a write is not a read. The two read tiers of `RecordFrame` make that possible, and it is why a step that only read its first view answers exactly however many siblings committed before it.
- Every source of a read whose key was written in the window is marked as possible on the edge itself (`ReadOverlap`), with the reason.
- One rule serves the backward walk, the forward walk, the key timeline, the cause graph and the PROV export.

## A value built in steps (`builtOn.ts`)

The problem: the last writer of a key is the whole source of its value only when that write replaced the value.

- Alfred V. Aho, Monica S. Lam, Ravi Sethi, Jeffrey D. Ullman. *Compilers: Principles, Techniques, and Tools*, 2nd edition, Addison-Wesley, 2006, section 9.2 (reaching definitions).
  Taken: the frame. An earlier definition of a variable still reaches a point unless a later one has ended ("killed") it on the way. `replacesValue` asks that of a commit: did it end what was written before, or not?
- David R. Chase, Mark N. Wegman, F. Kenneth Zadeck. *Analysis of Pointers and Structures.* PLDI 1990, 296–310. https://doi.org/10.1145/93542.93585
  Taken: the two kinds of update, and the safe side. An update that is shown to replace what a location held (strong) may drop what was known about it. Any other update (weak) must keep it. Here: a write is a replacement only when its rows show it, and in doubt it added.
- Hiralal Agrawal, Richard A. DeMillo, Eugene H. Spafford. *Dynamic Slicing in the Presence of Unconstrained Pointers.* Symposium on Testing, Analysis, and Verification 1991, 60–73. https://doi.org/10.1145/120807.120813
  Taken: what a use of a composite value depends on. An array or a record is made of cells, each with its own last writer, and a use of the whole depends on all of them.
  Changed: they track each cell. A `merge` row does not say which fields it reached, so the walk follows every write back to the last one that replaced the whole value. That can name a writer whose field has since been overwritten. It cannot miss one.

Ours, not taken from a source:

- What a write was folded onto is read off the COMMIT order, not off the read window: a fold applies commits in that order whatever the step saw while it ran. A step that ran beside others can so have two certain parents for one key: the write it read, and the write its own was folded onto.
- The link is an edge of its own kind (`builtOn`), so an answer says which dependences a read is behind and which the record's rows are behind.
- No second edge beside a certain read of the same key from the same parent, so a record whose walk was already right keeps its bytes.
- In the key timeline the link sits on the write, one number each, so the answer grows with the moments and not with their square.
- A `set` row the writer builds out of writes that only added is marked by the writer (`TraceEntry.builtOnView`), and a reader takes the mark as a read of the path from the step's view, dated by the moment that view was pinned (`CommitBundle.viewAt`, a stamp of its own on the commit that carries the row, apart from the stamps that date the reads of the step's code). In the terms of the sources above: the row is a strong update in the fold (it does end what a sibling wrote in between) and a use of the earlier value at the same time (what the view held is in it). The sources have no such row, because their programs write what the code says; here the WRITER chooses the row, so only the writer can say what it put in it.
- That read is kept apart from the reads of the step's code: its own word on the edge (`'built-on-view'`), a mark on the forward read, no read moment in the timeline. An answer to "who read this key" does not name a step that never asked for it.
