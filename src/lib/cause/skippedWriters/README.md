# Skipped paths and possible writers

This folder holds the pure reader pieces for plan 1.3. The reader uses admitted decision rows in durable order and the native fold of the selected log to locate its question window. It follows only skipped placements in the known control region. The graph and the recorded choice have independent evidence. The writer is a declared possibility or another observed execution of that static stage. The resulting value and outcome remain unknown. An unexplained repeated stage in the recording window adds a conservative gap. A confirmed or unexplained return is checked along its recorded parent chain. A matching return prevents that loop body from being reported as skipped. When ancestry is incomplete, the reader withholds the matching claim and reports a gap.

The adapter owns chart authority, scope, redaction and capture identity. A saved query needs an independently trusted immutable recording version over the full entry stream and a capture-time digest of the exact projected topology. A live query must bind the actual immutable traversal projection. An authorized adapter admits the graph before invoking the internal fold.

## Saved recordings

Import `couldHaveChanged` and `savedChartDigest` from `foottrace/cause`. The capture producer supplies a version-1 `SkippedChartProjection` of stage placements, direct branch choices, shared continuations and optional exhaustive write paths. It stores the digest with the immutable recording version, exact log address, run leg and covered commit interval. The trusted host catalog must identify the immutable version of the whole entry stream, including native decision and loop notes.

Call `couldHaveChanged(recording, key, beforeIdx, { address, chart, authority })` with the canonical `readStoredRecord` result the host admitted. The host's `authority.lookup` returns the capture and any available binding for that exact admitted record and scope. It returns `undefined` when access is denied. Use an exclusive array position for `beforeIdx`. The host supplies only chart metadata it is authorized to serve. A legacy file, a missing catalog entry, or a chart from another build returns a gap.

`causalChainWithCouldHaveChanged` derives the exclusive position from the selected execution's first commit. Its `causal` property is the ordinary DAG for an admitted scope, including when chart evidence is unavailable. The separate `skipped` property holds `could-have-changed` links with the recorded decision and each reachable writer's basis. They leave weighting and causal JSON unchanged.


## Evaluating an independently admitted source

An adapter can use `evaluateSkippedPaths(entries, key, beforeIdx, { address, chart, from, to })` from `foottrace/cause` after it has checked the origin and authority of its capture. Supply JSON record entries, the matching projection, and the covered half-open commit interval. The query position is an exclusive commit index in that interval. Rows outside the selected log cannot supply candidate evidence.

The evaluator copies bounded own JSON data before reading it, with a 1 MiB input limit and shared work across shape checks, record parsing and reachability. It reports candidate facts and gaps. Its result has no binding field. The adapter owns provenance, including the decision to decline copied snapshots, stale captures, foreign scopes or data it cannot independently establish. For saved catalog-backed data, use the existing `couldHaveChanged` entry point.
