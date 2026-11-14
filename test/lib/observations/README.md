# Observation test hosts

`fixtures.ts` writes and reopens genuine local observation records for the
adjacent capability tests. `browser.ts` supplies only a platform-specific
bundler/VM test host, keeping Node imports outside distributed source. The actual
cold-import and dependency-graph assertions stay beside the observation owner in
`src/lib/observations/cold.test.ts`. Neither helper is packaged or used at runtime.
