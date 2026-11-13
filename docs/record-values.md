# Store repeated record values once — unreleased

Use `foottrace/values` when a producer repeatedly records the same JSON content.
This is opt-in and recording-only: it never changes live state, model requests or
the bytes of an existing EventLog/RecordSink record.

```ts
import { createValueTable, readValueRecord } from 'foottrace/values';

// Use the SAME redaction/serving function as inline recording.
const table = createValueTable({ redact: serveInlineValue });
const stored = await table.intern('context rule', servedRule);
if (stored.status === 'stored') {
  const saved = table.record({ context: stored.reference });
  const opened = await readValueRecord(JSON.parse(JSON.stringify(saved)));
  const exactServedValue = opened.values!.resolve(stored.reference);
}
// If omitted, inspect stored.reason and table.snapshot().omissions.
// Do not emit a reference for a value that was not stored.
```

A stable content id is SHA-256 of RFC 8785 canonical UTF-8 bytes. The separate
`foottrace/canonical-json` door exposes `canonicalizeJson` and fixed coded refusals;
it accepts only bounded owned JSON, without calling getters or `toJSON`. Neither
an id nor a successful read proves truth, privacy, execution or authenticity.

The generic table keeps each explicitly interned value once. It does not scan a
whole record looking for repeated subtrees. Labels are suitable host metadata;
the first label stands for equal content. Strings resolve exactly. Object key
order and negative zero follow canonical JSON, so original textual formatting or
non-JSON JavaScript values are not a promised round trip.

Writers and readers have finite default limits and hard ceilings. Table `bytes`
is the sum of canonical value bytes; entry/id/label bounds cover metadata. Limits
also cover submission work, cumulative digest bytes, concurrent hashes and waits.
Every omission is counted by reason; a timed-out hash is ignored if it later ends.
A snapshot discloses pending writes and saturated counters. A missing reference
throws `ValueTableError` with code `dangling-reference`, never an empty substitute.

The `foottrace.value-record.v1` envelope separates the opaque original payload
from its table. Existing records passed to `readValueRecord` return unchanged and
need no crypto. Resolve only fields your new format explicitly declares as
references: a stored object that itself looks like `{ref:...}` remains plain data.
All table values are owned before an await; the opaque payload remains the
producer's own snapshot and should be serialized/frozen by its existing rules.

See the runnable [recorded-note example](../examples/post-execution/values/01-content-table.ts)
and [module contract](../src/lib/values/README.md). This generic layer does not yet
add agentfootprint's per-call context change lists or Lens rendering.
