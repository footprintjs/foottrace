# Immutable public projection fixture

`projected-nested-main.json` is the byte-preserved output of explainable-ui's
public `projectTraceInvocation(snapshot, 'pipeline/prepare#8')` on its recorded
nested fixture at commit `59334f6cc28d29438db83c1d0a3e5d68b0afbac9`.

Source: [recorded subflow fixture](https://github.com/footprintjs/explainable-ui/blob/59334f6cc28d29438db83c1d0a3e5d68b0afbac9/test/fixtures/subflow-tracing/recordings.json),
[public projector](https://github.com/footprintjs/explainable-ui/blob/59334f6cc28d29438db83c1d0a3e5d68b0afbac9/src/trace/projectTraceInvocation.ts).

SHA-256 of this projection file:
`a55b0edff59c6bc4ea54633c686497ac22ed1241a7d6e04af392273ce54bfd47`.
No verbs, values, patches, indices or read anchors have been added to its rows.
Its global readsAvailable flag does not establish the position of each read.
Local rows0–3 came from original history1–4 because that projector omits the
input mapper; projection-only consumers cannot infer this mapping. The metadata
regression uses projection-local addresses and unknown read dependencies.

Do not re-pin this fixture to make an implementation pass. A later fixture is a
separate named recording with its own provenance.
