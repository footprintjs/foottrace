# Releasing FootTrace

Releases use the **Release App** workflow in `publish.yml`. A source PR never publishes by itself. Pending `.changes/*.md` fragments produce a normal `release/next` proposal with the strongest requested bump. A reviewer independently checks its exact head, its notes and the source tree, then records an approving GitHub review. A maintainer merges normally only after both Node 22/24 checks, `tested-tree`, and both CodeQL languages pass. No automatic merge or forced branch update exists.

The merged head and final reviewed PR head must have identical trees. Publication holds if the base moved and introduced additional contents. Full tests cannot replace missing release authority. Exact-head CI reuse is an optimization only: incomplete, stale, failed or ambiguous proof runs both original runtime gate lanes. Both CodeQL checks remain mandatory. Every release still builds and checks the package, packs once and publishes those exact bytes with lifecycle scripts disabled.

## One-time owner setup

An owner must install the release GitHub App for **only the selected FootTrace repository** and permit Contents write, Pull requests write and Actions read (with Metadata read). Set public repository variables `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_SLUG`, and the repository secret named `RELEASE_APP_PRIVATE_KEY`. Do not put key material in files, logs or review requests. The workflow resolves the public App and bot user ID and checks that the release PR was authored by that App.

Configure npm trusted publishing for package `foottrace`, owner `footprintjs`, repository `foottrace` and workflow `publish.yml`, with any environment restriction matching the workflow. No npm token fallback is provided. The checked-in route does not prove the App is installed or registry trust configured; setup is a separate owner action after code review. Never publish as an authentication test.

## Review and gate evidence

Only an undismissed approval for the exact final head by another human with current write/admin repository permission grants authority. The historical association label is insufficient; a later changes-requested review holds. An unavailable permission lookup holds. Current main, the release merge, package identity, checked tree, same-repository App PR and both security checks are verified separately from test reuse.

The fast path requires a complete latest CI run and attempt, one successful Node 22 job, one successful Node 24 job, and the exact tree marker. The marker job does not install project code. Artifact IDs come from the fixed upload action, then are checked against the current run, actual successful producer job and attempt, repository and source manifest. Selective reruns cannot borrow older producer outputs: rerun the whole workflow before a submission reservation, or use verification-only after it.

## Stopped or ambiguous runs

The release writer creates a unique `publish-attempt-VERSION.json` asset before npm submission. It contains only source/archive/run identity. This is a conservative cooperative reservation, not proof that a remote request ran or did not run. A failure after reservation can leave an unsubmitted package that requires separately reviewed recovery. **Never delete or overwrite the reservation, move the tag, or automatically retry publication.** An existing reservation always makes later runs verification-only, including while npm validates an upload. A starter or incomplete asset also holds.

The main-only manual `verify_only` input is read-only. Use it while main still identifies the release being checked. It checks npm version/latest and downloaded bytes, the tag and GitHub release, and reports pending or conflict precisely. It reports provenance metadata without claiming cryptographic verification. FootTrace has no separate docs deployment; applicable README/package docs are part of the exact reviewed release. If main has moved, preserve evidence and request normal reconciliation rather than substituting another SHA.

Existing matching release branches and proposals are left alone. A different branch/base, orphaned proposal or multiple open release PRs holds for normal maintainer reconciliation. Branch cleanup is not performed by this workflow.

## Implementation checks

`npm run test:release` runs bounded, offline tests of fragments, proposal transformation, authority, CI evidence, API orchestration, artifact/archive admission and workflow wiring. `npm run check:release` checks fragments and verifies that `publish.yml` exactly matches the trusted inline code generated from its template and helpers. These are appended to the original full `check`; no existing gate is removed. The process helpers use Node builtins, and privileged jobs never check out, install or execute code supplied by an artifact.

## Generated program transport and bounds

The generator embeds a compressed literal of the reviewed helper program in each control step. The step bounds decompression and verifies the exact uncompressed source hash before executing it. This is checked-in workflow source, never code supplied by an artifact or fetched from a branch. Tests execute these actual emitted assembly steps with offline API stand-ins. Every emitted `run` stays within 21,000 characters and each workflow below 500,000 bytes; generation refuses growth past either bound. Output values are admitted together under a separate conservative 64 KiB UTF-16 budget before any output is written.

The change parser validates only explicit `type` and `bump` declarations and selects the strongest declared bump. It does not infer a breaking change or migration text. The reviewer checks those semantics. Standalone verification uses the same exact pinned changelog-section and release-note comparison as the release writer; missing, duplicate or changed release notes refuse verification.
