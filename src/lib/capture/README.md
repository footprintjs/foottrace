# Record-value primitives

These L0 leaves retain, copy and serve recorded values without importing the engine.

`ownData.ts` is the private owner of own-slot placement, used by record serving,
path copies/writes, record merges, diagnostics and transaction privatization:

- `putOwn` preserves native assignment behavior on existing own slots and absent
  non-inherited names. A missing inherited name becomes an own data property.
- `setOwnValue` preserves the diagnostic contract: every missing slot must be
  created. This intentionally differs from native assignment for impossible
  typed-array indices (creation throws where assignment is a no-op).

Existing own accessors and descriptor flags keep their JavaScript behavior.
Payload names such as `__proto__` remain data. Selector validation is a separate
responsibility in `memory/pathOps.ts`; neither primitive filters payload keys.
The path layer preflights a complete selector before mutation and traverses own
fields only. This is not a sandbox for arbitrary proxies or own accessors.

`freeze.ts` owns record freezing and serving; `valueKinds.ts` owns value-kind
classification. Sharing slot placement does not change built-in serialization,
record merge laws, copy ownership or the public API. Compatibility tests live in
`test/lib/capture/ownData.test.ts` and the memory writer suites.
