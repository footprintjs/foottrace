# Changelog

## 1.0.2

### Fixed

- Saved execution-tree read evidence now accepts unknown input through the public
  `keysReadFromExecutionTree` helper and rejects malformed reader fields with a
  path-bearing `TypeError`. Invalid child lists, read maps and sparse root slots
  can no longer silently lose evidence or produce misleading coverage. Valid
  trees, traversal/coverage semantics and recorded bytes are unchanged. This is
  a reader-only correctness fix; it adds no new export or dependency.

## 1.0.1

### Fixed

- A causal explanation could name a later step as the source of a value read earlier when the record contained a continuation for the same execution. Reads now stay anchored to that execution's first commit. Variable slices retain the actual writing bundle, including a continuation's write metadata and recorded read provenance. The fix changes reading only: recorded bytes, replay, writer selection and public entry points are unchanged.

## 1.0.0

Extract FootPrint 9.48.1's record layer into an engine-independent package, with file history and byte fixtures preserved. Publication is separately gated by the exact-commit checks in the extraction evidence below; this version heading is not evidence of publication.

### Entry points

- `foottrace`: record types, runtime-ID grammar, commit queries, folds, time-travel strategies/cursors, causal and variable slices, `CommitRangeIndex`, honesty codes and record-serving utilities.
- `foottrace/write`: `SharedMemory`, `EventLog`, `RecordFrame`, writer types, writer-owned freezing and `LOG_PLACEHOLDER`.
- `foottrace/paths`: record-path helpers, safe nested access, and `setNestedValue` / `updateNestedValue` for diagnostics.

Record readers/types previously on `footprintjs/trace` move to `foottrace`. Writer primitives previously on `footprintjs/write` move to `foottrace/write`. Record `pathSegments` and `normaliseStateKey` move to `/paths`; the distinct runtime-ID splitter is `idPathSegments` on the root entry. There are no duplicate public doors or public deep imports. FootPrint's recorder factories, stores, control-dependency and quality recorders remain in FootPrint.

### Compatibility and safety

- Same record and replay laws, full/delta encoding and refusal behavior as 9.48.1, except for the named coordinated security corrections below; no fixture re-pins.
- Preserve the 9.48.1 all-segment dangerous-selector check before nested diagnostic writes. Refused writes remain silent no-ops. Stored payload keys are not selector paths and are left unchanged.
- `normaliseStateKey` and its input type move into the path leaf without changing their implementation.
- No runtime dependencies or engine imports. CommonJS and ESM; Node 22+ and browser-capable source.

### Security — coordinated FootPrint 9.48.2 correction

- Copy-on-write preserves an own enumerable `__proto__` payload property as data when copying arrays and restoring built-in expandos (including a `Date`). The old assignments could change the fresh copy's local prototype and lose the own field; global prototypes were not modified. Record serving and path copying now reuse the existing `putOwn` implementation from one private leaf. Selector refusal, ordinary copying and built-in serialization remain unchanged. Date expandos still follow `structuredClone` at the record boundary; this is not a new serialization format. Corrected rich-value copies intentionally retain the field the old code lost. Public writer regressions accompany the same runtime fix in both libraries; published FootPrint 9.x is released first.
- Add source-only CodeQL analysis for JavaScript/TypeScript and GitHub Actions, with pinned actions, read-only checkout and narrowly scoped upload permission. No query or source-path exclusions were added. The new scan must run before the first publication; scheduled/default-branch coverage requires the workflow on `main`.

### Security — coordinated FootPrint 9.48.3 correction

- FootPrint 9.48.3 shipped at `0df7f5dd2f399915d6c57ad806ca434481838515`. The corresponding Foottrace fix is `14db5f93d74313c9ed026aa4b67e5b0922e9b6a4`; its five affected source files and unchanged `capture/freeze.ts` match that maintained release byte-for-byte.
- Give own-field placement one private owner shared by copies, record merges, diagnostics and transaction privatization. Path writes and copy-on-write walks no longer traverse inherited ordinary fields, invalid selectors are refused before prefix mutation, and defaults named `toString` or `valueOf` are no longer suppressed by inherited destination methods. Stored payload names remain data; record merge laws, descriptor behavior and built-in serialization are unchanged.
- These guarantees cover ordinary data. Existing own accessors retain their native behavior; deliberately hostile proxies, getters and setters are not sandboxed.
- Following owner approval, Foottrace CodeQL findings #7, #10 and #11 were dismissed as false positives with individual reasons, regression-test references and that limitation recorded. Before first publication, a completed scan of the exact final `main`/release commit must show zero open findings. An unscanned branch or a pull-request-only result does not satisfy this gate; dismissed findings may still appear in raw scan results.

See [extraction evidence](docs/extraction.md) and the [record contract](docs/guides/record-contract.md). First publication, consumer migrations and FootPrint's breaking removal are separate release gates.
