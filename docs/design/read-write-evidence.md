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

## Relation, coverage and presentation

These dimensions remain independent. An exact endpoint identity does not change
the meaning of a relationship; complete observation coverage does not establish
expression use or the cause of a selected failure.

| Relation and basis | What coverage can establish | Root eligibility and presentation |
| --- | --- | --- |
| Exact source observation (`recorded-read`, recorded source) | This execution/attempt observed this supported version; all relevant native observations may be enumerated | Existing generic queries may localise supported attention in this execution ancestry. Present an observed source, never a proven input of each output or a semantic failure cause |
| Legacy per-write key prefix (`per-write` without exact sources; `stage` with exact source adapter) | Key names tracked before staging; repeated occurrences and expression use remain unknown | Preserve current attribution and gaps. A `per-write` name describes recorded key provenance, not proof of semantic derivation; `stage` remains conservative |
| Proposed occurrence prefix (possible contributor; no new public attribution yet) | Exactly the completed observations available before this particular surviving write, with operation kind, owner/incarnation and omission status | Even a fully enumerated prefix remains possible use. Keep output attribution conservative and withhold a semantic/root promotion based solely on this new association |
| Recorded control (`recorded-control`) | This recorded evaluated decision selected this branch within covered control boundaries | May support the existing generic attention path; does not prove a provider fault or unrecorded condition |
| Delivered call answer (`readAttempts` possible-use window) | This identified answer reached stage code; bounded window and omissions are explicit | Preserve possible-use and absent call-ancestry gaps; neither delivery nor prefix membership proves use by an output |
| Verified host/service receipt (adapter-owned fact) | Only the admitted issuer/operation/attempt claim: admission, refusal, committed response, delivered answer or supported effect | Independently reviewed eligibility and scope; local deadline, gateway 504 and eventual external effect stay distinct |
| Declared computation inputs (author declaration) | The supplied declaration, not independent verification of use | Label as declared; do not promote to observed or semantic derivation |
| Missing, redacted, unsupported, invalid or truncated evidence | A fixed gap in the relevant relation/channel, never a complete empty set | Withhold unsupported root conclusions, retain admitted alternatives and gaps |

PROV activity usage and `ft:PossibleDerivation` remain distinct from
`prov:wasDerivedFrom`. Do not export a prefix, declaration or activity usage as
established entity derivation. Existing `GraphEdge` unions and `readKeys` meanings
remain unchanged in this contract-only slice.

### The attention policy is part of the question

The current generic `explain` default selects the **earliest supported attention**
in recorded dependency order. It excludes `not-collected` as a candidate, but is
not error-only: an `outlier`, `retried`, `quality-drop` or other admitted mark may
be returned as `rootCause` when there is one candidate and complete backward
coverage. Tied candidates remain alternatives. A custom public `rankRoots` may
choose only from admitted supported marks; name that strategy in presentation.
Neither rule establishes semantic causation.

For a selected-failure consumer, the host must explicitly bind the selected
terminal failure to its execution/attempt and define eligible failure attention.
A handled retry or contained sibling error is not automatically that terminal
failure. Use producer-authorized failure identity and relevant ancestry; do not
select the last recorded error, a nearby timestamp or a marked unrelated source.
If recovered/retry/outlier marks are retained under the generic policy, label the
result as earliest recorded attention. A failure-specific policy must be named
and tested separately. No runtime mark filtering is added here.

The marked ignored-read/constant-write witness is intentional: the generic
execution query can return the source's outlier attention even though that value
was ignored. The output query still returns conservative ancestry and no root.
New prefix links must not make that output produce a semantic failure root merely
because its candidate set is complete and its references are precise. Also keep
handled-retry, unrelated sibling and partial failed-capture counterexamples.

## A concrete selected-output consumer boundary

A tool investigating a producer-authorized failure selects output `x` of its
owning execution using only the existing public API:

```ts
const selected = graph.nodeId(address, { runtimeStageId, commitIdx, key: 'x' });
const parents = await graph.parents(selected, { signal: controller.signal });
const finding = await explain(graph, selected, {
  includeBackward: true, signal: controller.signal,
  maxNodes: 16, maxDepth: 8, maxEdges: 32, maxCalls: 64, timeoutMs: 1000,
});
// The owning execution is a separate supported view:
const execution = graph.nodeId(address, { runtimeStageId, commitIdx });
```

Direct graph methods require `GraphContext` (`{ signal }`); `explain` owns its
query context from the options. There is no public read-occurrence selector, no
`read: true` option and no internal-ID construction in this contract. The fixture
uses explicit adapter bounds too: 16 commits, 20,000 fields, 16 edges per adjacency
and one scope. These are experiment bounds, not new production defaults.

Use this event order in one owner/attempt/frame incarnation:

