# Releasing FootTrace

Releases use the **Release App** workflow in `publish.yml`. A source PR never publishes by itself. Pending `.changes/*.md` fragments produce a normal App-authored `release/next` proposal with the strongest declared bump.

For each release proposal:

1. Claude independently reviews the exact final head and the merge verdict is recorded publicly; both Node 22/24 checks, `tested-tree`, and both CodeQL languages must pass. Reconcile current main, head and the tested/merge tree before approval.
2. The repository owner may submit the GitHub Approve review personally, or explicitly authorize Codex or Claude to submit it on the owner's behalf through the owner's existing authorized User account. Standing authorization for FootTrace releases remains sufficient within its stated scope. The real GitHub `APPROVED` review must target the exact final head, and the account's current repository-permission API value must be exactly `write` or `admin`. The Release App bot authors the PR; the approving User account must differ from that author. A delegated review names the submitting agent and the owner's explicit authorization. No independent technical review is waived: the builder cannot provide their own independent verdict.
3. A maintainer merges normally. The workflow checks the actual GitHub approval and every other authority requirement before publication.

An exchange verdict or ordinary GitHub comment is not the GitHub approval. The workflow does not read the private exchange or establish the identity of its reviewer. The independent verdict is a process requirement; the GitHub APPROVED review is a separate machine requirement. A changed head needs fresh independent review, current checks and a fresh exact-head approval; standing operator authorization does not carry release approval to changed bytes. No workflow auto-approval, automatic merge or forced branch update exists.

The workflow verifies GitHub account type, current permission, exact head and effective review state. It cannot identify the physical operator and cannot authenticate private authorization, reviewer independence or disclosure from review prose. Delegation, disclosure and public verdict ordering are process obligations; the review body documents the action but never supplies machine authority. The workflow does not submit approvals. Use only the owner's existing authorized account/session: unavailable authentication or insufficient permission holds. Do not read secrets, acquire new credentials or bypass authentication to submit a review. This delegation is for FootTrace release proposals, not arbitrary code PRs.

The merged head and final reviewed PR head must have identical trees. Publication holds if the base moved and introduced additional contents. Full tests cannot replace missing release authority. Exact-head CI reuse is an optimization only: incomplete, stale, failed or ambiguous proof runs both original runtime gate lanes. Both CodeQL checks remain mandatory. Every release still builds and checks the package, packs once and publishes those exact bytes with lifecycle scripts disabled.

## One-time owner setup

These prerequisites are **not configured or verified by this source PR**. Missing setup holds/fails closed; it never falls back to manual token publication.

- A GitHub owner installs the existing `agentfootprint-release` App for the selected `footprintjs/foottrace` repository, or creates and installs a suitable separate Release App. Required repository permissions are Contents write, Pull requests write, Actions read and Metadata read; no administration or broad extra repository scope is needed.
- The owner sets public repository variables `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_SLUG` for that same App. The route resolves the public App and bot identity and checks the PR author; a branch name or display name is insufficient.
- The owner stores the App private key under the secret name `RELEASE_APP_PRIVATE_KEY` and handles the `.pem` privately. Never put key material in source, logs, chat or review requests.
- An npm package owner configures/confirms trusted publishing (OIDC) for package `foottrace`, GitHub owner `footprintjs`, repository `foottrace` and workflow `publish.yml`. This workflow currently has no named environment; the trusted-publisher setting must match, or a later reviewed workflow change must introduce one explicitly. There is no npm token fallback. Never publish as an authentication test.
- For every App-authored release proposal, the owner or their explicitly authorized delegate performs the separate exact-head GitHub Approve step above after the independent public verdict and current checks.

## Review and gate evidence

Only an undismissed approval for the exact final head by an eligible User account distinct from the App author, with current write/admin repository permission, grants machine authority. Delegated submission uses the owner's account under the policy above; it does not make a Bot review eligible. The historical association label is insufficient; a later changes-requested review holds. An unavailable permission lookup holds. Current main, the release merge, package identity, checked tree, same-repository App PR and both security checks are verified separately from test reuse.

