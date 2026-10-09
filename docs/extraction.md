# Extraction evidence and release gates

This is the E3 candidate, not a published release. `package.json` names the intended first version, 1.0.0; that is not a publication-ready declaration.

## Provenance

- Source: `footprintjs/footPrint`, 9.48.1, commit `0ada790ae38c16a58caa72cb9af279efb658035d`.
- History operation: `git filter-repo` 2.47.0, using an explicit list of record sources, tests, their helper closure, contracts and package-support files.
- Filtered base: `a12e6ffd36a828b1d96505f41aa2879ca4350009`; 121 relevant historical commits remain. Filtering changes commit IDs; original source blob IDs are retained in `scripts/extraction-manifest.json`.
- The manifest lists the original 44 closed record source files, 74 engine-free suites and four shared test helpers. Additional pure portions of mixed engine/record suites, record freezing and ID-reader suites were transferred during extraction rather than dropped.
- Historical FootPrint tags were not converted into foottrace releases. No 1.0.0 tag is part of E3.

## Intentional changes

The original extraction leaves record algorithms and frozen record bytes unchanged. `normaliseStateKey`, with its `StateKey` type, moves from the slice layer into the path leaf. Its body is unchanged; slices import it there. This prevents a path-only import from loading the slice graph.

The subsequent security review found a preexisting rich-value copy defect, also present in published FootPrint 9.48.1. The coordinated 9.48.2 correction moves the existing `putOwn` implementation unchanged into private `capture/ownData.ts`; `capture/freeze.ts` and `memory/pathOps.ts` share it. Array named properties and restored built-in expandos no longer invoke an inherited setter or replace the fresh copy's prototype. No fixture is re-pinned. A corrected rich-value copy retains its own data field instead of losing it; ordinary copies, selectors and built-in serialization do not change. This is an explicit security fix in both maintained copies, not an unreported extraction behavior change.

### Security follow-up gate

The subsequent own-field boundary review adds three explicit corrections:
path writes/copy-on-write walks no longer traverse inherited ordinary fields;
whole-selector refusal happens before prefix mutation; and defaults named
`toString`/`valueOf` are not suppressed by inherited destination methods. Slot
placement now has one L0 owner shared by copies, record merges, diagnostics and
transaction privatization. Its native-compatible and required-slot-creation
operations preserve their distinct existing typed-array behavior. Own accessors,
descriptor flags, payload names, record merge laws and built-in serialization
are not changed. No scan suppression or dismissal is part of this work.

This coordinated follow-up must ship to FootPrint 9.x before Foottrace 1.0.0.
Its exact release comparison covers `capture/ownData.ts` and `memory/pathOps.ts`,
`memory/merge.ts`, `memory/utils.ts`, `memory/TransactionBuffer.ts`; the
corresponding tests differ only where the packages' public entry points differ.
The 9.48.2 comparison below remains evidence for that earlier fix, not proof for
the newer candidate. Neither baseline manifests nor frozen fixtures are re-pinned.

The earlier rich-value correction shipped in FootPrint 9.48.2; its three shared files were compared against that release. Before E4, compare the five follow-up files above plus `capture/freeze.ts` against the exact coordinated follow-up release, and run the corresponding public-writer regressions in both packages. The original extraction manifest remains historical provenance; do not rewrite its old blob identities to conceal either correction.

CodeQL now has an explicit source-only JavaScript/TypeScript and Actions workflow. A scan that has not run is unknown, not clean. Pull-request/push results must be inspected before 1.0.0; the weekly scan and a default-branch baseline become active only after the workflow/source reaches `main`.

Carry-over from FootPrint's security review: nested-helper alerts #12–17 were fixed in 9.48.1. The reviewed `pathOps` (#3, #7–10), `TransactionBuffer` (#4–6) and `utils` (#18) sites retain their selector/own-property guards; no alerts were dismissed during extraction. The separate adjacent `shallowCopy` defect is corrected here and in 9.48.2. Reconcile new Foottrace findings with those controls rather than treating an empty repository history as proof of safety. FootPrint's test-only ReDoS alert and consumer-audit shell alert belong to engine files that were not moved.

Three entry points replace engine-hosted exports. Test imports follow those public entries except tests explicitly checking a private record rule. FootPrint's engine composes these same classes; it contains no substitute record implementation and re-exports no foottrace declarations.

### Former engine-internal dependencies

| Resolution | Names |
| --- | --- |
| `foottrace` | `deepEqual`, `EXECUTION_DELIMITER`, `PATH_DELIMITER`, `isExecutionKey`, `joinPath`, `idPathSegments`, `serveRecord`, `stageIdOf`, `subflowSegmentsOf` |
| `foottrace/write` | `deepFreeze`, `freezeRecord`, `LOG_PLACEHOLDER` |
| `foottrace/paths` | `nativeGet`, `nativeHas`, `isDeniedSegment` |
| Remove unused import/export | `ArrayWalk`, `DELIM` |
| Use existing public grammar | `lastSegmentOf` callers use `splitStageId(...).localStageId` |

`idPathSegments` is the ID grammar's former private `pathSegments`, not an alias for the record-path helper. Dangerous-key rules and diagnostic writes have one implementation on `/paths`; diagnostic bags are not record writes.

## Proof obligations

`npm run check` builds both formats, type-checks tests, runs the record suite, checks the closed source graph, lints/formats, validates packed type resolution and checks the writer example. Tests prove exactly one entry point per declaration, no engine installation, and shared freezing registration between root and `/write` in each format. Negative controls prove the fence rejects a package import, an upward edge, a cycle, a missing rank and an opaque dynamic import.

The HCI 2.6.1 JSON fixture is copied byte-for-byte. Its public-writer replay and whole-document byte round trip remain checked here. The old engine-frame HCI route is retired. FootPrint retains its 26 engine JSON pins and checks them unchanged against the packed foottrace candidate, along with the full engine suite and its allocation controls. No fixture is re-pinned for extraction.

The candidate's tests must also run without an installed footprintjs package. Node 22 and 24 CI checks a clean dependency installation; local checks do not substitute for those jobs.

## First release is separately gated

1. Independently review both candidates and pass GitHub checks.
2. Complete E4 release preparation, name the exact commit and tag, and explicitly declare that foottrace 1.0.0 is ready to publish.
3. The owner manually publishes that exact version using their own npm login and two-factor authentication. Never publish a placeholder.
4. Configure trusted publishing close to the first automated release, following current npm instructions. The workflow is `.github/workflows/publish.yml`, uses direct `npm publish`, and has no GitHub environment. Its initial `v1.0.0` event is deliberately excluded so it cannot race the manual bootstrap.
5. Only after publication do E5 consumer migrations begin. The FootPrint extraction branch remains unmerged until those migrations are complete, then ships as FootPrint 10.0.0 in E6.

No consumer has to adopt a new record format. Local record copies retained by FootPrint 9.x during the migration window must not evolve independently: any critical fix needs review in both places before E6.