```ts
const old = readWithSource('a'); // read:1, committed a@old
write('x', old.value + 1);       // staging boundary X
write('a', 99);                 // native staged a@new in the current witness
const newer = readWithSource('a'); // read:2, staged a@new
write('y', newer.value + 1);     // staging boundary Y
```

This pseudocode names events, not a proposed writer signature. The executable
witness uses public `RecordFrame.readWithSource`, `noteRead`, `write`, `commit`
and `release`, then public graph queries. A second witness omits the update to
`a`, keeping both reads on the same committed source to isolate occurrence
association from staged-source admission.

| View | Current expected explanation | Acceptance after a separately reviewed association implementation |
| --- | --- | --- |
| Owning execution | Both supported read occurrences have `recorded-read` edges; current staged source retains `unsupported`. This already answers which supported sources the execution observed | Same observation meaning. If this satisfies the consumer after failed-capture admission, stop without adding another channel |
| Selected `x` between reads, same committed version | Both `read:1` and later `read:2` appear under `stage`, with `conservative`; root absent despite the selected error mark | `x` can exclude `read:2` by its native staging boundary. Present `read:1` as a possible contributor; preserve conservative semantic interpretation/root withholding |
| Selected `x` between old/new versions | Current output has old-source `stage` ancestry plus later staged-source `unsupported` and `conservative` gaps | Exclude the later occurrence from `x`'s relevant prefix. This does not resolve staged `read:2` for `y` or erase unrelated/global coverage gaps |
| Selected `y` after both reads | Key prefix is only `['a']`; output remains conservative and staged-source support is absent | Both occurrences remain possible contributors. A staged-generation-to-confirmed-write join is an independent gate |
| Both `x` and `y` written after both reads | Both outputs share `['a']`; distinct occurrence identities do not assign primitive locals to outputs | Both prefixes contain both reads. No useful exclusion or expression-local choice is claimed |

The benefit oracle is **one fewer impossible later occurrence for `x`**, without a
new semantic root. It is not a claim that `y` used only the newer local. The tests
assert only current behavior and detached plain `RecordScope` JSON reopen
equivalence; they do not fabricate a future graph relation or new saved format.
The finite host-supplied selected-error mark tests the public query boundary,
not a failed producer's terminal capture contract. Producer closed failed-capture
attestation and its consumer admission remain the first missing boundary for an
actual failed run. Re-evaluate the existing execution view after that work before
paying for output-level association.

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
   predecessor of an earlier write. Completion is an event, not an ordinal bound:
   reserve outer ordinal 1, complete reentrant ordinal 2, stage X, complete 1,
   stage Y gives X=[2] and Y=[2,1]. An immutable per-incarnation completion book
   must preserve that order; `ordinal <= max` is unsound even for one owner.
   The public synchronous privacy callback is documented as pure and name-only;
   re-entering or writing through it violates that contract. Its adversarial
   witness demonstrates a reachable robustness boundary, not newly supported
   callback behavior. Refuse or withhold unsupported evidence rather than granting
   it authority. Check the original owner/attempt/frame incarnation again after
   callbacks return; replacement, discard or closure cannot lend the pending read
   to a successor. Historical handles remain unchanged after later completions.
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
   their own producer/reader contracts and tests establish coverage. Root-key
   destinations alone do not prove input coverage: a held nested handle can read
   a later silent live view. Preserve `composite-unsupported`/unknown-view gaps
   across writes, deletion, raw array callbacks and intentionally unwrapped
   objects; never reuse an earlier root version as an exact later field source.
8. Collection failure must not change the business value, rerun an accessor or
   replace the original read/commit exception. Cover thrown reads/callbacks,
   discarded/replaced frames during reentry and failure at capture, save,
   admission and query boundaries; keep existing wrapper behavior, error object
   identity/code/stack/cause and callback count under existing privacy rules.
9. Preserve operation kind. Value reads, membership tests, listing and descriptor
   inspection have different answers; a listed key does not prove value delivery.
   Preserve published absent/undefined membership semantics. Test Reflect.has,
   Object.keys, descriptors and spread without adding probes solely for logging.
10. Define completion at the supported writer/native-resolution API boundary.
    A retained native read is not proof that an enclosing Proxy operation passed
    later language invariant checks or delivered its result to application code.
    Keep unsupported reflection outside coverage; do not infer apply/construct,
    defineProperty, prototype or extensibility support from ordinary get/set.

Prefer a bounded immutable per-owner prefix handle with shared backing over
copying every preceding occurrence into every write. A global or per-owner
numeric frontier is insufficient under reentrant completion. Compare candidate
encodings against an oracle of successful completion events before each staging
event, grouped by address/segment/execution/attempt/incarnation. The existing
callback witness completes [2,1] while snapshots sort ordinal identities [1,2];
it validates the hazard, not a new completion-book implementation.

