# cause/ — explain recorded dependencies

This library admits recorded inputs, builds a bounded dependency graph and answers cause queries with explicit gaps. Its public facade is `src/cause.ts`; the record contract is documented in `docs/cause.md`.

It reads the memory and read-source record contracts. Canonical execution admission belongs to `../ids/nativeExecution.ts`, so cause does not depend on the PROV exporter. PROV can adapt these admitted causes into its own output vocabulary.

Existing cause behavior tests remain in `test/cause/`; new utility subjects keep their own tests beside their implementation.

Generic queries may explicitly select `attentionAdmission: 'retain-valid'`.
`validation.attentionProjection` carries admitted marks and rejected-slot coverage
as one timely Session value; walk reports `invalid-data` for the actual node.
The default and strict `validation.attention` used by native records and PROV
remain atomic. The evidence leaf owns the single mark schema and raw bounds.
