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
- The owner sets public repository variables `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_SLUG` for that same App. The route authenticates App metadata and independently resolves the bot identity before checking the PR author; a branch name or display name is insufficient. The App may remain private.
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

## Refusal diagnostics

A failed control stage prints one bounded code from a closed vocabulary. Existing policy refusals such as `authority-approval`, `main-moved`, `security-job` and `journal-conflict` retain their meaning. Unexpected errors receive a fixed operation code, never an arbitrary Error message, stack, response body, route or credential. The terminal also safely refuses null, primitive and accessor-backed thrown values. Descriptor inspection can invoke a Proxy trap; a trap that terminates with an error is contained, but no progress guarantee is made for a nonterminating trap. Syntax/module-load failures before the runner starts, process termination and an unusable stderr stream may not produce a custom code.

Authority read contexts distinguish main, merge, linked PRs, PR/head, reviews, current reviewer permission, App/bot, package and final PR reread. For example, `authority-permission:github-http-forbidden` means that operation received HTTP403; it does not establish why the service refused it. HTTP categories distinguish401,403,404,409,422,429, server errors and other statuses. Transport, response/body, JSON and local IO failures have separate fixed labels; an unclassified loaded-runner failure uses `release-unexpected` or a fixed `operation:unexpected`. A diagnostic label is not proof of authority or of the historical root cause. A known-looking external label still rejects; it cannot make an operation succeed.

Private App metadata uses the existing App credential only inside the `authority`, `release` and `publish` control steps. After context and checkout validation, the exact configured App lookup lazily signs an RS256 JWT for the configured client ID and sends it only to `https://api.github.com/app`, with redirects refused. Its issued-at time is backdated 60 seconds and expiration is 60 seconds in the future; no installation token is created. Repository, bot, artifact and upload requests retain the ordinary workflow token. The same fresh metadata check remains in all three authority consumers, including the final release/publish checks. Missing or unusable credentials fail with a fixed `app-auth` diagnostic; HTTP and identity mismatches still fail closed. The App key and JWT are never emitted as output or written to artifacts, and the key is excluded from child Git environments and general stage inputs. Local tests generate unregistered synthetic keys; they do not exercise the real credential or prove hosted publication.

Direct local IO callers retain native errors such as an exclusive-write `EEXIST`; the runner also preserves the existing `dirty-checkout` diagnostic contract. Only those finite admitted labels reach terminal output, never native paths or details. Optional resource lookup treats only an own numeric404 as absent. Other errors remain failures. Unavailable CI evidence still selects both complete gate lanes; unavailable security or authority evidence never becomes success.

Failure does not imply an absence of effects. A prior artifact/output append or a partially completed remote write can survive a later failure. The runner stops without successful return or later work and does not delete, retry or reuse that evidence. Preserve failed attempts and partial outputs. Improved diagnostics do not authorize a publication retry.

A whole-workflow rerun before a reservation is an option only while the event source, current main and all original authority conditions still match. It loads helpers from that original event commit, not a newer diagnostic fix. After main advances, an old release run cannot satisfy current-main authority, and dispatch at a later code commit cannot borrow the old App PR's approval/tree. Verification-only is also tied to suitable current source. Hold historical-source recovery for a separately reviewed procedure; a normal future App proposal is a new reviewed release candidate. Never substitute a SHA, reset a journal, move a tag or reuse a stale artifact to make the failed release proceed.

## Readable helper and checkout boundary

Every control job checks out the current repository at literal `${{ github.sha }}` using the pinned checkout action with `persist-credentials: false`, submodules disabled and LFS disabled. The runner checks HEAD against that event SHA before API access. Only main push/dispatch reaches the release graph; a PR, branch name, workflow input or downloaded artifact never chooses helper code. Current-main and independent head/merge-tree checks still decide authority separately.

The workflow invokes the readable `scripts/release-runner.cjs` with one fixed stage. Its closed local module set is `release-github`, `release-app-auth`, `release-control`, `release-prepare`, `release-changes` and `release-archive`; these use only explicit Node built-ins. Control jobs do not run installs, npx, package scripts, local actions or downloaded executables, and setup-node's automatic dependency cache is disabled there. The existing read-only gates/build jobs retain their installs and full checks. Checkout never receives the App credential. The proposal's installation token is created afterward and exposed only to that proposal API step; the separate short-lived App JWT above serves only authenticated App metadata reads. Repository/job permission maps are unchanged.

