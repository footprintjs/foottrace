# Native root-read sources

The writer port records native scalar root-read source observations. Existing `read()` calls do not capture this channel. A producer supplies scope, attempt and privacy facts, and a host separately admits its native observation or saved history. Cause and PROV readers accept the optional authorized root evidence below.

## Open a fresh record and use the actual read

```ts
import { createReadSourceRecord, RecordFrame, SharedMemory } from 'foottrace/write';

const state = new SharedMemory(undefined, { count: 1 });
const record = createReadSourceRecord(state, { logRunId: 'run-1', drillPath: [] });
const frame = new RecordFrame(state, record.log);
const owner = { runtimeStageId: 'increment#0', attemptId: 'increment#0@1' };
const selected = frame.readWithSource([], 'count', owner);
// Use selected.value: this IS the native read, never read the key again to instrument it.
frame.noteRead([], 'count'); // retain the existing reads-prefix channel independently
frame.write(['count'], Number(selected.value) + 1, 'set');
frame.commit(() => ({ stage: 'Increment', stageId: 'increment', runtimeStageId: 'increment#0' }));
frame.release();
const metadata = record.snapshot();
record.retire();
```

`createReadSourceRecord` opens one NEW native log from the exact heap's current
base. It cannot retrofit an existing log, and refuses a second active binding on
the same heap. Optional `stateAddresses: [['runs', 'branch']]` admits known native heap
namespaces from original descriptors before base cloning. These are declared
native addresses, not business-object paths. An undeclared late namespace can
record future native writes, but its old base stays unknown: cloning can flatten
a getter and cannot prove its origin. No old heap is retained to recover it later.
The log remains the ordinary value-bearing native log; only
`selected.occurrence` and `snapshot()` are value-free metadata. They contain no
value fingerprints. Keep the existing log's redaction and authorization rules.

Root keys are literal data: empty, dotted, slashed and Unicode keys are preserved.
Occurrence ordinals, segment ordinals, frame incarnations and staging generations
are numbers, never encodings of keys or values. `stateAddress` is the actual chosen
native namespace (including address-to-root fallback), not a parsed user key.
The host supplies the canonical native execution and optional canonical attempt
ID. Missing attempt evidence stays `attemptStatus: 'unavailable'`, never attempt 0.
Metadata is not tenant authorization or proof that the supplied owner is authentic.

## What the source means

| Form | Meaning |
| --- | --- |
| `base` | A scalar root slot admitted in this segment's native base |
| `committed` | A scalar root slot from the same bound log's actual `commitIdx` |
| `staged` | The selected frame incarnation and monotonic local staging generation |
| `unavailable` | A fixed reason; never a nearby writer selected by guesswork |

Only scalar root reads are precise in v1. Objects, arrays, rich values, nested
reads and mixed/unsupported compositions return `composite-unsupported`.
Getters execute only as required by the original read and cannot become exact
base evidence. A selected `undefined` is `undefined-presence-unknown`; it is not
proof that a property was absent. Reads and intermediate staging generations
survive even when a reverted write disappears from the final commit.

First-touch state and source clocks are pinned together. Live fallback uses the
live source clock. Unlogged native setters invalidate precision. Commit sources
are confirmed only after the matching native append, using its actual index;
sink reentrancy cannot label an unconfirmed/newer mutation with the older commit.
Release/discard drops staging and starts a fresh frame incarnation. Discarded
attempt evidence is labelled; late calls bearing a previously discarded attempt
remain unavailable. `clear()` retires the bound segment. Starting another record
requires retiring the previous binding; its base and ordinals are distinct.

