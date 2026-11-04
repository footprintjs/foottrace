# prov/ — export recorded provenance

This library translates admitted execution records and cause evidence into PROV output, preserving privacy refusals, bounded work and explicit gaps. Its public facade is `src/prov.ts`; examples and vocabulary are in `docs/prov.md`.

`ids.ts` owns PROV identifiers and IRI encoding. Canonical execution admission belongs to `../ids/nativeExecution.ts`, shared with cause and read-source admission. PROV depends on cause evidence; cause does not import this exporter.

Existing exporter behavior tests remain in `test/lib/prov/`; the shared execution admission has its own test beside its code.
