# Changelog

## 1.12.1 — 2026-11-11

### Fixed

- Run evidence: the writer no longer stores `about` content its own reader refuses. A read name with a control character is left out and counted in `readsOmitted`; an `about` whose `parent` or `resumes` is not a runtimeStageId is dropped and counted. Before this the reader refused the whole `about` and its parent link was lost. An id longer than the `text` cap now reads `truncated`, not `invalid-data`. `RunControl.why` and `EvidenceChannel.why` are typed as a union of the nine reasons the code returns, `unknown-execution` among them.
- PROV export: each read is charged for its own lookup, not for the whole index, so a record of a thousand commits keeps its `ft:Read` evidence under the `maxWork` ceiling. Output bytes are no longer also charged as work: the default `maxWork` used to stop an export near 240 KB, below the default `maxOutputBytes`. "export output limit reached" is reported only when the byte ceiling refused a node. A mark carried by both the attention map and the execution tree is one `ft:Attention` node.
- Cause: a source identity past the ID ceiling is reported as `invalid-data` and the remaining source edges are kept. It was reported as `edge-limit`, and the remaining edges were dropped.
- Backward slices: a stage that wrote one key more than once in a commit is followed through the reads behind its last write. A per-write edge used the first trace row on the key, so reads made between the two writes were missed. `formatCausalChain` names the key the shown child read; it named the key of whichever child had found the node first.
- Forward queries (`keyTimeline`, `forwardSliceForKey`): an execution's reads are dated once, at its first bundle. A continuation bundle (`phase: 'repeat'` or `'exit'`) recorded them again, which made a stage a reader of writes made after it ran.
- `sliceToJSON` and `formatSlice` keep the note of a slice that has no writer in range (a redaction hid the write) and no longer say that value came from before the run. Slice, timeline and causal-chain text shows a nested key as its segments joined by ` › `; it printed the path separator, a control character.
- `commitStops` and `timeTravel` read an execution tree from a file safely: a null child no longer throws, and a node that points back at itself no longer loops for ever.
- `deepEqual`: two different values could compare equal after a set had tried and refused to pair their members, and the net-change filter then dropped a real change. A set of primitives is compared in one pass.
- `RecordFrame`: a write after `commit()` with no `release()` starts on committed state as it stands. It used to diff against the base from before that commit, so a write that restored a value was dropped and live state kept the wrong value.
- `setNestedValue`, `updateNestedValue`, `SharedMemory.setValue` and `updateValue`: a write whose path runs through a primitive or null replaces it with a container, as replay does. It threw a TypeError.
- `commitValues: 'delta'`: an array with a hole and a named property is recorded as a `set`. It was recorded as an `append`, and replay lost the property and filled the hole.

### Security

- `EventLog.note(kind, data)` refuses a kind that takes the reserved `run.` prefix: the entry is counted in `sinkFailures` and reported to `sink.onFailure`, as any other refused entry is. Only `noteRun` writes those kinds. Before this, a writer's own note could be read back as run evidence, including a decision the run never made.

### Documentation

- The record contract guide lists `phase` and `untrackedSources` on a bundle. The time-travel README points at the examples and tests that live in the FootPrint repository. Stale notes are gone from two example headers, the script headers and the `CommitRangeIndex` header, and `docs/design/prov-p2-contract.md` is marked as not shipped.
- New example `examples/post-execution/metadata/01-trace-metadata.ts`. Every runnable example now runs in the test suite and is checked against the output its own comments give.

## 1.12.0 — 2026-11-07

### Added

