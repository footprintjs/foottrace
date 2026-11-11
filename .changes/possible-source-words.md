---
type: fixed
bump: patch
---

- The words for a read with only possible sources name both reasons. A read is dated by its stage's read window, and a source is only possible when the key was written inside that window. Two things put a write there: the stage looked at state again after another stage committed (stages side by side), or the array handed to the reader does not show where the stage's reads sit (a slice, or rows taken out, so that a bundle says no index), and a write that could lie in the window is taken to. The `'concurrent-write'` note of `sliceForKey`, `forwardSliceForKey` and `keyTimeline` named the first alone: for a stage that looked at state once, in an array with such a bundle, it stated a second look that did not happen. The note, and the sentences of `'concurrent-write'`, `'replaced-while-running'` and `'written-while-running'` in `HONESTY_CODES`, now say "or the array handed over does not show". The codes, the marks and every answer's data are unchanged.
