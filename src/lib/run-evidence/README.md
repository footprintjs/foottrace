# run-evidence/ — why a stage ran, from the file alone

A stored log says what a run wrote. This folder holds what else an offline reader needs to say why: which execution led to which, what a decider weighed, why a stage stopped early.

**`kinds.ts`** is the one owner of the shapes, shared by writer and reader. `EventLog` writes them (`collects`, `about`, `noteRun`, `runNotes`), and they travel as optional fields and notes because a new top-level entry kind breaks every earlier reader. The writer serves each value first; nothing here masks anything.