- `readRunEvidence(stored, legs, limits?)` reads a run's evidence back from its stored logs: `decisions`, `stops`, `reads`, `attention`, `stages` and `running` channels and `control(id)`, each saying `collected`, `partial` or `not-collected`, so a file with no evidence, including every file an older writer made, reads `not-collected` and never "nothing happened". A chain that cannot finish reads `partial`, never ungoverned: a parentless execution that is not the root is `resumed-leg`, and a `parent` or `resumes` is never followed into a log the caller did not name. A record file is untrusted input: own data only, every list, text and payload capped by `RUN_EVIDENCE_LIMITS` (raised per call), forged rows and anything past a cap listed in `unread` and read as `partial`. Integrity here is not authentication.
- `createStoredRecordGraph` fills `reads`, `controlDeps` and `attention` from a file that holds its own evidence, where the host omits them; a host's own map wins. Its entry cap now counts commits rather than every entry, and every row spends one field, so a log with many notes no longer reads as too large. A stage-level reads map may hold up to 256 names, up from 128.
- `foottrace/write` can keep a run's evidence beside its log: `new EventLog(base, { sink, address, collects })` writes `opened.collects`, `record(bundle, about)` and `CommitStamp.about` write `commit.about`, `noteRun` writes `run.decision`, `run.stop` and `run.stage` notes with a `seq` the log stamps, and `close` writes `closed.runNotes`. `keepsEvidence` is what a writer's seam asks first. These are optional fields and notes: readers of earlier versions read the same record, a bundle's bytes never move, and a log with no `collects` has the same entries and own fields as before. A third-party adapter that copies named fields must copy `collects`, `about` and `runNotes`; one that does not stays valid and its record reads as not collected.

## 1.11.1 — 2026-11-05

### Fixed

- Reading a value after deleting it in the same stage now returns undefined instead of the old value.

## 1.11.0 — 2026-11-02

### Added

- Bound per-write delivered call-source membership to the 32 most-recent distinct canonical IDs and record paired cumulative eviction counts. Preserve latest windows through delta/lossy reconstruction and saved reopening; CauseGraph and PROV disclose truncated ancestry. Legacy no-counter rows remain readable within existing budgets. Migration: retained duplicates now refresh source-window recency; readKeys keeps its existing state-read law. IDs remain whole, so the membership cap is not an absolute byte bound.
Per-write traces can retain a disjoint `readAttempts` ceiling for delivered native call answers. The existing reads-prefix writer captures canonical attempt IDs independently of state paths, omits the field when empty/off, and clears it on discard. An offline host-adapter example reuses existing cause ports; recorded answer availability is conservative evidence, not proof of semantic use or external commitment.

### Fixed

- Verify private Release App identity with a short-lived authenticated App metadata read inside the existing Actions control steps. Keep repository permissions, exact-head approval, source/tree, security, archive and publication-reservation checks unchanged.
- Recover an unpublished current version through a newly reviewed App proposal before consuming queued fragments, preserve retained release history with nonforce updates, and hold on package-input drift or ambiguous publication evidence.

### Documentation

- Clarify the standalone execution-record and replay role, installation guidance and ecosystem routing, and align package search keywords with those use cases.

## 1.10.0 — 2026-11-01

### Added

- Opt-in `explain(..., { includeBackward: true })` returns a `backward` evidence result and the `/cause` `BackwardResult` type. It exposes the existing admitted reverse walk, including dependent-to-parent edges with their attribution and evidence, plus independent backward confidence and gaps. No extra traversal or graph calls occur; omitted/false keeps existing result bytes and call order.

### Fixed

Release controls retain bounded, nonsecret failure codes across API, decoding and local IO boundaries, while preserving exact approval, source, artifact and publication safeguards. Failed or partial attempts remain held for the documented recovery process.
Release run-envelope refusals identify the first failing predicate with a fixed `current-run-*` label. API values, paths, bodies and credentials are not included. The existing checks, order, single run lookup, job validation and fail-closed release behavior are unchanged; legacy `current-run` remains an admitted diagnostic. This reporting change does not diagnose a historical response or authorize a retry.

### Documentation

- Clarify that an explicitly owner-authorized agent may submit the real exact-head GitHub approval through the owner's existing User account after independent review and current checks. Identity, permission, release and publication safeguards are unchanged.

## 1.9.0 — 2026-10-30

Not published to npm (the release bot skipped this version); these changes first shipped in 1.10.0.