The helper source and workflow share one trust root: the reviewed main event commit. This does not defend against an authorized malicious change to that commit or a compromised runner/action. It makes the executed program directly reviewable without pretending a self-authored checksum provides independent authority. No generator or encoded executable transport remains.

The publisher's checked archive is written to a fixed absolute run/attempt directory under RUNNER_TEMP, outside checkout. Only after that selection do the bundled npm version check and single submission run from that archive-only directory. The submission uses the exact file, `--ignore-scripts`, public access and an explicit npmjs registry; it never extracts/rebuilds the package or loads checkout-local project configuration. The pinned setup-node user configuration supports OIDC; no key/token fallback is added.

## Implementation checks

`npm run test:release` runs bounded offline tests of fragments, transformations, source/review/CI/producer identity, archive/journal admission, the actual readable CLI adapter and every workflow sibling. `npm run check:release` validates fragments. Both remain in the full `check`; none of the original runtime, coverage, package or historical-fixture gates are removed. Tests inspect the final checkout/ref/permissions/command boundaries and execute the real helper adapter with offline API/IO fixtures. Those tests do not claim App installation, OIDC configuration or a hosted publication has been exercised.

The change parser validates only explicit `type` and `bump` declarations and selects the strongest declared bump. It does not infer a breaking change or migration text. The reviewer checks those semantics. Standalone verification uses the same exact pinned changelog-section and release-note comparison as the release writer; missing, duplicate or changed release notes refuse verification.

## Unpublished current versions and retained proposal history

A process correction can reach main after the App's version PR has merged but before
that version appears on npm. Pending fragments must not silently skip that version.
The planner first classifies the **current** package version, keeping registry,
GitHub release, reservation and source evidence separate. A partial release or
uncertain response holds the route; it never deletes a marker or resubmits around
registry processing.

For an observed unpublished version, a recovery proposal is eligible only while
its original package inputs remain unchanged. The comparison covers complete Git
inventories, including build configuration, package/lock files, compiler inputs,
postbuild code, README, license, modes and unexpected additions. Only the finite
reviewed release-process differences and admitted nonpayload history are excepted.
A new runtime or packed-input change holds recovery. The normal archive build and
package checks still run on the new candidate; this comparison is not a promise of
bit-reproducible builds.

Recovery adds one canonical data record under
`.release/recovery/<version>/<sequence>.json` (`001` through `100`). The record binds
the repository, immutable proposal base, original and immediate predecessor App
PRs, prior record digest, and the complete queue of raw fragment bytes and modes.
It is descriptive evidence, not authentication. Existing records and queued
fragments remain immutable. A later process correction before publication adds the
next record; it cannot rewrite an earlier record to manufacture a PR delta.

The App creates a **new** release PR for that version. Its commit has ordered
parents `[current main, retained release head]`, and the existing release branch is
updated with `force: false`. This preserves reachable history, including a prior
squash merge's release head. It does not provide compare-and-swap or exclusivity.
A missing known prior ref, conflicting open PR, changed base/queue, invalid intent,
or ambiguous lineage holds before writes. An exact canonical open proposal is a
read-only no-op. A response lost after a write leaves its evidence in place; there
is no automatic rollback or retry.

Every new recovery head needs its own independent Claude verdict recorded publicly
before merge, current checks, and the real eligible User approval described above.
An old version PR or review never approves the new source. Current authenticated
App/client/Bot identity, reviewer permission and objection rules, CodeQL, trusted
producer artifacts, exact archive, unique reservation, current-attempt grant and
npm OIDC checks remain mandatory. The private App credential keeps its existing
three-step scope; preparation and historical verification receive no private key.

After publication, current helpers can verify an earlier immutable source as data:
registry metadata and downloaded archive bytes, peeled tag, exact release notes,
unique uploaded reservation, same-repository merged App PR/head tree, and complete
bounded ancestry to current main must agree. Historical helpers are never executed.
Only verified publication with matching `latest` permits a fresh normal preparation
of the next version, consuming its queued fragments. Old valid intent records stay
on main and become inert after the package version advances. A pinned selective
rerun cannot promote an old preparation artifact into a different phase.

