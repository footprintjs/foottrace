# Changelog

## Unreleased — minor (1.1.0)

### Added

- **A record that survives the run.** `new EventLog(base, { sink, address, meta? })` (`foottrace/write`) hands every
  entry to a `RecordSink` as it lands: `opened` from the constructor (the base, as the sink's own copy), `commit`
  after each bundle is frozen and appended, `note` from the new `log.note(kind, data)`, and `closed` from the new
  `log.close(outcome, meta?)` with the log's length (`commits`). A run that is killed still leaves its record, and
  the evidence noted as it happened (an attempt that ended) survives without a closing entry. `memorySink()` is the
  reference adapter; an app brings a file, a bucket or a table by implementing the four methods. Each stored entry
  is a `RecordEntry` (the method's entry plus its name as `kind`; a note's own kind is stored as `note`).

  ```ts
  const sink = memorySink();
  const log = new EventLog({ count: 0 }, { sink, address: { logRunId: 'run-1', drillPath: [] } });
  log.note('attempt', { attempt: 1, outcome: 'timeout' });
  // the process dies: no close
  readStoredRecord(sink.entries).root('run-1')?.complete; // false — and the note is there
  ```

  **Why:** an in-memory log dies with its process, and the record of a run that never finished was exactly the one
  missing. **The law (Q3):** a failing sink never stops the writer — a throw, a rejected promise, a missing method or
  an entry the log refuses to send (note data that is not a plain object surviving `structuredClone`, an unknown
  outcome) is counted in `log.sinkFailures` and reported to `sink.onFailure({ entry, error })`, never thrown.
- **`readStoredRecord(entries)`** (root) reads a sink's entries back into a `StoredRecord`: `logs` by address,
  `root(logRunId)`, `log(address)`, and `unread` — every entry it could not read, with its position and reason.
  Each `StoredLog` has `initialState`, `commitLog`, `gaps`, `notes` (`StoredNote`, arrival order), `complete`,
  `outcome`, `meta` (`{ opened?, closed? }`, never merged), its raw `entries`, and `source()` for `timeTravel` /
  `stateAt` — where the logs stored under it are its `subflowResults`, so the cursor marks stored mounts and
  `drill()` opens them. It takes `Iterable<unknown>` (storage gives entries back unvalidated). A commit sits at its
  own `bundle.idx`: a commit the store lost, two that disagree or an unreadable bundle is a gap that keeps its index,
  with the same reason in `gaps` and in the fold's `skipped`; `closed.commits` makes a lost last commit a gap too.
  `complete` means a `closed` entry covers every stored commit. A stored log is read up to 2^24 commits (a budget,
  so one corrupted index cannot make the reader allocate without bound).
- **Attempt IDs** (root): `buildAttemptId(runtimeStageId, attempt, call?)`, `parseAttemptId(id)` and the type-only
  brand `AttemptId` — `charge#4@2` (attempt 2 of `charge#4`) and `charge#4@2.1@3` (attempt 3 of the first call made
  during it). Counts start at 1. Parsed from the right: no stage-ID character is newly reserved.
- Types `Meta` and `LogOutcome` (root); `RecordSink`, `RecordEntry` (`/write`).
- Honesty code `'unread-entry'` for `StoredRecord.unread` (the registry holds 22 codes). Two gap reasons, produced
  only for a stored log read back by `readStoredRecord`: `no readable commit entry for this index` and
  `commit entries for this index disagree`.

### Changed

- `EventLog.clear()` throws on a log built with a sink: a stored record cannot be wiped. The one-argument log is
  unchanged.

### Compatibility

- Minor: no export removed or moved (pinned by `test/architecture/exports.test.ts`). The one-argument `EventLog`
  behaves exactly as before; record bytes are unchanged with or without a sink (the hcifootprint 2.6.1 fixture is
  replayed both ways). No runtime dependency added.

## 1.0.3

### Fixed

- The shared saved-record validator now rejects missing or non-string write
  paths. Previously these could pass `isCommitBundle`, silently hide a causal
  writer in a short log, or crash reading a longer log. Replay reports the
  entire malformed bundle as an indexed gap instead of partially applying it.
  Causal readers still take typed bundles: unknown saved rows must first pass
  `isCommitBundle`. Valid records, optional historical metadata, string path
  spellings and recorded bytes are unchanged. This reader-only fix adds no
  export or dependency.

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