### Added

- Optional `foottrace/metadata` ESM/CommonJS/type entry for detached value-free path occurrences and explicitly anchored candidate-read links. Metadata keeps unknown state effects, reads, ancestry and original row addresses visible; it never supplies replay state. The reader reuses the existing canonical path index and bounded traversal, with independent admission and logical work limits. Existing complete-record APIs and recorded bytes stay unchanged.

### Changed

- Prepare separately reviewed releases through a repository-scoped Release App. Publication requires exact-head approval, both CodeQL checks and the original Node 22/24 gates or a matching current-attempt CI proof. The checked archive is submitted once through npm trusted publishing; ambiguous prior attempts remain verification-only. Controls use readable built-in-only helpers at the same immutable event commit, without installs or artifact-supplied executables. The owner must submit a real exact-head GitHub approval after independent review, and complete App installation and trusted-publisher setup before use.

### Documentation

- Correct the README PROV-O heading to identify its already-published 1.6.0 entry point; metadata remains marked unreleased until its separate release proposal.

## 1.8.0 — 2026-10-26

### Added

- Optional host-authorized root read-source evidence for cause and PROV. Exact committed reads link sources to consuming executions; supported entity joins export `prov:used`. Per-write ambiguity, missing ownership, staged/child/resume limits and partial capture retain gaps. Existing calls without the seam keep their results.
- `GraphEdge.attribution` adds `'recorded-read'` for observed source-to-execution edges only. Per-write and semantic derivation stay unproved; exhaustive consumers must handle the new literal.

### Fixed

- Keep missing execution ownership, attempts and read collection unknown in source-backed cause queries. Missing later consumer coverage limits impact without erasing a root established by complete backward evidence; explicit empty write prefixes retain their exclusions.
- Include exact scalar descendant consumers in ancestor-qualified source impact and count recorded source/control fan-out against one immediate edge cap.

## 1.7.0 — 2026-10-23

### Fixed

- Keep exact-read ownership in private bindings, reclaim obsolete live metadata, and validate stored limits against immutable wire-v1 ceilings. Hosts can size retained history within those ceilings; defaults stay unchanged. Existing privacy strings remain supported alongside a value-free post-read verdict.

### Added

- Opt-in native root-read source writer port in `foottrace/write`, with ordered value-free base, committed, staged or unavailable descriptors; bounded historical origin metadata, lifecycle isolation and structural saved-metadata decoding. Scalar root reads are the precise subset; unsupported, missing and redacted evidence remains explicit.
- Offline regression tests and a reproducible read/index overhead benchmark with measured limits. Existing default-off reads, native record bytes, dependencies and reads-prefix semantics stay unchanged. Engine integration, durability, cause/PROV readers and release preparation remain separate.

## 1.6.0 — 2026-10-18

### Added

- Optional asynchronous `foottrace/prov` ESM and CommonJS entry for a bounded, value-free PROV-O JSON-LD export of one recorded scope. Native executions, write occurrences and supported control links retain their recorded identities; captured reads use extension-only candidate relations. Missing, redacted and refused evidence remains explicit gaps, with ordinary snapshots incomplete pending supported native capture/end attestation.
- A PROV export recipe, a runnable value-free example, strict public consumers, browser and tree-shaking checks, and dev-only offline JSON-LD representation tests. Existing record bytes and runtime dependencies remain unchanged. This is feature preparation; the package version remains 1.5.0 until a separate release review.

### Fixed

- Reserve bounded gap, count and truncation-marker bytes before PROV graph admission, so late gaps cannot erase an accepted graph prefix. Routine limitations use counted document summaries; unusual problems retain individual locations. P1 completeness remains always false pending supported native attestation and reader adoption.

## 1.5.0 — 2026-10-18

### Added

- Optional `explain` backward and impact allowances, including ranking, within one total work ceiling and deadline. `/cause` also exports the `TraversalLimits` type.
- Fixed allowance handles keep traversal and ranking charges attached to their direction. Local refusals remain explicit gaps and do not charge the refused operation against its matching total allowance or poison cached evidence.