Inert saved admission applies to trusted parsed/serialized plain data. Descriptor
inspection of an arbitrary live Proxy can itself execute code; do not claim that
a caller-supplied executable object is inert or add reflective probes to it.

## Errors, coverage and trust

The desired explanation supplements the original error with a supported recorded
fault source, path and gaps. The failing location is not automatically the root.
Use the producer's trusted failure identity; a retried or contained sibling error
cannot become the cause merely because it was the last error recorded.

Capture extent and execution outcome are independent:

| Execution outcome | Relevant capture extent | Permitted claim |
| --- | --- | --- |
| Failed | Closed and producer-attested | Admit the supported local failed extent through an independently reviewed consumer contract; outcome stays failed |
| Failed | Open, missing or partial | Preserve failure and explicit capture gaps; no complete explanation |
| Completed | Closed, with channel coverage | Only the attested supported extent is complete |
| Completed | Missing, unsupported or partial | Preserve completed outcome and incomplete explanation; success does not create evidence |

Before failed capture can be admitted, the producer must define an immutable
owned extent: exact address/segment, execution/attempt/incarnation, retained
commits/staged dispositions, decision/attention/read channels, omissions and the
closure boundary. Conceptually open capture becomes closing, then either closed
with those facts or incomplete with fixed gaps; this is not a frozen enum/API.
Fence late callbacks, queued work, retries and sibling continuations so none can
mutate a closed extent or borrow its completion claim. Query only after that
relevant boundary, or keep mid-flight coverage partial. Neither `RecordScope`
`complete: true`, the result enum nor a storage receipt supplies missing producer
attestation. Do not loosen a completion check to hide that absence.

Local closure does not prove that remote work stopped, that all siblings ended,
or that a customer received a response. Preserve unresolved external work;
later adapter receipts are separately owned/scoped evidence, not mutations that
turn a failed outcome into completed. Storage acknowledgement supports durability
only. Capture/save/admission/explanation failure supplements the business error
with fixed gaps and must not replace it or replay computation.

Generic root selection retains complete relevant backward coverage and a unique
supported attention candidate under its named strategy. A selected-failure
consumer additionally needs its explicit failure-attention policy and supported
relation meaning. Prefix completeness alone never supplies semantic fault proof;
multiple candidates remain alternatives and absent eligible evidence stays
unknown. Gateway responses, local deadlines and provider effects remain separate
facts. Chronological proximity, saturation and an idempotency-key string cannot
establish an outage, delivery or deduplication.

Structural validation, an unkeyed checksum, storage acknowledgement and private
in-process bindings do not authenticate a saved producer. A coherent storage
rewrite can pass consistency checks. Hosts must authorize source/tenant access
and state the authorized producer/storage/tenant trust scope. Scope graph and
cache instances to one authorization domain; admitted does not mean authenticated.
Resistance to deliberate rewriting needs a separately
trusted MAC/signature policy; this proposal adds no key-management system or
authenticity claim.

IDs, key names, topology and endpoint existence can disclose information without
values. Apply the existing capture/export/query privacy law and host
authorization to both endpoints and the evidence basis, including whole-channel
withholding where required. Keep fixed gaps when links are withheld. Presentation
references remain opaque; never repeat arbitrary provider error text, request
data or selected values. Do not add a parallel redaction policy.

## Measurable retention, save, admission and query gates

Let R be completed retained occurrences, W retained write handles (including
pending staged mappings), A active/pending owner incarnations, B bounded
name/path/metadata bytes, E expanded candidate relationships and V charged visits.
Before runtime approval, freeze a representation and measure these separate gates:

| Gate | Required oracle and measurement |
| --- | --- |
| Capture/retention | Incremental association storage/work is O(R+W+A+B). Read append is amortized O(1) and each immutable write handle has constant size/work independent of prefix length, or justify a stated indexed bound. Never retain state values, frames, buffers, generations or producer closures through evidence |
| Save/checksum/reopen | Encode each occurrence and each write reference once: O(R+W+B), including normalization/checksum/compaction. No expanded prefix arrays, copied growing block directory or repeated full serialization to estimate limits. Measure peak original/normalized/encoded/decoded copies |
| Admission | New association work is O(R+W+B) with direct owner/incarnation/write indexes; separately charge current source validation. No full-prefix validation per write. Host rejects overlarge raw byte/entry input before bulk parse/copy; unknown versions/classes become fixed gaps/refusals |
| Query | Expansion costs at least E and can be R*W. Expand lazily under shared backward/impact work, candidate/reference/byte and emitted-edge budgets. Charge validation, privacy tests, sorting and gaps before work/allocation. `maxEdges=1` with many unusable candidates must still have bounded V and temporary bytes; do not expand then truncate |
| Global saturation | Capture-global caps include retries/loops and subordinate owner/incarnation limits for reads, writes, owners, active/pending frames, staged mappings, paths/listings, metadata/encoded bytes and work. Counts never reset through owner churn |
| Omission state | Failed append irreversibly degrades affected later prefixes; earlier complete handles may remain complete. Missing write association is incomplete, never empty. Reserve fixed omission categories with saturating counts/inexact flags before collection; if an owner gap cannot fit, degrade the enclosing scope. Sustained overrun does bounded work without per-refusal IDs/objects |
| Lifecycle/GC | Release transient joins/pins on successful/failed commit, discard, retry, timeout, cancel, teardown and retirement. Account for existing active-owner/source validation scans separately. Prove unneeded state generations collectible while the execution tree/evidence remains retained |
| Feature off/interactions | Zero new-channel entries, bytes, registries/allocations, getter/predicate/comparator invocations or scheduled tasks; same business/replay/saved bytes. Test channel off/on × readSources off/on × legacy reads-prefix off/on × full/delta. Legacy key-array copying is not mandatory for the new channel; report combined cost if explicitly enabled |

