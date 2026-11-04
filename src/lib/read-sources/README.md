# read-sources/ — bounded native read observations

This library admits read-source metadata, tracks origins and staging generations, and snapshots occurrences with explicit gaps. Memory uses its capture bindings; the state path grammar belongs to `../record-paths/codec.ts`.

Opening a log with capture belongs to the higher `../recording/readSourceRecord.ts` composition. This folder never constructs a memory log. Its existing record-contract imports from memory are type-only; runtime dependencies point down.

The public writer and snapshot types remain available through `src/write.ts`. The complete recording subject lives beside that composition; existing fixes and lifecycle integration tests remain in `test/lib/memory/unit/`.