### Unchanged

- Existing query behavior, record bytes, defaults, dependencies and runtime exports remain unchanged.

## 1.4.0 — 2026-10-17

### Added

- CommonJS `require('foottrace/cause')` support with matching typed exports, alongside the existing ESM import. All public entrypoints now use one strict package-resolution check. Cause algorithms, query limits, record bytes and existing root, `/write` and `/paths` compatibility are unchanged.

### Documentation

- Move the detailed cause contract into a dedicated recipe covering per-write capture, authorized saved records, bounded queries and honest findings, with npm-safe links from the README.
- Explain coded refusal handling across CommonJS/ESM copies, structural record/graph contracts, and the same-format registration required by `freezeRecord` and `serveRecord`.

### Development

- Compile strict public `.cts` and `.mts` consumers once in the required package check, outside coverage instrumentation. Runtime, browser and resolution checks remain covered; no test timeout or coverage setting is relaxed.

## 1.3.0 — 2026-10-17

### Added

- Reference-only `RequirementResult`, `RequirementCheck`, `RequirementReason` and shared check dispositions, plus `readRequirementResults`, fixed admission limits and typed non-echoing refusals on the root door. A result binds a requirement definition to a finding/window and its affected claims, with check/evidence/attempt/action references and separate source-valid/learned-time references. Structural admission never verifies domain truth, source authority or caller permission; a host enforces those facts before factual rendering. Empty check/action lists remain honest absence rather than invented attempts.
- One canonical gap-code registry shared by requirements and cause readers, adding `not-checked`, `no-match`, `ambiguous`, `stale`, `incompatible`, `unsupported` and `not-permitted`. Adapter-specific detail remains a namespaced identifier. A mapping never checked or collected is not a `no-match`. A completed scoped query that returns no subject may report `no-match` within that query scope; neither result proves that a physical relationship does not exist. Existing honesty diagnostics and record bytes are unchanged.

- `RequirementReason` derives exactly twelve domain-evidence codes from that registry. Result and check reasons refuse trace-walk codes such as `cycle`, `node-limit` and `strategy-failed`, while generic cause gaps and typed admission errors keep the full `GapCode` vocabulary. This preserves the distinction between missing domain evidence and the reader's own traversal limits.

## 1.2.0 — 2026-10-17

### Added

- Optional ESM-only `foottrace/cause` reader: bounded `explain` and `attentionList`, pluggable `largestDrop` / `mostAffected` ranking, plus in-memory and lazy stored-record graph adapters. Findings contain attention, evidence references, recorded backward paths, tied alternatives, downstream impact and explicit coverage gaps. The default chooses the earliest marked ancestor by dependency order, never by timestamp or ID.
- Producer-facing `Attention` / `AttentionKind` are type-only root exports, owned by foottrace. A mark carries a fixed reason and evidence references; business rules and future engine stamping remain with producers.
- Shared per-query limits, cancellation and timeout, cycle-safe traversal and untrusted-record projection. Missing evidence yields incomplete findings; no missing evidence is manufactured. No storage vendor, business rerun or model call is built in.
- Public-door, strict layer-boundary and actual ESM unused-import bundle tests; esbuild is a pinned development-only test dependency.

### Compatibility

- Existing root, `/write` and `/paths` runtime/type exports and record bytes remain unchanged. `/cause` adds no CommonJS `require` door; CommonJS applications can use dynamic `import('foottrace/cause')`.
- This candidate does not publish, upgrade consumer apps, stamp engine attention marks, add viewer UI or expose agent tools. Cross-run/service causal links remain deferred.

