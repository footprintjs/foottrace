# PROV-O JSON-LD export: proposed mapping and honesty boundary

Status: **design review required before implementation**. Nothing described here is implemented or published.

Baseline: Foottrace 1.5.0, main `7938e941956487b7fb2e30615c387f8410e14a3e`.
This proposes the optional, dependency-free `foottrace/prov` door for a future 1.6.0 release.
It changes neither the existing record format nor existing reader behavior. No merge, tag or publication is authorized by this note.

The input brief is `HANDOFF-FOOTTRACE-W3C-PROV-EXPORT.md`, dated 2026-10-18.
Its section 9 requires a design first and a stop for review when a mapping row is unclear.
The decisions below resolve conflicts between its suggested mapping and the current record.

## Decisions requiring review

| Decision | Proposed rule | Why the literal handoff mapping is insufficient |
| --- | --- | --- |
| Execution versus commit | One `prov:Activity` per scope and native runtime execution. Keep each commit index and continuation phase together in separate commit metadata. | A mount exit or fork repeat can commit again under the same runtime ID. One activity per bundle with an execution-only ID would collide. |
| Write occurrence versus value | One entity per recorded write row, identified by scope, commit index and row ordinal. Describe it as a recorded binding/write occurrence, with value availability stated separately. | Full encoding can contain multiple rows for one path in a commit, while the payload retains the final value. Intermediate values cannot be reconstructed from row count. |
| Candidate versus proven derivation | Export captured read-prefix and stage-level candidate links as `ft:possibleDerivation`. Do not assert `prov:wasDerivedFrom` solely from a read/output cross-product. | A prefix says a read occurred earlier, not that its value influenced the write. A custom qualifier cannot weaken a standard derivation assertion for other readers. |
| Redacted names | Use positional opaque IDs for redacted occurrences. Omit their path names, path fingerprints, values and value fingerprints. | The mapping requests path-derived IDs but the threat model forbids exporting redacted paths. Both promises need opaque identities. |
| Run and producer identity | Export known run/producer facts only from supported record metadata or explicit host descriptors. Omit missing facts and report gaps. | The generic record contract has no required run ID or producer. The exporter is not necessarily the runtime that executed the run. |
| Digest meaning | Hash only an unambiguously reconstructed, supported final JSON value. Withhold a digest when only a patch, intermediate write or uncertain basis is available. | An append tail or merge patch is not the complete value of a key as of a commit. |

The proposed vocabulary namespace is `https://footprintjs.dev/ns/foottrace#`.
This is a naming choice, not an HTTP resource fetched by the exporter. It can be changed before implementation.

## Standards boundary

PROV-O is a W3C Recommendation; the exact vocabulary namespace is `http://www.w3.org/ns/prov#`.
The serialization will be JSON-LD with an inline context. PROV-JSON is not the target format.
Documentation may describe a proposed export until the implementation is merged and its release is published.
It must not call this certification, full constraints validation or a released capability.

Primary references:

