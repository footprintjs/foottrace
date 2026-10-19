# P2 contract for Foottrace 1.7.0: proposal for review

Status: **design only; revised after the owner's external review**. This PR adds
no runtime capability, public export, version bump or release. P1 and P1.1 are
merged; published 1.6.0 remains the compatibility baseline. The changes below
record the requested demand order and person-label boundary; the revised contract
still returns for final review before implementation. Each implementation PR must
receive tests, independent security then code reviews, and final external review.

## Purpose and ownership

P2 plans three independently reviewed surfaces. Build **additional already-loaded
records first (P2.4)**, because AgentFootprint runs include sub-runs; then build
**explicit host agent facts (P2.3)** for recorded human and software associations.
Strict canonical JSON and opt-in final-value fingerprints (P2.1/P2.2) are deferred
until a real consumer needs them. They are not prerequisites for scopes or agents.
Release 1.7.0 after the chosen surfaces pass review; it need not contain all four
implementation packets.

The exporter translates captured evidence; it never reconstructs missing read versions, decisions, native
capture coverage or an unobserved ending. Those remain FootPrint #108/#109/#111/#113.
The LLM may explain supported facts and gaps; it is not part of this exporter.

Use [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) for canonical JSON and
[PROV-O](https://www.w3.org/TR/prov-o/) for standard vocabulary. RFC 8785 is an
Informational RFC; PROV-O is a W3C Recommendation. Neither implies certification,
semantic truth, anonymization or full PROV constraint validation.

## Proposed public boundaries

Only the chosen, independently reviewed surfaces enter 1.7.0. Deferred boundaries
below are design constraints for future work, not required release contents.

| Boundary | Proposed contract |
| --- | --- |
| `foottrace/canonical-json` (deferred P2.1) | `canonicalizeJson(value: unknown, limits?: CanonicalJsonOptions): string`, plus types and a fixed coded refusal. Pure synchronous owned-JSON admission and canonical text; no crypto, PROV, engine or root-door re-export. |
| `foottrace/prov` (deferred P2.2 addition) | Existing async `exportProv`; `values: 'none'` stays default, adding `'digest'` explicitly only with P2.2. No raw-value mode. |
| Host facts (P2.3) | Optional data-only `agents` and `associations` arrays; no executable callback or arbitrary JSON-LD. `allowPersonLabels: false` by default; explicit host opt-in is required to export person labels. |
| Extra scopes (P2.4) | Optional `additionalScopes` array of `ProvLoadedScope extends RecordScope`, with optional `initialState: unknown` admitted only for digest mode. No loader, URL, file path or automatic child-payload traversal. |

Existing calls, both P1 golden outputs and all old accepted-option cutoff behavior
must stay byte-identical. `values: 'none'` does not inspect payload members or
initial values, consult crypto, add digest gaps, or spend value-admission budgets.
New options get strict own-data admission; unknown fields and impossible limits
retain fixed coded option refusals. The existing record/cause contracts stay intact.

AgentFootprint's existing `afp-cjson/1` is a different, public audit-byte contract:
its `src/lib/canonicalJson.ts` calls `toJSON`, converts nonfinite numbers to null,
and omits unsupported members. Its audit writer and verifier depend on those
bytes. Do not replace it, relabel its hashes as RFC 8785, or invalidate old bundles.
Foottrace owns the new strict implementation; future AgentFootprint reuse requires
a separately reviewed explicit new format/mode, preserving historical verification.

## Strict canonical JSON — deferred P2.1

Accept null, booleans, finite binary64 numbers, well-formed strings, dense arrays
and plain/null-prototype objects containing only admitted JSON members. Reject
unsupported primitives/instances, accessors, holes, cycles and unsupported own
members without invoking getters, coercion or executable `toJSON`. Shared acyclic
references are allowed but charged at every expanded occurrence. Preserve ordinary
string keys such as `__proto__` using owned null-prototype data, not unsafe assignment.

Copy descriptors and bounded values before serialization; do not freeze callers.
Canonical text must sort raw names recursively by UTF-16 code units, preserve array
order and Unicode spelling, serialize finite numbers/strings per RFC 8785, and
encode UTF-8 for hashing. `-0` becomes `0`; finite numbers are not rejected merely
for exceeding the safe-integer range. Emit sorted member text directly: sorting
an object then JSON-stringifying it reorders integer-like names incorrectly.

Never return a partial canonical string. Refusals have fixed codes/messages,
without raw exception text, value snippets or path names. Limits bound depth,
expanded visits, fields, key/string bytes, sort work and canonical UTF-8 bytes.
Descriptor inspection may execute Proxy traps; thrown traps are refused, while
hard isolation from a trap that never returns remains the host's responsibility.
The standalone utility returns raw canonical text; it is not a redactor or sanitizer.
This API receives JavaScript values: duplicate raw JSON names and numeric precision
already lost during parsing cannot be recovered. It is not a JSON-text validator.

## Digest eligibility and snapshot ownership — deferred P2.2

Digest means SHA-256 of RFC-8785 canonical UTF-8 bytes of a complete supported
value **at the end of that commit**. Attach only to the final eligible occurrence
for that path in the commit, never an earlier repeated write. Account for same-commit
ancestor and descendant writes; last exact-row lookup is not sufficient.

Build one bounded owned value/replay snapshot synchronously, before the first
await or crypto access. P1's structural admission deliberately projects payload
maps to empty objects and has no initial state: do not reuse that projection as
if it contained values. Preserve refused/truncated history separately from the
placeholder bundles, which must never become evidence of a complete replay.

Use `commitValueAtWithBasis` and the canonical path/verb rules on admitted owned
replay data. A digest needs a supported final JSON value, no relevant missing
history or payload, an unambiguous occurrence, and full privacy clearance. An
empty `basis` list alone does not prove this after skipped commits. Missing bases,
intermediate values, deleted/undefined values and unsupported reconstruction get
fixed gaps, never a guessed digest. Raw append tails and merge patches cannot be
hashed as complete values. Begin conservatively: only final `set` occurrences with
complete anchored reconstruction; merge/append occurrence digests stay unsupported
in the first digest release. Any later expansion needs its own eligibility proof
and review. Digest work is not required for 1.7.0.

Preflight eligibility and privacy for every requested candidate before crypto.
Unknown privacy withholds every digest in that scope. Redaction at, above or below
a candidate suppresses its name and fingerprint, including ancestor containers;
late marks still cover earlier occurrences. No raw values leave the exporter.
After admission, mutating the caller during an await cannot change what is hashed.

Use browser WebCrypto SHA-256 without Node built-ins or runtime dependencies.
Emit `ft:valueDigest` as `sha256:` plus 64 lowercase hexadecimal characters and
`ft:valueCanonicalization: 'rfc8785'`; retain the existing no-raw-value indication.
Same admitted input gives the same canonical bytes and digest across module formats
and runtimes. A digest is a value-comparison aid, not a signature, approval,
proof of execution, proof of semantic dependence, or anonymization.

Keep the structural phase first. Then admit eligible value data before any await,
hash it and append bounded annotations only for entities already emitted; do not
mutate a node after its output size was charged. As with existing candidate links,
annotations may repeat an entity `@id`; document JSON-LD node merging for plain
JSON readers. Missing crypto or a rejected digest operation produces a fixed
`unsupported` or `unavailable` gap without discarding structural output already
admitted. Use a bounded sequential driver;
charge total canonical/hash bytes before invoking crypto. Race each digest against
a host-configured wait limit; a timed-out result is ignored, never emitted later.
WebCrypto cannot be cancelled, so the driver stops scheduling new digests after a
timeout; this bounds waiting, not the underlying platform's computation lifetime.

## Host agent descriptors — second, P2.3

An agent has `id: string`, `kind: 'software' | 'person' | 'organization'`, and an
optional `label: string`. Map kinds to `prov:SoftwareAgent`, `prov:Person` and
`prov:Organization`. **Person labels are personal data and are absent from output
by default**, including when supplied by the host. The host option
`allowPersonLabels` defaults to `false`; only explicit `true` permits emitting an
admitted person label. The host must be entitled to export that personal data.
The option is not evidence of consent or authority, and the exporter must not
invent either. Recommend opaque IDs and no person labels; IDs themselves must
also be suitable for export. A person without a label is a valid descriptor and
exports normally. A withheld person label must not reappear in IDs, gaps or other
metadata. Software and organization labels remain optional host metadata.

Generate IDs in a disjoint exporter-owned agent namespace
from admitted opaque IDs; do not accept host JSON-LD, external graph IDs or extras.
An association contains `agentId`, `runtimeStageId`, and optional exact `address`.
Omitting address selects the root only. An explicit address must match exactly one
admitted scope; the execution must already exist. Never create an activity to fit
an association. Emit only `prov:wasAssociatedWith`, not approval or action success.

Fully admit both identity sets within bounds before emitting any agent or association.
If an identity is unreadable or either selection is truncated, withhold the entire
host-agent phase with a fixed `invalid-data`/`truncated` gap; keep structural output.
This prevents a conflicting descriptor in an unseen tail from making first-wins claims.
Exact duplicate agent descriptors coalesce; conflicting descriptors with the same
ID withhold that identity and all its associations with an `ambiguous` gap. Exact
associations coalesce; dangling references get positional fixed gaps. Preserve
first encounter ordering. Person-label opt-out does not relax descriptor admission
or conflict checks. Labels allowed by the host policy are declared metadata; they
are not verified identities and cannot prove consent, authority or approval.
No secret classification can be inferred from arbitrary label text. Snapshot and
validate all descriptors before any await; callback exceptions cannot exist here.

## Additional loaded scopes — first, P2.4

Reuse `RecordScope` address, commit-log and absent-versus-empty map distinctions;
do not reuse a weaker loader admission path or trust its `complete` boolean as
native attestation. `ProvLoadedScope.initialState` is optional unknown data, copied
only when needed by digest mode. Each scope keeps its own privacy/capture maps and
extent. Parent evidence, identical path names or a drill-path prefix never prove
child coverage, an ending, or a causal edge between scopes.

Admit addresses for the entire requested selection before output. Process root
first, then additional scopes in caller order, into one envelope and one total
allowance. No reset of field/work/row/node/relation/string/output or digest budgets.
Reject duplicate addresses conservatively: withhold every colliding scope and
emit a fixed ambiguity gap rather than trusting first-wins privacy. If selection
identity admission is truncated or unknowable, fail closed on path and digest
disclosure across the selection, because an unseen address might collide.

A declared but unloaded/rejected child remains a `scope-boundary`/`unavailable` gap.
A scope-boundary gap may be removed only when exact address admission establishes
that the requested child was actually exported. Do not infer this by matching a
stage label. Additional records are not automatically connected: no standard
cross-scope read, derivation or communication link without native supporting facts.
`complete` remains false for ordinary snapshots, including `complete: true` input.
FootPrint #111 and deliberate reader adoption remain a separate prerequisite.

## Proposed finite limits

All new limits have positive finite defaults and hard ceilings, validated before
work. Existing limits retain their defaults and cover totals across all scopes.
These numbers are proposed ceilings, not performance measurements. Value and
digest limits enter only with deferred P2.1/P2.2; scopes and agents do not depend
on those options or their implementation.

| New PROV limit | Default | Hard ceiling | Charged resource |
| --- | ---: | ---: | --- |
| `maxValueBytes` | 1 MiB | 4 MiB | Owned admitted value bytes across the selection |
| `maxDigestBytes` | 1 MiB | 4 MiB | Canonical bytes submitted to crypto, cumulatively |
| `digestTimeoutMs` | 1000 | 10000 | Maximum wait per digest; stop the digest phase after timeout |
| `maxAgents` | 128 | 4096 | Agent descriptors, including rejected/duplicate attempts |
| `maxAssociations` | 1024 | 16384 | Association attempts |
| `maxScopes` | 16 | 64 | Root plus additional scope attempts |

Standalone canonical JSON reuses the current finite defaults/ceilings for depth,
fields, nodes, work, string bytes and output bytes in its own options type. Inside
PROV, use the same internal implementation with a shared budget adapter, never a
fresh standalone allowance per value. Charge bounded reflection/sorting, replay,
canonicalization and output work; cap gap space within the existing envelope.

## Small PR sequence and acceptance gates

| PR | Deliverable | Required new proof before implementation review |
| --- | --- | --- |
| P2.0 (this PR) | Contract, trust boundaries and sequence only | Unchanged runtime/package and both existing goldens; no capability claim |
| P2.4 — first | Loaded scope selection | Shared caps, address collision/truncated selection, missing children, independent privacy/maps/extent, no implicit cross-scope causality |
| P2.3 — second | Host data descriptors | Unlabeled person exports normally; supplied person label absent by default and when opted out, explicit opt-in only, conflicts beyond the descriptor cap, unreadable IDs, duplicate/dangling associations, scope isolation, hostile labels, no invented consent/approval/producer |
| Release | Separate 1.7.0 paperwork after the chosen surfaces pass all reviews | Version/lock/changelog only, exact-head checks, publish then fresh registry consumers; no dependency on deferred P2.1/P2.2 |
| P2.1 — deferred until a real consumer | Shared strict canonical JSON and owned admission | RFC sample bytes, Appendix B numbers, Unicode and integer-name ordering, getters/holes/cycles/Proxy refusals, every limit, strict dual-format/browser door |
| P2.2 — deferred, after P2.1 and a real consumer | Opt-in digest integration | Eligible final sets versus intermediates/patches/skipped history, ancestor/descendant writes, late privacy, mutation during await, absent/rejected/hung crypto and exact digest vectors |

Packet numbers retain their original design references; they are not build order.
The current order is **P2.4 → P2.3**, with each PR reviewed separately before the
next starts. P2.1/P2.2 wait for an audit-comparison or data-reference provenance
consumer rather than blocking either current packet or the 1.7.0 release.

For each code PR: write tests red first, full Node22/24 checks and coverage,
unchanged default/no-values golden and tight-cap differential probes, fresh packed
CJS/ESM/strict TypeScript/browser consumers, independent SECURITY then CODE review,
then PR and stop for the owner's other reviewer. Keep zero runtime dependencies
and root-door tree shaking. In the next code packet, also document that
`ProvCommitContext.hides` must be side-effect-free: no budget spending or I/O.
Leave speculative live-fact
precomputation alone. P3 live delivery still waits for a real consumer and review.