Registry 404 and accessible missing tag/release responses are observations, not
proof that publication never occurred or no request is processing. This route uses
the existing trusted-main and cooperative reservation contract. It cannot detect a
fully erased marker or an otherwise invisible privileged history reset. Known
ambiguity holds for coordination; no extra control ref, historical Actions-run
absence proof, new credential, manual publication or reservation reset is added.
Unmanaged legacy publication without the complete witness requires separately
reviewed bootstrap evidence and is held rather than guessed.

## Source release candidates (npm next)

Dispatch `publish.yml` on main with **rc=true** and an explicit **bump**: patch, minor or major. The current stable version must already be published, main must still equal the dispatch SHA, and no open `release/next` proposal may exist. CodeQL must have completed successfully for that exact main push and its latest attempt; an unfinished run holds rather than polling.

An RC has no release PR. Its named source-authority decision replaces only the stable route's release-PR/tree/approval question; it does not waive source review, private App authentication, the current producer, archive binding, reservation or publish-grant checks. Both full Node gates run. The source package/lock remain unchanged: only a staged package version changes immediately before packing, with lifecycle scripts disabled.

The candidate uses the normal stable bump and the highest canonical matching `vX.Y.Z-rc.N` tag plus one (starting at zero). Fragments never choose the RC version. It creates an explicit source tag and a prerelease with `make_latest=false`, without creating a proposal, merging, deploying docs or re-dispatching. The inspected RC archive version selects explicit npm `--tag next`; stable publication passes no `--tag`, preserving npm’s own prerelease and implicit-latest downgrade refusals. Verification checks the actual registry package bytes, `next` at this RC, and `latest` still at the original stable version. Provenance metadata is not a claim of cryptographic verification.

Use **Re-run failed jobs** to repair a failed RC verification, never **Re-run all jobs**: rerunning plan selects the next candidate number. Read-only RC verification binds the original run ID and pinned source SHA, so the failed verification job can run in a later attempt after main advances. It grants no effects and still checks the original marker, exact source tag/release/notes, registry bytes and both npm tags. Missing release or version gets at most three GET reads with one-second intervals, then a named `rc-release-missing` or `rc-registry-missing` failure; it cannot go green on pending state.

An RC never adopts an existing tag, release or attempt marker for effects, even at the same SHA or in a later attempt of the same run. Every create must succeed strictly; a collision holds. Submission requires this run and attempt's own marker grant, the exact checked archive and fresh source/App/producer/security checks. A matching registry observation prevents another submission; a later absence cannot erase that observation.

An uncertain response stops that invocation without retry. Leave partial tags/releases/markers in place: a tag without an npm package is an expected burned candidate number. A fresh dispatch repeats every eligibility predicate and selects from current tags. While an older create is not yet visible, it may encounter the same number, but its strict create must win independently or fail and hold. An old response, a missing snapshot or a failed-run record never supplies a grant. There is no RC recovery/adoption path, cleanup or cross-dispatch admission journal.

Prepare the final release only after every downstream change is green against the candidate. If source changes, publish a new candidate first. Normal fragment preparation holds with `rc-final-target` unless its stable target matches the newest unpromoted RC core. Already-promoted RC tags do not block a subsequent stable patch. Release notes/fragments join the final train last.

An abandoned unpromoted RC core remains a named final-target hold: for example, a retained `v2.0.0-rc.0` prevents an ordinary patch final until the fragment target agrees. Finish that core, or the owner may delete its tag by hand only after verifying that no npm package was published under it. If a package was published, the final target must be at or above that core; coordinate the train disposition and downstream proof before preparing it. This is an owner action, with no agent deletion, force, marker overwrite, automated cleanup or publication retry authority. Removing a tag cannot undo a published npm candidate and may make a restarted number collide with the registry.

The release archive manifest must deep-equal package.json at the pinned source SHA except version; the first differing field is named (unknown field names are hashed). `npm run check` inspects a real lifecycle-disabled pack. `archive-profile` names unsupported USTAR prefixes, PAX or non-ASCII/long member paths; keep packed paths ASCII and under 100 bytes including `package/`. Gzip must be one flags-zero member with no trailing bytes.
