# cause/ — explain recorded dependencies

This library admits recorded inputs, builds a bounded dependency graph and answers cause queries with explicit gaps. Its public facade is `src/cause.ts`; the record contract is documented in `docs/cause.md`.

It reads the memory and read-source record contracts. Canonical execution admission belongs to `../ids/nativeExecution.ts`, so cause does not depend on the PROV exporter. PROV can adapt these admitted causes into its own output vocabulary.

Existing cause behavior tests remain in `test/cause/`; new utility subjects keep their own tests beside their implementation.
