# Content-addressed record values

An opt-in dictionary, not a second state log or replay engine. Public entry:
`foottrace/values`. The root, write, cause and PROV doors do not re-export it.

Responsibilities and direction: `types.ts` is the data contract; `fields.ts`
admits own-data metadata; `limits.ts` owns finite caps and labels; `digest.ts`
uses browser WebCrypto SHA-256 with bounded waiting; `writer.ts` composes serving,
canonical admission, identity, capacity and storage; `reader.ts` admits the whole
owned table before awaiting verification and resolves explicit reference positions.
The canonical JSON sibling imports only capture leaves, never this folder.

```ts
const table = createValueTable({ redact: inlineServingLaw });
const result = await table.intern('rule', 'The exact served rule text.');
if (result.status === 'stored') {
  const saved = table.record({ context: result.reference });
  const opened = await readValueRecord(JSON.parse(JSON.stringify(saved)));
  opened.values!.resolve(result.reference); // the exact served string
}
// An omitted result has no reference. Record or act on its reason; never invent one.
```

## Byte and privacy contract

The host MUST pass the same serving/redaction law it applies to inline values.
It runs synchronously before admission, hashing or retention. This API does not
infer privacy or certify that the supplied law is safe. Labels are caller-supplied
metadata, never derived from values; choose suitable labels too. They are nonempty
well-formed text, at most 80 UTF-8 bytes, without C0/DEL controls. The first retained
label stands when another label names equal content; labels are not identities.

IDs are `sha256:` plus the digest of strict RFC 8785 UTF-8 bytes. Equal canonical
JSON gives the same id regardless of object identity or name order. Strings keep
exact spelling. Object property order is not part of this identity and negative
zero becomes zero; this is JSON-data equivalence, not preservation of arbitrary
JavaScript values or original JSON text. No signature, authentication, semantic
truth or anonymization is claimed. Agentfootprint's historical `afp-cjson/1` and
numeric `$af:ref` packing are distinct contracts and must not be relabelled.

All stored values are detached and frozen BEFORE crypto can await. A completed
write returns `{status:'stored', reference:{ref:id}, reused}`. Refused writes return
`{status:'omitted', reason}` with no payload, and increment that reason's counter.
Raw values, callback exception text and failed temporary snapshots are not kept.
Missing/rejected crypto never falls back to another digest. A timeout stops new
hashes; the platform computation cannot be cancelled and a late answer is ignored.
Already retained values can still be reused. Concurrent unique admissions recheck
capacity after awaiting; equivalent concurrent writes share one entry.

## Bounds and disclosures

Defaults and hard ceilings are exported as `VALUE_TABLE_DEFAULTS` and
`VALUE_TABLE_CEILINGS`. Limits are positive finite safe integers. `maxBytes` counts
retained canonical VALUE bytes, not the whole envelope. Entries, labels and ids
have separate bounds, so metadata is bounded too. Canonical admission has its own
fixed node/field/depth/string/sort caps; `maxValueBytes` sets its output/string cap.
`maxAttempts` bounds work on rejected and repeated submissions. `maxDigestBytes`
counts cumulative bytes submitted to crypto, including concurrent/rejected writes;
retained duplicates reuse the cache. `maxInFlight` bounds outstanding digest calls.

Every snapshot includes immutable entries, canonical bytes, attempts, pending
crypto writes, each omission counter and `atLeast` when a counter saturated. A
snapshot with `pending > 0` is explicitly unfinished. Counts are writer-reported,
not independent proof of complete capture. Snapshotting never waits or changes a
previous snapshot. The opaque `record` payload stays caller-owned: freeze/serialize
it according to the producer's existing law.

## Read one

`readValueTable` owns all admitted metadata and values before its first await,
verifies every id, rejects duplicate ids and malformed/bounded-out tables, and
returns a frozen reader only when the whole table is verified. `resolve` refuses
an invalid or dangling reference with a fixed `ValueTableError.code`. It resolves
ONE explicitly declared reference position, not arbitrary objects recursively:
a stored literal `{ref:...}` is returned literally. This avoids collisions between
payload data and reference syntax without inventing a second recursive codec.

`table.record(payload)` emits `foottrace.value-record.v1` with `record` and
`valueTable`. `readValueRecord` unwraps only that explicit family. Old values return
as `opened.record` by identity, without payload inspection or crypto; unknown
versions are named refusals. Old EventLog/RecordSink/commit formats never change.
Adjacent tests cover ownership, privacy, bounds, concurrency, crypto, wire round
trips, literal reference data, old records and named refusals.
