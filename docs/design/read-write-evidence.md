# Read occurrences and write contributors

Status: contract for review, with executable counterexamples. This document adds
no writer API, record field, format version or graph attribution. The existing
runtime and published package remain unchanged. A later implementation must be
reviewed in small producer, reader and consumer slices.

## The question being answered

A run already records values read and written. Its `writeProvenance:
'reads-prefix'` mode stamps each surviving write with the cumulative tracked-read
**key names** observed before it. Exact read-source capture separately identifies
the version observed by a particular read. Those are useful, different facts.

What remains missing is a canonical association from an individual write to the
particular completed read occurrences available before it. Such an association
would identify possible contributors more precisely. It would not establish
which JavaScript expression used a value.

```ts
// These have the same get(a, 41), set(out, 42) observations when a is 41.
const value = scope.a;
scope.out = value + 1;

const ignored = scope.a;
scope.out = 42;
```

A Proxy observes operations on its target; it cannot transparently attach an
origin tag to primitive locals or observe their arithmetic. A callback that
collects reads can also ignore them. Neither mechanism establishes semantic
derivation. The counterexamples in
[`read-write-evidence-contract.test.ts`](../../test/cause/read-write-evidence-contract.test.ts)
exercise the actual writer and graph doors. They are witnesses of current
capabilities and limits, not tests requiring a new public API.

## One owner for record rules

| Layer | Responsibility |
| --- | --- |
| Foottrace | Canonical record identities and types, generic frame/buffer writer machinery, limits, encoding, inert admission, cause/impact queries and PROV projection |
| Execution producer | Scope access hooks, native execution/attempt/control identity, lifecycle fences, retries/discard, capture policy, privacy and capture attestation |
| Hosting/provider adapter | Verified plain facts about call delivery, request admission, response or external effects, with explicit ownership and coverage |
| Tools and UI | Query and present admitted evidence without reconstructing dependencies or upgrading its meaning |

Keep these responsibilities behind existing public doors. Do not create another
linking package, duplicate graph walker or producer-local copy of a record rule.
Foottrace already owns `RecordFrame` and `TransactionBuffer` through
`foottrace/write`; it is not solely a post-run reader.

## Distinct relationships

| Evidence | Permitted claim |
| --- | --- |
| Exact source observation | This execution/attempt read this supported version or staged generation |
| Observed occurrence prefix | These completed reads were available before this write; they could have contributed |
| Recorded control | This evaluated decision selected this branch |
| Delivered call answer | This answer was handed to stage code; the bounded `readAttempts` window remains possible use |
| Verified host/service receipt | This identified request was admitted, queued, rejected, answered, or had the receipt's supported external effect |
| Declared computation inputs | The author declares these inputs; this is not independent proof of semantic use |

Do not promote a temporal prefix, a declared relationship or an activity's usage
into established entity derivation. Existing `GraphEdge` kinds/attributions and
the meaning of `readKeys` remain unchanged. In particular, do not relabel an
output's `stage` links as exact merely to produce a root. PROV usage and
`ft:PossibleDerivation` retain their current separation from
`prov:wasDerivedFrom`.

The current public graph can already answer an owning-execution question:

```ts
const selected = graph.nodeId(address, { runtimeStageId, commitIdx });
```

With authorized supported source evidence, it can return `recorded-read` edges.
A key-qualified output still has conservative ancestry. There is no public
read-occurrence selector in this contract; do not construct an internal node ID
or pass an invented `read: true` option. Exact state-source evidence also does
not repair missing call ancestry or prove a fault exists.

## Proposed writer association: meaning before representation

The first supported slice should cover unambiguous root-key writes and associate
each eligible surviving write with the completed read prefix observed in the
same execution, attempt and frame incarnation. Read identity includes the log
address, source segment and occurrence ordinal; owner and attempt must be
validated independently. A path is not a write-event identity. A write needs an
operation identity until native commit confirms its mapping to retained rows.

This is a description of facts, not a frozen TypeScript or wire shape. The writer
must mint associations at actual read resolution and staging, not reconstruct
them afterward from names, timestamps, equal values or a nearest-writer scan. A
mutable public origin registry or caller-selected committed label is not a
recorder authority.

The laws are:

1. Only completed observations can enter a prefix. A later read cannot become a
   predecessor of an earlier write.
2. Repeated reads of one key stay distinguishable, including reads of different
   source versions. Key-name membership alone cannot pick the right occurrence.
3. Prefixes are local to the execution/attempt/frame; interleaved frames cannot
   share a global last-read pointer. Discarded attempts cannot feed successors.
4. Observed empty, uncollected, redacted, unsupported, truncated and invalid are
   distinct. Missing evidence never means an empty complete dependency set.