## 1.1.0

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
  missing. **The law (Q3):** a failing sink never stops the writer — a throw, a rejected promise (watched once,
  through the real `then`), a missing method or an entry the log refuses to send (note data that is not a plain
  object surviving `structuredClone`, an unknown outcome) is counted in `log.sinkFailures` and reported to
  `sink.onFailure({ entry, error })`, never thrown. A `meta` that will not copy is lost on its own and its entry
  still goes. The writer's door refuses what the reader would: a base that is not a plain object, an address with a
  hole or a non-string segment. `memorySink` keeps its entries frozen as far as freezing reaches.
- **`readStoredRecord(entries, limits?)`** (root) reads a sink's entries back into a `StoredRecord`: `logs` by
  address, `root(logRunId)`, `log(address)`, and `unread` — every entry it did not read into a log, with its
  position and reason. Each `StoredLog` has `initialState`, `commitLog`, `gaps`, `notes` (`StoredNote`, arrival
  order), `complete`, `outcome`, `meta` (`{ opened?, closed? }`, never merged), its raw `entries`, and `source()` for
  `timeTravel` / `stateAt` — where the run leg's stored mount logs are its `subflowResults` (one flat map per leg,
  as a live snapshot's), so the cursor marks stored mounts and `drill()` opens them. It takes `Iterable<unknown>`
  (stored entries are untrusted input). A commit sits at its own `bundle.idx`: a commit the store lost or an
  unreadable bundle is a gap that keeps its index, with the same reason in `gaps` and in the fold's `skipped`;
  `closed.commits` makes a lost last commit a gap too. One place, one entry: the first readable commit for an index
  stands, the first `opened` stands, and every other entry for a held place (a redelivery, a conflict, the same
  object again) is listed in `unread`, never compared. `complete` means a `closed` entry covers every stored commit
  (of covering closes, the largest length speaks) AND the reader read the log whole: a log a limit cut, or any log
  once reading stopped at the `entries` limit, is not complete. A mount log's head commit stamped with its own
  mount id is its seed, so a subflow killed in its first stage reads `[start, end]`, as on a live cursor.
- **Bounded work on untrusted input** (`StoredRecordLimits`, raised per call): no recursion, no walk of a stored
  value, an address read by index (never through its own iterator), work per entry bounded by the address limits,
  at most `missingCommits` gap rows for the whole record (spent on the logs that need the fewest first, so a
  corrupt log asking for the most is the one cut), and at most `entries` entries read. Defaults: `entries` 16,777,216 ·
  `missingCommits` 1,048,576 · `drillDepth` 1,024 · `addressLength` 65,536 characters. Whatever a limit stops is
  named in `unread` — never a hang, never a silent cut; so is an entry whose fields throw when read. A limit that
  is not a non-negative integer (or `Infinity`) is a `RangeError`.
- **Attempt IDs** (root): `buildAttemptId(runtimeStageId, attempt, call?)`, `parseAttemptId(id)` and the type-only
  brand `AttemptId` — `charge#4@2` (attempt 2 of `charge#4`) and `charge#4@2.1@3` (attempt 3 of the first call made
  during it). Counts start at 1. Parsed from the right: no stage-ID character is newly reserved.
- Types `Meta`, `LogOutcome` and `StoredRecordLimits` (root); `RecordSink`, `RecordEntry` (`/write`).
- Honesty code `'unread-entry'` for `StoredRecord.unread` (the registry holds 22 codes). One gap reason, produced
  only for a stored log read back by `readStoredRecord`: `no readable commit entry for this index`.

### Changed

- `EventLog.clear()` throws on a log built with a sink: a stored record cannot be wiped. The one-argument log is
  unchanged — the same bytes and the same own fields as 1.0.3.
- `TimeTravel.drill(id)` returns `undefined` for the cursor's own mount, one it was drilled out of, or the log it
  already reads, so a viewer that opens every mount cannot loop on a stored or hand-built log that names one. A
  live, sound run never asks it.
- `commitStops`, without an execution tree, reads a head commit stamped with the log's own mount id as the seed
  when the subflow results say this log is that mount's: the seed opens `start` instead of standing as a stop.
  Logs with a tree, and every other tree-less log, read as before.

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
