# Evidence requirements

This L0 leaf owns the single `GapCode` registry, shared own-data/list admission,
and reference-only requirement records. It imports no engine, graph walker,
storage host, provider or platform runtime. Cause readers consume this leaf;
root requirement imports do not load the optional cause algorithms.

`RequirementResult`, `RequirementCheck`, `RequirementCheckDisposition`, `RequirementReason`,
`readRequirementResults`, `RequirementValidationError` and
`REQUIREMENT_RESULT_LIMITS` have one public door: `foottrace`. `GapCode` retains
its existing named type export on `foottrace/cause`. `RequirementReason` is the
narrower producer-facing subset, derived from membership in that same registry;
neither the type nor its reader requires a runtime cause import. The registry
and admission helpers stay private.

## Structural law

The reader admits plain current-realm objects (including null-prototype records)
and ordinary arrays, through own data descriptors only. It rejects unknown keys,
accessors, inherited required fields, custom prototypes, sparse or expanded
arrays, malformed discriminants, duplicate result IDs and duplicate references
within a list. Check references are unique within one result; a real lookup or
attempt can support several different results. The schema has fixed depth;
cyclic contract data is rejected rather than traversed. The input is never
mutated or frozen. The output is a detached, deeply frozen projection.

Admission is atomic: a malformed or oversized batch throws
`RequirementValidationError` with fixed message `REQUIREMENT_RESULTS_INVALID`
and code `invalid-data` or `node-limit`. No partial batch, raw value, originating
exception or business payload is returned. Identifier strings must be nonempty,
have no whitespace or control characters, and be at most 512 UTF-16 code units.
Optional `detail` is a namespaced adapter identifier such as
`storage:workload-inventory`, never explanatory prose. Identifier grammar cannot
detect secrets: producers must supply non-secret references only.

Fixed per-call ceilings are 512 results, 16 checks per result, 32 affected claim
references and 16 evidence, attempt or action references per list. One aggregate
budget covers 32,768 object fields and array slots (including array lengths) and
1,048,576 identifier code units across the batch. It accommodates 300 independent
finding/claim bindings without paging. It refuses overflow instead of truncating.
These are in-memory admission bounds, not serialized byte or transport limits;
the host also bounds received bytes. Native metadata operations and executable
Proxy traps cannot be preempted by a synchronous JavaScript validator. No getter,
iterator, `toJSON` or arbitrary payload callback is intentionally invoked.

## Assertions and trust

`requirementRef` identifies the requirement definition or policy; `id` identifies
this result. The containing artifact reference/path is supplied by the host's
resolver after storage, not self-referenced before its reference is minted.
`findingRef`, `windowRef` and `affects` express bindings; this reader does not
resolve them or decide whether they belong to the caller.

`state: 'satisfied'` and the four existing check dispositions are assertions from
a producer. The reader checks their shape, never their truth. It does not infer a
result from check counts, invent an attempt, or manufacture evidence. Empty
checks and actions are valid, including on a structurally satisfied result; that
record has no authorization standing from structural admission alone.

Before allowing a factual claim, the host must authenticate the producer and
verify artifact integrity, current query/run/caller scope, expected requirement
membership, evidence provenance and the domain verdict. A satisfied receipt
cannot override another applicable unresolved receipt affecting the same claim.
Unresolved evidence blocks only the dependent conclusion; independently supported
facts survive. Claim enforcement belongs to the consumer, not this reader.

`validTimeRef` and `learnedTimeRef` deliberately stay separate. Their absence is
unknown, not automatically stale. The producer decides whether evidence applies
to the finding window; the reader does not compare clocks, infer freshness or
interpret corrections. `actionRefs` refer to an app-owned closed registry of
real tools and bounded arguments. Resolving a stored reference never grants
permission to invoke it; the host checks scope and permission at execution.

## One reason vocabulary, distinct meanings

The `RequirementReason` subset contains exactly the twelve domain-evidence codes
shown below. Both result and check reasons use this subset; traversal/admission
codes such as `cycle`, `node-limit`, `edge-limit`, `call-limit` and
`strategy-failed` are refused in these fields. Generic cause gaps and
`RequirementValidationError.code` retain the broader `GapCode` vocabulary.
Membership and both runtime predicates derive from the one canonical registry.
Existing `HonestyCode` reader diagnostics remain unchanged. An adapter may retain
its more specific meaning in a namespaced `detail` and reference the actual
check/attempt evidence.

| Code | Producer meaning; never inferred by structural admission |
| --- | --- |
| `not-checked` | Required proof has not been checked; do not invent an attempt. |
| `not-collected` | The required evidence was not collected. |
| `no-match` | A completed bounded query or lookup found no subject/match in its checked scope; no proof that a physical relationship does not exist. |
| `ambiguous` | The checked evidence does not select a single supported result. |
| `stale` | The producer's domain policy established staleness. |
| `incompatible` | The evidence does not fit the requirement. |
| `unavailable`, `timeout` | Evidence could not be read, with the actual read outcome retained. |
| `invalid-data` | Evidence failed admission or a domain check. |
| `unsupported` | This evidence/check is not supported by the producer. |
| `not-permitted` | Policy denied a required check or evidence read. |
| `redacted` | Content was withheld; do not reconstruct or reveal it. |

The other existing codes retain their trace coverage and bounded traversal
meanings. A cause adapter can carry requirement/check evidence references in a
gap; this packet does not add a second walker, perform domain lookups, connect
cross-window topology or change stored execution record bytes.
