# C1: cause and impact over recorded dependencies

This packet implements the owner's HANDOFF-CAUSE-AND-IMPACT-v2, including section 9. Later engine stamping, Lens UI and agent tools stay in C2–C4. No release or merge is part of this PR.

## Boundary and threat model

Stored entries, graph responses, node identities, attention marks and evidence references are untrusted. No state value, raw error/message, opaque note payload, credential, customer or partner identity may enter output. Attention reasons are a fixed vocabulary; application rules select those reasons and reference their proof. IDs are non-secret names supplied by the host. Projection admits own data fields only, bounds every list/string and never invokes payload accessors. User-supplied graph methods/loaders are trusted executable code; cancellation is cooperative for synchronous callbacks, while asynchronous waiting is bounded and aborted.

A single query owns one deadline and node/edge/call budget, shared by reverse traversal, ranking and forward impact. Iterative cycle-safe traversal, per-query memoization and explicit coverage prevent hangs, cross-query state leaks and silent cuts. Rejections, cancellation, timeout, unavailable reads, missing provenance and invalid data become fixed gap codes, never raw provider errors. No library networking or business reruns.

Ordinary current-realm native Promise wrappers without an own constructor are trusted host control objects. Their resolved data remains untrusted. Exotic wrappers/thenables and their rejection handling belong to the host; the reader does not mutate wrappers or execute data accessors to observe them. Graph caches belong to one authorization domain, and a cache hit is never an authorization check.

## Semantics

The default root candidates are the earliest marked ancestors in the causal partial order: a marked node qualifies if no earlier marked dependency is reachable from it. Independent branches remain alternatives even with different timestamps or commit indices. Never choose a winner by ID ordering. Incomplete reverse evidence withholds rootCause. Confidence describes evidence coverage, not certainty about a provider's internal cause. A retry, quality drop or business rule is an observed mark, not semantic proof that it explains every downstream symptom.

Graph edges are recorded data or control dependencies. Structural containment is a navigation target, not automatically a causal edge. Record adapter identities include scope, execution/write position and optional written-key context, so reaching the same stage through different written values does not collapse per-write provenance. It reuses canonical backward/forward slice queries and flags conservative fallback. Node expansion loads one requested log; crossing unrelated services/runs remains deferred.

`attentionList` needs explicit nodeIds or optional host roots. It never pretends it can enumerate an arbitrary storage graph. Results are bounded references, marks and fixed gap codes; no full DAG object or record bundle is serialized.

## Acceptance

Red-first tests cover branching/ties, decider control, parallel/shared parents, loops, depth/node/edge/call cuts, incomplete records, per-write a/x/b/y and diamond contexts, overwritten value impact, scoped lazy storage, hung loader/abort, malformed/getter payloads, and no secret sentinel leakage. Full existing record bytes stay unchanged. Check ESM and CJS imports and actual unused-import tree shaking. Independent security review, fixes and code review precede push; then hand the PR URL/head SHA back to the owner and stop.
