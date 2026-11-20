---
type: added
bump: minor
---

- The `findReadSources` result always carries `initialStatePresence`. With a plain `initialState` record it reports whether the key was present before the run, separately from the writers visible in the commit log. Without a supplied base it reports `unknown`.