The known native read-after-delete defect (FootPrint #124) is deliberately not
fixed here: if the actual read falls back to the old live value, this port reports
that source rather than pretending deletion worked. Exact selection is also not
semantic derivation: reading A before writing an unrelated constant to B proves
no dependency from A to B. The existing `reads-prefix` meaning is unchanged.

## Privacy and failure

Pass `'redacted'` when the producer's EXISTING privacy rule says so. This is a
value-free verdict, never a second redaction matcher. The same argument also
accepts a synchronous zero-argument verdict function when a producer must decide
privacy after the native read. It runs once after a successful read, receives no
value or source, and is never retained or awaited. Its original exception propagates
without retrying the read; pending snapshots remain incomplete. The native source
and owner are pinned before it runs, so callback writes cannot relabel the read.
Existing string arguments and the factory signature remain backward compatible.
The verdict must be pure and decide by name only, using the producer's existing
privacy rule; it must not inspect values or mutate recording state. If this API
needs more options later, use a single options object instead of widening this union.
Invalid verdicts fail closed. Native write redaction marks carry into source selection. Only root
key names are retained; nested hidden business field names are not indexed.
As with the current native record, decisions are made at capture time, not
retroactively. If stronger hiding is needed, do not enable this port until the
producer can provide its rule. Source metadata is not a safe replacement for a
redacted view of the ordinary log.

Source selection during a native buffer construction/mutation is unavailable;
a throwing partial mutation or a reentrantly replaced buffer invalidates its
staging lineage until release. A reentrant heap generation replaced by an outer
fold invalidates current origin precision as well. This reports the native behavior without changing
it or guessing a final source from an abandoned operation.

Index/collector failures withhold precision and keep a fixed gap without changing
the native result or original read/commit exception. A snapshot taken inside an
unfinished synchronous read is partial. Root metadata is built from native data
descriptors; no selected raw values or old heap generations are held by the
origin index. The native frame retains its existing first-touch state until
release; that pre-existing lifetime is unchanged.

The native writer contract still applies: never mutate `getState()` or a borrowed
container outside the native writer API. This channel is not a JavaScript sandbox,
a Proxy-trap time limiter, or a detector of arbitrary out-of-contract mutation.

## Bounds and defaults

Hosts may set limits at record creation within the immutable wire-v1 ceilings
below. Invalid, fractional, infinite, negative or above-ceiling limits are refused
with fixed setup errors. Writer defaults can change independently of stored admission.

| Limit | Default | Wire-v1 ceiling |
| --- | ---: | ---: |
| Retained occurrences per segment | 4,096 | 65,536 |
| Occurrences per execution (across attempts) | 1,024 | 16,384 |
| Serialized source channel, including gaps | 1 MiB | 16 MiB |
| Live origin versions (not just distinct keys) | 4,096 | 65,536 |
| Live staging slots across frames | 2,048 | 16,384 |

For a long run, increase both occurrence and byte limits explicitly, for example
`{ limits: { maxOccurrences: 16000, maxBytes: 8 * 1024 * 1024 } }`.
This does not remove any limit. Once retained history is full, later reads are
counted as omitted; compaction never deletes retained read occurrences.

Ended frames return live staging credits. Replacing one staged key reuses its
slot but never its generation ID. Origin histories keep the last fact at or before
the oldest active frame/pending-read clock and every newer fact. Older versions
are reclaimed; privacy/invalidation tombstones are not skipped and prior loss is
never upgraded to precision. Long-lived overlapping views can still fill this bound. If frame admission
is refused, the read is withheld with a gap rather than inventing an active
incarnation; later tagged-attempt precision stays unknown because missed discard
evidence cannot be recovered from an ID.
Aggregate container markers do not shadow unrelated native namespaces; replacing
a namespace itself still invalidates its old descendants. Native invalidation and
confirmation remain distinct when a callback could have observed the intervening
state; obsolete versions are reclaimed once no view needs them.

The configured byte limit (1 MiB by default) also independently bounds origin metadata and staging
metadata: at most three times that limit in accounted metadata across those three books, plus
bounded JavaScript object/Map overhead. It is not an exact V8 heap cap. Source
identity/key strings have at most 1,024 JSON UTF-8 content bytes. Native namespaces
have at most 64 components and log drill paths at most 16. There is no deep-field
index. Namespaces are either explicitly declared before base cloning, or registered by a native frame for future writes only.

Charge before retaining evidence. On origin saturation, current precision becomes
`budget-exhausted`; a missing index entry never means base. Previously pinned
pre-loss views may remain precise. Occurrence loss is a named counted gap, with
reserved space for gaps; counts stop claiming exactness if their integer bound
is exhausted. Unsupported-case traversal and redaction-prefix work are bounded.

## Stored metadata

`decodeReadSourceSnapshot(unknown)` validates the version, canonical identity,
order, finite bounds and source shape, reading data descriptors only and charging
bytes incrementally before retaining another row. It returns a detached frozen
value or `undefined`; stored getters are refused without being called. It does
**not** authenticate a scope, validate referenced native rows, attest durability,
restore missing occurrences or make a saved source complete. Those producer and
reader/persistence contracts belong to later packets. Do not promote an arbitrary
JSON object to validated causality just because structural decoding succeeded.

## Reproduce the measurements

Build this branch and a separate clean copy of base main `f798f62`, using the same
locked development dependencies. Then run (offline, Node 22+):

```sh
npm run build
node --expose-gc bench/read-sources.mjs --baseline /absolute/path/to/built/main
```

The checked-in script uses 20 warmup batches, 21 samples of 1,000 scalar reads,
9 index samples (build plus 10,000 lookups), and 12 retained copies for approximate
GC heap differences. It measures both 10,000 distinct keys and 10,000 historical
versions of one key. A read batch stays under the per-execution cap.

On Node 24.21.0 / macOS arm64 / Apple M5 Pro, the initial 10,000-entry proposal
measured about 1.60 microseconds added per tracked read; 192,127 serialized bytes
and about 175 KB of retained heap per 1,000 occurrences (including setup/index).
Default-off reads allocated zero origin books or added promises in the counted
1,000-read test; the microbenchmark measured about 21 ns added CPU time per read.
10,000 distinct-key index entries took about 9.21 ms for build plus 10,000 lookups
and 3.42 MB retained heap; 10,000 versions of one key took 4.06 ms and 0.88 MB.
These original costs led to choosing segment/origin limits to 4,096, byte limits to 1 MiB,
and staging to 2,048, while retaining 1,024 reads per execution. The later review
adds bounded host opt-in ceilings and live reclamation; the numbers above are
historical baseline measurements, not a new benchmark of those changes. The benchmark
still probes 10,000 entries independently to expose the scaling cost.

These are synthetic, machine-specific measurements, not an application latency
or savings claim. GC heap estimates are noisy; serialized/accounted byte counts
are exact. Full engine adoption, durable source history, `/cause`/`/prov` readers,
UI integration and any release remain separate reviewed work.

## Consume an authorized root observation

`RecordReadSources` and `ReadSourceExecution` have one canonical type door,
`foottrace/cause`. A `RecordScope` may supply `readSources: { record, executions }`
and its existing `initialState` beside the log. The same fields are accepted by
`exportProv`. Each execution binding names a canonical `runtimeStageId`, the exact
literal `stateAddress` chosen by that native execution, and its authorized
`attemptIds`. Missing or mismatched owners, namespaces or attempts stay unknown.
These bindings come from trusted host code after it admits the producer's native
observation or saved-history receipt; never expose them as model-controlled options.

The consumer reuses the source codec and canonical value reader. It checks the
exact log address, execution membership, first-commit boundary and matching scalar,
non-redacted row references. A committed source must precede its reader's first
commit. The source descriptor, rather than a temporal nearest-writer guess, chooses
which committed version was observed. Source metadata and optional base values are
copied as inert data; getters are refused and values never enter results.

This first consumer supports only root addresses with source segment 1. Child
scopes, unproved resumed segments, staged-to-commit joins, missing attempts, rich
composites and ambiguous literal path encodings retain gaps. Partial observations
remain usable lower bounds with incomplete coverage. Capture limits, omitted
observations and source-admission work exhaustion never become proof of absence.
`maxFields` bounds both copied evidence and conservatively precharged source
validation; increase it explicitly within the existing record limits for larger
source books. PROV also retains its existing work, privacy and output limits.

For cause queries, an unqualified execution gets `recorded-read` source edges.
Forward impact reaches the exact consuming execution. A scalar base is a known
pre-run terminus, without a fabricated commit node. A key-qualified output still
has conservative `stage` links when a read prefix names possible inputs: there
is no occurrence-to-write join, and that ambiguity can withhold `rootCause`.
An explicitly empty per-write prefix remains an exclusion. Original source
ordinals, attempt IDs and discarded/released disposition are preserved in the source book and PROV occurrences. Graph edges cite the original read ordinal and include attempt IDs that fit the existing 512-character evidence-reference limit; longer attempts remain resolvable through that ordinal. An exact
read in a discarded attempt proves that read happened, not influence on its output.

A captured empty source book does not establish read collection for an unbound
execution. Execution coverage requires an authorized known attempt or explicit
stage-read collection, with known reads matched to admitted observations. An empty
per-write prefix excludes inputs only for that output. Missing later consumer
coverage makes impact incomplete while preserving a root established by complete
backward evidence. Ancestor-qualified impact includes supported scalar source
reads inside that key, using the canonical path grammar.

PROV adds separate `ft:Read` occurrence nodes and `prov:used` only when a supported
source entity actually joins the admitted output. A scalar base gets a value-free
initial entity. A committed entity must be the matching final `set` row; patch,
missing, hidden or output-capped entities receive a gap. Existing candidate reads
and `ft:PossibleDerivation` remain extension evidence, so per-write ambiguity
and ordinary snapshot incompleteness still apply. Reads alone never emit
`prov:wasDerivedFrom` or prove semantic derivation.

`createStoredRecordGraph` forwards only explicitly supplied host evidence and uses
the stored log's own admitted initial state. It does not inspect opaque capture
notes, authenticate receipts, or borrow root authority for a child log. A checksum
or unkeyed digest is consistency evidence, not authentication or truth. Hosts own
tenant authorization, native/saved-history admission and any trusted signature.
With `readSources` absent or `undefined`, legacy query and export results retain
their existing bytes and meaning.
