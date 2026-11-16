# Subflow observation admission

This library admits the value-free `RecordScope.subflows` port. It owns its
readonly DTOs, exact own-data schema, native mount/address relation and fixed
limits. A refused optional channel keeps the local log and produces a gap.
It performs no storage calls or graph traversal.

`types.ts` owns the input/output/collection vocabulary. `data.ts` applies shared
field, UTF-8 byte, name, list and reference limits. `admission.ts` binds actual
parent writes and capture rules; `identity.ts` uses the canonical native ID
codec. Adjacent tests exercise refusal, privacy, immutable copies and limits.

The enclosing parent owns one finite mount inventory and one collection list.
Every retained fan-out slot needs a real child identity. An unknown-child slot
is omitted with a partial/missing-child-record limitation, never fabricated.
Native snapshot-derived inventories remain partial, including apparently
finished runs. These observations prove neither storage durability nor semantic
use of the observed values.

Async graph projection belongs to `../recordSubflowGraph.ts`. Keeping that
library separate prevents admission from depending on its own consumer.
