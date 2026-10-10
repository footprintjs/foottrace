# Extraction evidence and release gates

This document records the E3 extraction and its first-release gates. `package.json` names the first version, 1.0.0; that alone proves neither publication readiness nor publication. The exact reviewed commit, its completed checks and the owner's publication are separate evidence.

## Provenance

- Source: `footprintjs/footPrint`, 9.48.1, commit `0ada790ae38c16a58caa72cb9af279efb658035d`.
- History operation: `git filter-repo` 2.47.0, using an explicit list of record sources, tests, their helper closure, contracts and package-support files.
- Filtered base: `a12e6ffd36a828b1d96505f41aa2879ca4350009`; 121 relevant historical commits remain. Filtering changes commit IDs; original source blob IDs are retained in `scripts/extraction-manifest.json`.
- The manifest lists the original 44 closed record source files, 74 engine-free suites and four shared test helpers. Additional pure portions of mixed engine/record suites, record freezing and ID-reader suites were transferred during extraction rather than dropped.
- Historical FootPrint tags were not converted into foottrace releases. No 1.0.0 tag is part of E3.

## Intentional changes

The original extraction leaves record algorithms and frozen record bytes unchanged. `normaliseStateKey`, with its `StateKey` type, moves from the slice layer into the path leaf. Its body is unchanged; slices import it there. This prevents a path-only import from loading the slice graph.

The subsequent security review found a preexisting rich-value copy defect, also present in published FootPrint 9.48.1. The coordinated 9.48.2 correction moves the existing `putOwn` implementation unchanged into private `capture/ownData.ts`; `capture/freeze.ts` and `memory/pathOps.ts` share it. Array named properties and restored built-in expandos no longer invoke an inherited setter or replace the fresh copy's prototype. No fixture is re-pinned. A corrected rich-value copy retains its own data field instead of losing it; ordinary copies, selectors and built-in serialization do not change. This is an explicit security fix in both maintained copies, not an unreported extraction behavior change.

### Security follow-up and exact-release gate

The subsequent own-field boundary review adds three explicit corrections:
path writes/copy-on-write walks no longer traverse inherited ordinary fields;
whole-selector refusal happens before prefix mutation; and defaults named
`toString`/`valueOf` are not suppressed by inherited destination methods. Slot
placement now has one L0 owner shared by copies, record merges, diagnostics and
transaction privatization. Its native-compatible and required-slot-creation
operations preserve their distinct existing typed-array behavior. Own accessors,
descriptor flags, payload names, record merge laws and built-in serialization
are not changed. These guarantees cover ordinary data, not a sandbox for
deliberately hostile proxies, getters or setters; existing own accessors keep
their native behavior. The runtime fix adds no scan suppression.

This coordinated follow-up shipped in FootPrint **9.48.3**, commit
`0df7f5dd2f399915d6c57ad806ca434481838515`, before Foottrace 1.0.0 publication.
The corresponding Foottrace fix is `14db5f93d74313c9ed026aa4b67e5b0922e9b6a4`.
The exact comparison against that maintained release matches
`capture/ownData.ts`, `memory/pathOps.ts`, `memory/merge.ts`, `memory/utils.ts`,
`memory/TransactionBuffer.ts` and unchanged `capture/freeze.ts` byte-for-byte.
The corresponding tests differ only where the packages' public entry points
differ. Neither baseline manifests nor frozen fixtures are re-pinned.

The earlier rich-value correction shipped in FootPrint 9.48.2; its three shared files were compared against that release. That earlier comparison remains historical evidence, not proof for the newer candidate. The 9.48.3 comparison above and corresponding public-writer regressions in both packages cover the follow-up. Recheck them if these source files change before E4. The original extraction manifest remains historical provenance; do not rewrite its old blob identities to conceal either correction.

CodeQL now has an explicit source-only JavaScript/TypeScript and Actions workflow. A scan that has not run is unknown, not clean. After owner approval, Foottrace findings [#7](https://github.com/footprintjs/foottrace/security/code-scanning/7), [#10](https://github.com/footprintjs/foottrace/security/code-scanning/10) and [#11](https://github.com/footprintjs/foottrace/security/code-scanning/11) were individually dismissed as false positives, with the reason, regression-test reference and ordinary-data limitation recorded on each finding. This review does not remove queries or exclude source paths. Before 1.0.0 publication, merge the reviewed candidate and require a completed full scan of the **exact final `main`/release commit**, with zero **open** findings. A never-scanned `main` or a pull-request-only result does not count. Approved dismissed findings can remain in raw scan results. If release preparation changes the commit, scan that final commit again before declaring readiness.

Carry-over from FootPrint's security review: nested-helper alerts #12–17 were fixed in 9.48.1. The reviewed `pathOps` (#3, #7–10), `TransactionBuffer` (#4–6) and `utils` (#18) sites retain their selector/own-property guards; the initial extraction did not dismiss those FootPrint alerts. Foottrace's later owner-approved dispositions are listed separately above. The separate adjacent `shallowCopy` defect is corrected here and in 9.48.2. Reconcile new Foottrace findings with those controls rather than treating an empty repository history as proof of safety. FootPrint's test-only ReDoS alert and consumer-audit shell alert belong to engine files that were not moved.

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

1. Independently review both candidates and pass GitHub checks. Merge Foottrace with the extracted file history preserved; FootPrint's engine extraction remains unmerged.
2. Complete E4 release preparation, pass the exact final `main`/release-commit scan above with zero open findings, name that commit and tag, and explicitly declare that foottrace 1.0.0 is ready to publish. Do not reuse a scan of an earlier commit.
3. The owner manually publishes that exact version using their own npm login and two-factor authentication. Never publish a placeholder.
4. Configure trusted publishing close to the first automated release, following current npm instructions. The workflow is `.github/workflows/publish.yml`, uses direct `npm publish`, and has no GitHub environment. Its initial `v1.0.0` event is deliberately excluded so it cannot race the manual bootstrap.
5. Only after publication do E5 consumer migrations begin. The FootPrint extraction branch remains unmerged until those migrations are complete, then ships as FootPrint 10.0.0 in E6.

No consumer has to adopt a new record format. Local record copies retained by FootPrint 9.x during the migration window must not evolve independently: any critical fix needs review in both places before E6.