For configured limit L, prove retained/emitted counts <= L at L−1, L, L+1 and
sustained overrun with tiny limits 1, 2 and 8. Reject invalid limits before work.
Require zero falsely complete prefixes and unchanged business results/exceptions.
Operation-count geometric sweeps must match the declared linear formulas;
repeated near-4x work on doubling is a rejection signal even if toy latency is
small. Test repeated/distinct keys, alternating reads/writes, all reads then all
writes, 1/2/8/32 interleaved owners, retries, reentrancy, compaction and mostly
redacted/unsupported candidates. Count source-validation and legacy-prefix work
separately from new association work and total enabled work.

The runtime packet must pin exact commits, Node/V8, hardware, fixed seeds,
finite samples and a total runner deadline. Report median/tail capture, save,
parse, admission and query time; CPU, allocations, retained/peak heap and RSS,
encoded/output bytes, candidate/reference visits, cache hits, budget termination
and event-loop delay. Measure warm scope with a fresh query context, fresh graph
admission, fresh parse, and fresh process separately; imports/startup are not query
time. Every invocation must match reviewed golden root identity/absence,
attribution, gaps and truncation. Count timeout/budget/mismatch outcomes rather
than dropping them as outliers. Separate generous nonbinding repeatability runs
from deliberate deadline stress. Stable unknown is correct abstention, not root
discovery. Existing saved witness results are a baseline, not enabled-cost proof.

New numeric defaults/ceilings, heap multipliers and CPU/p95/p99/save/admission/
query/event-loop regression thresholds remain **unapproved until measured**.
Runtime approval requires concrete values and rationale in that implementation's
packet; this document does not invent safe production limits from a formula.

## Implementation and acceptance sequence

1. Review this amended contract and current-behavior witnesses. No new writer API,
   record field, format, package export or runtime behavior ships in this slice.
2. Define producer closed failed-capture attestation; implement reader/admission
   support default off, preserve failed outcome and original error, and test a
   saved/reopened selected failure. Re-evaluate the existing execution query.
3. Only if the selected-output gap remains necessary, implement bounded native
   associations plus codec/admission with red-first and mutation tests, operation
   kind, lifecycle/privacy, staged/compaction rules and measured cost gates.
4. Extend the existing cause/impact/PROV adapters through canonical public doors.
   Keep possible contributors conservative; no second schema or graph walker.
5. Adopt consumers deliberately. Freeze old/new producer × format × Foottrace
   reader × AgentFootprint × UI compatibility/capability/refusal matrix, semver
   decisions and package exports before publishing. Readers land before enabled
   writers in shared histories; unsupported semantics cannot silently look
   complete. Verify exact diagnostic-reader released versions against saved
   failed/successful fixtures before application runtime activation.
6. Consider a limited library-owned computation evaluator only for a demonstrated
   expression-dataflow need. Generic callbacks, boxed primitives and compiler
   transforms do not provide a small transparent Proxy change.

Future tests include ignored constants with marked sources, handled retry and
sibling errors, partial failed capture, repeated/future/reordered sources,
foreign owners/incarnations, stale closures, staged/no-op/aggregate writes,
redaction of names/endpoints/topology, missing receipts and budget exhaustion.
Exact state ancestry with missing call ancestry stays incomplete. Save/reload
must preserve classes and gaps. Structural consistency and checksum-recomputed
or coherent rewrites must never be advertised as authentication. Each changed
runtime boundary needs independent security then code review and a final-commit
review before merge/publication.

## References

- [Current native source contract](../read-sources.md)
- [Current public cause and attention policy](../cause.md)
- [ECMAScript Proxy internal methods](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-proxy-object-internal-methods-and-internal-slots)
- [W3C PROV-O](https://www.w3.org/TR/prov-o/)
