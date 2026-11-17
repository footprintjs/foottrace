# RecordFrame internals

Step 1 moves the existing type units and absolute-path utility whole; the shared
tracked/source read owners remove facade business logic before adding the new
paired-read wiring. The facade is 598 lines, down from 646. TransactionBuffer's
existing 708-line ratchet is untouched; its broader cleanup is not this feature.

The parent `RecordFrame.ts` facade owns the frame's first-touch view, staging,
read selection and lifetime. This sealed folder holds the units that do not
need to be methods on that facade.

`absolutePath.ts` retains the existing selector composition. `trackedRead.ts`
shares the old tracked-read policy with the new no-source entry, preserving
legacy notifications and the ordinary read callback when metadata is absent.

- `types.ts` owns the existing encoding, write verb and write scrub types. The
  facade keeps their existing export surface.
- `sourceRead.ts` owns one source-read transaction: reserve an ordinal, admit
  the owner, touch the frame, read once, retain any canonical prefix, select
  source evidence, evaluate the existing privacy verdict once, then retain
  the occurrence. Its `finally` accounts for omission and finishes the ordinal.

The source transaction receives fixed library-owned ports, not caller-supplied
observers. Selection and retention still belong to their existing owners. Its
optional observation lets the located read share that same transaction; the
returned `visible` boolean comes from the verdict already evaluated. It never
calls privacy again or adds legacy `noteRead` bookkeeping. Read and privacy
errors remain the caller's original errors; collector failures keep their
existing poisoning behavior.

The integration controls live in `test/lib/memory/unit/readSourcesFixes.test.ts`,
`readSourcesLifecycle.test.ts` and `RecordFrame.canonicalReads.test.ts`.