- [PROV-O and its qualification pattern](https://www.w3.org/TR/prov-o/#description-qualified-terms)
- [PROV-DM derivation](https://www.w3.org/TR/prov-dm/#term-Derivation)
- [PROV-DM invalidation](https://www.w3.org/TR/prov-dm/#term-Invalidation)
- [JSON-LD node identifiers](https://www.w3.org/TR/json-ld11/#node-identifiers)
- [PROV constraints](https://www.w3.org/TR/prov-constraints/)
- [JSON Canonicalization Scheme, RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)

JSON-LD expansion proves the intended terms and links are serialized correctly; it does not establish that recorded claims are true or that every PROV constraint holds.
Likewise a Python parser accepting a document is not, by itself, full constraints validation.

## Proposed public boundary

One public function, plus plainly named types, on `foottrace/prov` only:

```ts
const result = await exportProv(record, {
  base: 'urn:example:run:7f3a/',
  values: 'none',
  maxCommits: 4096,
});
// result: { document, gaps, complete }
```

The whole API is asynchronous because browser WebCrypto digesting is asynchronous.
`values` is `'none'` by default or `'digest'`; there is no raw-value mode.
The ordinary input is treated as unknown data and safely projected before existing readers see it.

Optional host descriptors must be defined before implementation for two separate needs:

- Additional already-loaded scoped records, each with its exact `LogAddress`, its own source and its own captured evidence maps. Reuse the existing `RecordScope` distinctions rather than accepting arbitrary new completeness booleans in a snapshot. A child never borrows a parent's maps or ending.
- Explicit producer/agent facts. The suggested `agents(activityIri)` callback is trusted executable host code; only its returned, allowlisted data is admitted. It must not return arbitrary JSON-LD. Agent kinds, IDs and optional labels need bounds and conflict checks. Callback determinism is a host responsibility; callbacks can perform effects which this data exporter cannot sandbox.

No loading callback, file path, storage locator or remote JSON-LD context is needed for this release.
The host loads and authorizes additional scopes before calling the exporter.
Missing child data becomes a `scope-boundary` or `unavailable` gap rather than an apparently empty complete child.

## Mapping

| Recorded fact | Output | Limits on the assertion |
| --- | --- | --- |
| Native execution | `prov:Activity`, scoped by exact log address and runtime ID | Admit the ID before using the codec. Historical seed/placeholder bundles must not become fictitious executions. |
| Commit/continuation | A separately identified `ft:Commit` metadata node linked to its execution | Keep `ft:commitIdx` and `ft:phase` on the same node. Preserve original indexes and encounter order. A continuation is not a second execution. |
| Write row | `prov:Entity` with `prov:wasGeneratedBy` referencing its supported native execution | The entity represents the binding/version identified by the write occurrence, not the metadata row itself. Its identity includes the original row ordinal. No intermediate value is implied. Withhold generation with a gap when the native execution cannot be established. |
| Delete row | A tombstone entity with `ft:deleted: true` | This represents an absence/binding-deletion observation. Do not infer that a historical value snapshot ceased to exist. Omit the optional `prov:wasInvalidatedBy` assertion in 1.6. |
| Read with an exact source | `prov:used` referencing the supported source entity or initial entity | Resolve before the execution's first commit using canonical read rules. Do not turn a nested/container basis into an exact one-row source. |
| Initial read | An initial entity only where the initial basis actually supplies that key | Missing base, absent key, readonly input or closure alternatives remain unknown with a gap. An unknown-origin entity is not proof that it was used as a known initial value. |
| Captured per-write prefix | Qualified `ft:possibleDerivation` node with `ft:attribution: 'reads-prefix'` | A temporal candidate set, not a proven semantic dependency. Empty captured prefixes differ from absent capture. |
| Stage-level read ceiling | Qualified `ft:possibleDerivation` with `ft:attribution: 'stage-level'` | Retain the existing `conservative` gap. Do not promote every candidate into a standard derivation. |
| Recorded governing decider | `prov:wasInformedBy` and a `prov:qualifiedCommunication` node | Use the existing same-scope, strictly earlier control-parent rule. Put `ft:relation: 'control'` on that qualified relation, not globally on the activity. |
| Untracked input | `ft:untrackedInput: true` and an `untracked-input` gap | Derivations can be incomplete even when recorded reads are present. |
| Redaction | `ft:redacted: true` on an opaque occurrence plus `redacted` gap | Suppress path text and fingerprints as well as values/digests for the affected path family. Also suppress ancestor-container digests. |
| Attention | Existing admitted kinds and evidence references, projected into `ft:attention` | Preserve missing versus captured-empty coverage. Do not pass through arbitrary objects or hidden path-bearing references. |
| Unreadable bundle | Document-level gap at its original index; no fabricated activity | Use the canonical replay refusal on a safe bounded projection. A refused bundle cannot become a healthy empty bundle. |
| Run | A run activity rooted in the caller's namespace, with known `ft:logRunId` only when supported | The namespace itself is not evidence of a native log ID. Missing identity is disclosed. |
| Producer/human agents | Explicit admitted `prov:SoftwareAgent`/`prov:Agent` facts and associations | Do not infer the producer from the exporter package, and never infer human approval. No made-up times. |

All IRI-valued links use `{'@id': iri}` or explicit `@id` coercion in the inline context.
Plain strings must not accidentally become RDF literals for `prov:used`, generation or communication links.
Qualified relation nodes hold edge-specific attribution; RDF properties themselves cannot carry per-edge fields.

Candidate derivation nodes use **only extension semantics**, for example:

```json
{
  "@id": "urn:example:relation:7",
  "@type": "ft:PossibleDerivation",
  "ft:source": { "@id": "urn:example:entity:1" },
  "ft:target": { "@id": "urn:example:entity:2" },
  "ft:attribution": "reads-prefix"
}
```

The generated target links to that node with `ft:possibleDerivation`.
Do not type a candidate as `prov:Derivation` or `prov:Influence`, link it with `prov:qualifiedDerivation`, or declare an extension subproperty which entails a standard proven derivation.
The JSON object above illustrates a graph node under the fixed document context; it is not a standalone context-bearing document.

### Read and value uncertainty

`keyTimeline` resolves writes at a strictly earlier commit because reads are pre-commit.
`buildCommitIndex` groups native executions at their first commit.
`buildKeyIndex` accounts for writes on, inside and around a key; `commitValueAtWithBasis` discloses nested, initial and redacted bases.
These rules are reused, not replaced with a new latest-row heuristic.
An empty `commitValueAtWithBasis(...).basis` proves neither a unique row source nor the time a read occurred.
For example, an anchored `cfg` followed by a child write can yield a fully reconstructed value with no basis warnings while still needing several rows to describe its provenance.
Likewise, a strictly earlier commit lookup does not distinguish an external value from a value read from the stage's own staged writes.
If captured ordering/version evidence cannot establish the asserted external or pre-run entity, withhold that version-specific `prov:used` edge, retain the read as extension evidence, and report the ambiguity.
Do not infer this proof from the absence of earlier committed rows: net-change filtering can hide staged writes.

Examples requiring an explicit gap:

1. Writing `cfg`, then `cfg`'s child `b`, then reading `cfg` does not make the child-row entity the whole container.
2. A stage can read `unused`, then write a constant. Even `reads-prefix` cannot prove a derivation from `unused`.
3. A stage can read its own staged write. Commit-level recording does not always identify the precise intra-stage value version.
4. Two full-mode writes to `x` can retain only the final payload. The first occurrence cannot receive that final value's digest.
5. An append payload can be only `[newItem]`, while the resulting key is `[oldItem, newItem]`.

The exporter will retain candidate evidence and name uncertainty rather than manufacture missing state or stronger edges.
Adding a verified derivation source in a later version can enable standard `prov:wasDerivedFrom` assertions without changing the meaning of this first release.

## Identity, ordering and determinism

Use disjoint ID families for run, execution, commit, write occurrence, initial entity, relation and host agent.
Every ID is scoped by the complete authorized log address; drill segments are actual mount runtime IDs, not guessed static subflow names.
Write occurrence identity includes commit index and row ordinal, even for repeated paths.

For public non-redacted paths, preserve the record's U+001F segments, including empty segments and literal dots.
Percent-encode every segment, including `%`, `/`, `#` and JSON-LD-looking text.
A length-prefixed segment encoding preserves empty segments without colliding with a literal placeholder.
Reject ill-formed Unicode with a gap rather than replacing different invalid strings with the same ID.
Redacted occurrences use positional IDs without any path component or digest.

Validate the caller base as an absolute HTTPS or URN IRI, with a defined suffix boundary and no credentials, query or fragment ambiguity.
It is a namespace only; nothing is dereferenced.
Deterministic encounter ordering, canonical numeric/string encoding and stable gap ordering replace clocks and random IDs.
With deterministic host facts, identical input and options produce byte-identical JSON serialization.

## Safe admission and bounded work

`isCommitBundle` is the compatibility validator, not an untrusted-object sandbox.
It currently reads fields normally and may stringify an invalid verb.
First construct a bounded descriptor-admitted plain projection, then call the existing validator and readers on that projection.
Do not tighten the historical hand-built record contract by requiring optional stage names or payload maps.
Do not call `freezeRecord` on caller-owned data.

Reuse `ownData`, `boundedList`, `spendFields` and `GapCode`.
Translate accessor/descriptor refusals into fixed gaps without reading their values or leaking thrown messages.
Descriptor reflection may execute a Proxy trap; JavaScript cannot sandbox arbitrary hostile executable Proxy code or trusted callbacks.
Thrown/revoked traps can be refused, but a trap which never returns needs caller isolation if hard execution limits are required.

Bound total work for scopes, commits, rows, tree nodes, reads, fields, relations, string bytes, digest bytes and final UTF-8 output bytes.
`maxCommits` defaults to 4096; all other boundaries need documented finite defaults and hard ceilings, not a new unbounded fallback.
Preserve original indexes when a row is refused. Reserve enough output space for a fixed truncation summary.
Limits produce existing gap codes and cannot yield `complete: true` after dropping evidence.

Default no-values mode must not walk unrelated payloads.
If a canonical nested-source reader needs payload data to establish an edge, either safely admit that bounded portion or withhold the edge with a gap.
Do not silently introduce a second, weaker nested-path rule.

Before the first await, crypto call or host callback, admit the correlated structural evidence into an owned snapshot: scopes, original indexes, rows, reads, coverage and redaction families.
Any value data required by digesting or canonical source resolution must also be safely copied into the same bounded owned view before it can be used.
Never validate a caller-owned redaction array and then reread a mutable value after an asynchronous boundary.
Host-returned agent facts get their own bounded admission snapshot before use; callback exceptions remain fixed gaps.
No output bytes can escape while a redaction decision for their covered scope is still pending.

Apply each scope's known redaction union across its covered exported history, including earlier occurrences of an affected path.
Suppress path text/fingerprints in IDs, gaps, relation nodes, read references and path-bearing attention references, as well as value digests at or around the affected family.
A child scope uses its own admitted redaction evidence; do not assume that identical path names in another scope share a privacy classification.
Absent scopes or uncaptured aliases remain gaps. Producer/host metadata such as stage names and labels must be suitable for export; the exporter cannot infer new secret classifications from arbitrary metadata text.

The byte limit applies to the entire returned envelope, including context, graph, gaps, completeness fields and any serialized summary, with a reserved fixed-size gap/truncation result.
Document and test the minimum accepted byte budget; an impossible trusted option is refused before exporting rather than returning an oversized supposedly bounded envelope.
Do not duplicate unbounded gap details in both `document` and `gaps`.

## Digest mode

Use browser WebCrypto SHA-256 without Node built-ins or new runtime dependencies.
If crypto is unavailable, return an `unsupported` gap for requested digests.
Implement documented RFC 8785-compatible canonicalization of admitted JSON data only, including number and property ordering rules.
Reject cycles, accessors, `toJSON`, unsupported instances, non-finite numbers and ill-formed strings; do not coerce them into different values.

A digest describes an exact supported final value, not the row's patch bytes.
Require a trustworthy replay basis with no relevant skipped history, supported reconstruction and no affected redaction.
Only a final unambiguous occurrence for a path can carry such a digest; earlier repeated occurrences carry a fixed gap.
Never fingerprint a redacted value, path or ancestor containing a redacted descendant.
There is no claim that unsalted digests anonymize public non-redacted data; digest mode is explicit opt-in.

## Completeness and gaps

Reuse the existing cause record coverage distinctions: source completion, captured reads, control, attention and their empty-versus-missing states.
Missing scope data, unsupported bases, redaction, conservative candidates, invalid data and every work limit remain named gaps from the one registry.
Gaps have bounded fixed categories and opaque references, never raw errors, secret paths or arbitrary input snippets.

An ordinary snapshot without supported native capture/end attestation is incomplete with `not-collected`, even when it ended normally.
A durable `closed` marker alone does not prove all instrumentation channels were collected.
Do not accept an arbitrary serialized `complete: true` as native proof.
An explicitly trusted host scope may supply existing coverage assertions only for that exact admitted scope and extent; future native metadata from FootPrint #111 requires deliberate supported admission.
`complete` means complete within this declared export contract, not complete business knowledge, semantic dependency proof or successful execution.

## Implementation plan after design approval

Keep small files for IDs, inline context, safe admission, output budget, mapping, relations, digesting and the async facade; add `src/prov.ts` as an optional door only.
Share canonical helpers at their existing owning layers rather than importing public entry points internally or copying causal algorithms.
Register every file in `scripts/layers.json`. No root-door re-export or runtime dependency is needed.

Before implementation, add failing tests for the approved contract: exact JSON-LD fixtures, repeated executions/rows, nested and initial reads, candidate versus proven links, opaque redaction, folded-value digests, getter/size/IRI attacks and every completeness distinction.
Use the dev-only `jsonld` package with a rejecting document loader to expand the output without network access; new lockfile changes must remain development-only.
Use fast-check for identity injectivity, deterministic output, one occurrence entity per admitted write row, resolvable reads and redaction safety.

Then run full Node22/24 tests, coverage, types, layers, lint, format, runnable examples, fresh ESM/CJS/strict declaration consumers, a browser bundle without Node built-ins and root-door tree-shaking.
Existing captured outputs remain byte-identical. Invalid-input bounds and package checks are not replaced by golden output snapshots.
Independent security review precedes separate code review on the final frozen source before any push or feature PR.
The owner's other agent reviews the final PR before any merge. Publication/version preparation remains a separate gated action.