The fast path requires a complete latest CI run and attempt, one successful Node 22 job, one successful Node 24 job, and the exact tree marker. The marker job does not install project code. Artifact IDs come from the fixed upload action, then are checked against the current run, actual successful producer job and attempt, repository and source manifest. Selective reruns cannot borrow older producer outputs: rerun the whole workflow before a submission reservation, or use verification-only after it.

## Stopped or ambiguous runs

The release writer creates a unique `publish-attempt-VERSION.json` asset before npm submission. It contains only source/archive/run identity. This is a conservative cooperative reservation, not proof that a remote request ran or did not run. A failure after reservation can leave an unsubmitted package that requires separately reviewed recovery. **Never delete or overwrite the reservation, move the tag, or automatically retry publication.** An existing reservation always makes later runs verification-only, including while npm validates an upload. A starter or incomplete asset also holds.

The main-only manual `verify_only` input is read-only. Use it while main still identifies the release being checked. It checks npm version/latest and downloaded bytes, the tag and GitHub release, and reports pending or conflict precisely. It reports provenance metadata without claiming cryptographic verification. FootTrace has no separate docs deployment; applicable README/package docs are part of the exact reviewed release. If main has moved, preserve evidence and request normal reconciliation rather than substituting another SHA.

Existing matching release branches and proposals are left alone. A different branch/base, orphaned proposal or multiple open release PRs holds for normal maintainer reconciliation. Branch cleanup is not performed by this workflow.

## Readable helper and checkout boundary

Every control job checks out the current repository at literal `${{ github.sha }}` using the pinned checkout action with `persist-credentials: false`, submodules disabled and LFS disabled. The runner checks HEAD against that event SHA before API access. Only main push/dispatch reaches the release graph; a PR, branch name, workflow input or downloaded artifact never chooses helper code. Current-main and independent head/merge-tree checks still decide authority separately.

The workflow invokes the readable `scripts/release-runner.cjs` with one fixed stage. Its closed local module set is `release-github`, `release-control`, `release-prepare`, `release-changes` and `release-archive`; these use only explicit Node built-ins. Control jobs do not run installs, npx, package scripts, local actions or downloaded executables, and setup-node's automatic dependency cache is disabled there. The existing read-only gates/build jobs retain their installs and full checks. Checkout never receives the App token; that token is created afterward and exposed only to the proposal API step. Job permissions still bound the ordinary checkout token.

The helper source and workflow share one trust root: the reviewed main event commit. This does not defend against an authorized malicious change to that commit or a compromised runner/action. It makes the executed program directly reviewable without pretending a self-authored checksum provides independent authority. No generator or encoded executable transport remains.

The publisher's checked archive is written to a fixed absolute run/attempt directory under RUNNER_TEMP, outside checkout. Only after that selection do the bundled npm version check and single submission run from that archive-only directory. The submission uses the exact file, `--ignore-scripts`, public access and an explicit npmjs registry; it never extracts/rebuilds the package or loads checkout-local project configuration. The pinned setup-node user configuration supports OIDC; no key/token fallback is added.

## Implementation checks

`npm run test:release` runs bounded offline tests of fragments, transformations, source/review/CI/producer identity, archive/journal admission, the actual readable CLI adapter and every workflow sibling. `npm run check:release` validates fragments. Both remain in the full `check`; none of the original runtime, coverage, package or historical-fixture gates are removed. Tests inspect the final checkout/ref/permissions/command boundaries and execute the real helper adapter with offline API/IO fixtures. Those tests do not claim App installation, OIDC configuration or a hosted publication has been exercised.

The change parser validates only explicit `type` and `bump` declarations and selects the strongest declared bump. It does not infer a breaking change or migration text. The reviewer checks those semantics. Standalone verification uses the same exact pinned changelog-section and release-note comparison as the release writer; missing, duplicate or changed release notes refuse verification.
