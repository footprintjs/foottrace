# Changelog

## 1.0.0 — unreleased extraction candidate

Extract FootPrint 9.48.1's record layer into an engine-independent package, with file history and byte fixtures preserved. This is not a publication-ready or published release.

### Entry points

- `foottrace`: record types, runtime-ID grammar, commit queries, folds, time-travel strategies/cursors, causal and variable slices, `CommitRangeIndex`, honesty codes and record-serving utilities.
- `foottrace/write`: `SharedMemory`, `EventLog`, `RecordFrame`, writer types, writer-owned freezing and `LOG_PLACEHOLDER`.
- `foottrace/paths`: record-path helpers, safe nested access, and `setNestedValue` / `updateNestedValue` for diagnostics.

Record readers/types previously on `footprintjs/trace` move to `foottrace`. Writer primitives previously on `footprintjs/write` move to `foottrace/write`. Record `pathSegments` and `normaliseStateKey` move to `/paths`; the distinct runtime-ID splitter is `idPathSegments` on the root entry. There are no duplicate public doors or public deep imports. FootPrint's recorder factories, stores, control-dependency and quality recorders remain in FootPrint.

### Compatibility and safety

- Same record and replay laws, full/delta encoding, refusal behavior and recorded bytes as 9.48.1; no re-pins.
- Preserve the 9.48.1 all-segment dangerous-selector check before nested diagnostic writes. Refused writes remain silent no-ops. Stored payload keys are not selector paths and are left unchanged.
- `normaliseStateKey` and its input type move into the path leaf without changing their implementation.
- No runtime dependencies or engine imports. CommonJS and ESM; Node 22+ and browser-capable source.

See [extraction evidence](docs/extraction.md) and the [record contract](docs/guides/record-contract.md). First publication, consumer migrations and FootPrint's breaking removal are separate release gates.
