# Export one record as PROV-O JSON-LD

This is the first, value-free export contract, prepared for a separate 1.6.0
release review. It is not part of the published 1.5.0 package. Import the optional
`foottrace/prov` entry in a build containing this feature; the root entry does not
load or re-export it.

PROV-O is a [W3C Recommendation](https://www.w3.org/TR/prov-o/), serialized here as
[JSON-LD](https://www.w3.org/TR/json-ld11/). This exporter does not certify records,
authenticate a producer, validate every PROV constraint, or turn missing evidence
into a known cause. Its job is to preserve the supported recorded facts and their
limits in a standard vocabulary.

## 1. Load one authorized record

The host owns authorization, storage and the namespace. Supply the record itself,
not a locator or loader. The exporter never fetches a record or a remote context.
It accepts the established `commitLog`/`history` bundle shape, and available native
address, read, control and attention evidence. It does not execute business code.

```ts
import { exportProv } from 'foottrace/prov';

const record = {
  commitLog: [{
    runtimeStageId: 'total#0',
    trace: [{ path: 'total', verb: 'set', readKeys: [] }],
    overwrite: { total: 25 },
  }],
};
const result = await exportProv(record, {
  base: 'urn:example:order:123/',
  values: 'none',
  maxCommits: 100,
});
// result.document is JSON-LD; retain result.gaps and result.complete beside it.
```

The API is asynchronous from the start. `values` defaults to `'none'` and that is
the only accepted mode in this phase. A future fingerprint mode requires a
separate security review; there is no raw-value mode. App-supplied people/tools,
agent callbacks, additional scopes and loading callbacks are not accepted options.

`base` must be an absolute HTTPS or URN namespace with no query, fragment,
credentials, control characters or malformed Unicode. A non-terminated base gets
a `/` boundary before exporter IDs. It is an identity prefix, not a URL to fetch.
Use a distinct namespace for each export scope whose identities must differ.

## 2. Preserve what each link means

| Recorded fact | Exported meaning |
| --- | --- |
| One native execution | One `prov:Activity`, even if it commits more than once |
| Each saved bundle | A separate `ft:Commit` with its original commit index and available phase |
| Each recorded write row | One `prov:Entity` identified by scope, commit index and row ordinal; `prov:wasGeneratedBy` names its known execution |
| A delete | A binding-deletion entity marked `ft:deleted`; no claim that a historical snapshot was destroyed |
| A read prefix | Extension-only `ft:Read`/candidate evidence and `ft:possibleDerivation` with `reads-prefix` attribution |
| Stage-level reads | Conservative candidate evidence, with a `conservative` gap |
| A supported earlier governing decider | `prov:wasInformedBy` and qualified communication, with `ft:relation: 'control'` |
| Hidden or absent evidence | A named gap, never an apparently healthy empty fact |

The fixed extension namespace is `https://footprintjs.dev/ns/foottrace#`.
The inline context expands `prov` to `http://www.w3.org/ns/prov#` and `ft` to that
extension namespace. All IRI links use `{'@id': ...}` objects; they do not become
plain string literals by accident.

A captured read says that a read happened. It does not prove that the read value
influenced the subsequent write: a step can read something and ignore it. Thus
candidate relations are never `prov:wasDerivedFrom`, `prov:wasInfluencedBy`,
`prov:Derivation` or `prov:Influence`. A standard reader that ignores `ft:` terms
must not infer a stronger dependency than the evidence supports.

An entity's candidate links may appear in a second node object with the same
`@id` as its write occurrence. This is valid JSON-LD: those objects describe one
node, and JSON-LD flattening joins their properties by identity. A plain JSON
consumer must likewise group node objects by `@id`; array position does not
identify a distinct entity.

This phase also emits no version-specific `prov:used` link from ordinary captured
reads. A strictly earlier committed writer is not proof of the exact value read:
the stage can read its own staged write, a container can need several nested
writes, and net-change filtering can hide intermediate writes. The read and its
candidate sources remain extension evidence with explicit ambiguity. Empty
captured reads differ from missing capture.

Repeated writes to one key retain their separate row identities. Only a final
payload may remain in a record, so the exporter does not pretend to have the
earlier intermediate values. In this phase no payload value is exported at all.
No clock, human approver or runtime producer is inferred. The exporter package is
not evidence of which runtime executed the record.

## 3. Treat redaction as a disclosure boundary

The exporter inspects admitted redaction evidence before emitting path-bearing
facts, applying the known redacted family across the covered scope, including
earlier occurrences. Redacted writes get positional opaque IDs with no path text,
path fingerprint, value or value fingerprint. Ancestor/descendant path families
and path-bearing references are withheld as needed.

**The count and position of redacted writes remain visible.** A placeholder still
identifies its original commit and row ordinal. This is not shape-hiding encryption
or anonymization. The host must decide whether that residual structure is suitable
for its recipient.

If the log is truncated or privacy evidence cannot be admitted, the exporter
withholds all path names in the selected scope and adds a gap. It does not assume
an unread tail contains no redactions. Metadata such as stage names is not a new
secret-classification system: producers must keep exportable metadata appropriate
for disclosure.

## 4. Keep gaps with the graph

The return shape is `{ document, gaps, complete }`. Keep the whole envelope when
storing or sharing it. Gap codes use Foottrace's existing registry; details are
fixed categories with positional references, not raw input or exception text.
Missing capture, malformed data, redaction, conservative candidates and bounds
remain visible.

Routine limits are summarized once per reason at document level, without a
`commitIdx` or `rowIdx`, with a positive integer `count`. Examples include missing
read versions, conservative read capture, and unavailable intermediate or patch
values. The count covers observations processed by this export, not every event
in the original run: source records can already have deduplicated reads, and a
bound can stop inspection early. Unusual problems keep individual gaps with
positional references where known. Both forms share a bounded gap allowance;
withheld reports are disclosed with a `truncated` gap and count, rather than
silently disappearing.

**Every P1 export returns `complete: false`.** There is no supported attestation
path in this phase, including for a cleanly finished run or a closed stored log.
Missing native capture and ending attestation is reported as `not-collected`,
subject to the gap limits below. A serialized `complete: true` or a durable closed
marker alone is not accepted as that proof.

Native capture/end metadata is planned in
[FootPrint #111](https://github.com/footprintjs/footPrint/issues/111). Adding it to
the producer will not by itself change this exporter: the reader must deliberately
adopt and validate the attestation first. `complete` would describe evidence
coverage within the export contract, not business success or proven semantic
causation.

## 5. Set finite work and output limits

Every optional numeric setting is a positive safe integer up to its hard ceiling.
`maxOutputBytes` has a minimum of 2,048 bytes so a fixed refusal envelope fits.
There are no model-selected limits or unbounded fallbacks.

| Option | Default | Hard ceiling |
| --- | ---: | ---: |
| `maxCommits` | 4,096 | 4,096 |
| `maxRows` | 16,384 | 65,536 |
| `maxReads` | 16,384 | 65,536 |
| `maxFields` | 50,000 | 1,000,000 |
| `maxNodes` | 32,768 | 65,536 |
| `maxRelations` | 32,768 | 65,536 |
| `maxStringBytes` | 1,048,576 | 4,194,304 |
| `maxOutputBytes` | 1,048,576 | 16,777,216 |
| `maxDepth` | 128 | 512 |
| `maxWork` | 250,000 | 2,000,000 |

The field, node, relation, string-byte and work allowances cover admission and
mapping together, not just final graph size. The output byte ceiling covers the
UTF-8 JSON serialization of the **whole returned envelope**, including context,
graph, gaps and completeness. Space for bounded gap reports, including truncation
markers, is reserved before graph output. Reaching the graph allowance retains
the admitted graph prefix and reports truncation; accumulated gaps cannot discard
that prefix at final serialization. At small byte ceilings some gap reports may
also be withheld, with that omission disclosed. Original commit/row indexes are
retained for individual refusals. The envelope never exceeds the byte ceiling.

Invalid options reject with `ProvExportRefusal`, a `TypeError` with fixed
`code: 'PROV_EXPORT_OPTIONS'`. Check the known operation's error `code`, rather than
using `instanceof` across CommonJS and ESM copies. Input-data refusals instead
become gaps in a resolved export. An impossible option is not silently ignored.

Admission reads own data descriptors into an owned bounded snapshot; accessors,
unsupported objects and thrown/revoked Proxy operations are refused without
reading getters or returning exception messages. No caller-owned data is frozen.
JavaScript descriptor reflection can still invoke a Proxy trap: a trap that never
returns cannot be sandboxed by an in-process library. A host requiring hard CPU
isolation must supply it outside this function. Value-free mode does not traverse
unrelated payload data.

Native `Object.keys` enumeration allocates its key list before JavaScript can
charge individual fields; an in-process field budget cannot impose an incremental
peak-memory bound on that native allocation. Use host isolation when strict
peak-memory limits are required for arbitrary hostile inputs.

## 6. Use the optional package boundary

```js
// CommonJS
const { exportProv } = require('foottrace/prov');
// ESM: import { exportProv } from 'foottrace/prov';
```

Both formats have strict public type declarations. Browser builds require no Node
runtime API, model, remote context, `eval` or `new Function`. Unused ESM imports
tree-shake away, and root-only consumers do not load the optional exporter. There
are no new runtime dependencies. The dev-only JSON-LD processor checks expansion
and RDF representation using a document loader that rejects every network request;
that check does not prove the recorded claims true or establish full constraints
validation.

See the [runnable single-scope example](../examples/post-execution/prov/01-export-prov.ts)
and [approved design and phase boundary](design/2026-10-provo-jsonld-export.md).