5. A staged source needs a validated generation-to-confirmed-write join. Reverted,
   discarded, no-op or uncommitted generations cannot borrow a commit. Preserve
   the current unsupported gap until this join exists.
6. Full/delta compaction and repeated writes must say whether a retained row
   describes a single event or an aggregate. A last/union prefix on an aggregate
   is not one exact write's semantic inputs. Without a unique mapping, withhold
   the stronger association and state the gap.
7. Child, resumed, deep-field and composite ownership remain unsupported until
   their own producer/reader contracts and tests establish coverage.
8. Collection failure must not change the business value, rerun an accessor or
   replace the original read/commit exception.

Prefer a bounded immutable per-owner prefix handle with shared backing over
copying every preceding occurrence into every write. A global ordinal frontier
alone is insufficient under interleaving. Compare representations with an oracle
and measurements before choosing one: the first implementation must avoid
accidental quadratic retention. Bound occurrence books, write associations,
encoded bytes, admission work and emitted graph edges separately, with explicit
omission accounting. Defaults must follow measurements rather than this sketch.

## Errors, coverage and trust

The desired explanation supplements the original error with a supported recorded
fault source, path and gaps. The failing location is not automatically the root.
Use the producer's trusted failure identity; a retried or contained sibling error
cannot become the cause merely because it was the last error recorded.

Admission of a failed execution's closed capture extent is a separate producer
and consumer contract. It must preserve the failed outcome and prove which
attempts, commits, decisions and scope finished recording, including late-work
fences. Do not loosen a completion check in Foottrace to hide absent producer
attestation. A closed local extent does not prove that remote work stopped or a
customer received a response. Query only after the relevant boundary is closed;
mid-flight explanations remain partial. Storage acknowledgement is required for
durability claims and never supplies missing capture coverage.

Root selection retains complete relevant backward coverage and one eligible
recorded fault candidate as prerequisites. A prefix alone is not semantic proof;
multiple candidates remain alternatives and no fault evidence means no invented
root. Gateway responses, local deadlines and provider effects remain separate
facts. Chronological proximity, saturation and an idempotency-key string cannot
establish an outage, delivery or deduplication.

Structural validation, an unkeyed checksum, storage acknowledgement and private
in-process bindings do not authenticate a saved producer. A coherent storage
rewrite can pass consistency checks. Hosts must authorize source/tenant access
and state that trust scope. Resistance to deliberate rewriting needs a separately
trusted MAC/signature policy; this proposal adds no key-management system or
authenticity claim.

IDs, key names, topology and endpoint existence can disclose information without
values. Apply the existing capture/export/query privacy law and host
authorization to both endpoints and the evidence basis, including whole-channel
withholding where required. Keep fixed gaps when links are withheld. Presentation
references remain opaque; never repeat arbitrary provider error text, request
data or selected values. Do not add a parallel redaction policy.

## Implementation and acceptance sequence

1. Review this contract and its existing-behavior witnesses. There is no new API
   or runtime behavior in this slice.
2. Review failed-capture closed-extent admission separately, in producer then
   consumer dependency order.
3. Implement the bounded writer association with red-first tests, explicit
   format/semver planning, staged/compaction rules and cost measurements.
4. Integrate producer lifecycle/privacy through public writer ports, then teach
   the existing cause/impact/PROV adapters and consumers the new evidence basis.
5. Consider a limited library-owned computation evaluator only if a concrete
   consumer needs expression dataflow. A generic callback, boxed values or a
   compiler transform is not a small transparent Proxy improvement.

Default-off allocation/byte behavior, replay semantics and old `readKeys` meaning
must remain unchanged. Unsupported stored versions must stay unknown; public
union changes need a compatibility review. Measure enabled per-read/per-write
time, retained bytes, peak memory and save/reload/query cost as workloads grow.

Future red-first and mutation tests must cover ignored reads/constants,
read-after-write, repeated source versions, interleaved/foreign owners,
retry/discard, late callbacks, partial failed capture, staged/no-op/aggregate
writes, redaction, hostile accessors, future/cut-off/reordered or internally
inconsistent checksum-recomputed records, budget exhaustion and missing storage
receipts. Exact state ancestry with missing call ancestry stays incomplete.
Save/reload must preserve the same evidence classes. An internally coherent
rewrite must never be advertised as authenticated solely because it passed these
checks. Each changed runtime boundary needs independent security then code review
and a final-commit review before merge/publication.

## References

- [Current native source contract](../read-sources.md)
- [ECMAScript Proxy internal methods](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-proxy-object-internal-methods-and-internal-slots)
- [W3C PROV-O](https://www.w3.org/TR/prov-o/)
