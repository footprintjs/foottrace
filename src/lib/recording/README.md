# recording/ — compose a log with read-source capture

`readSourceRecord.ts` opens an opted-in log from a heap and binds its read-source capture. It composes `../memory/` with `../read-sources/`; neither imports this composition layer. The public entry is `src/write.ts`.

The factory reserves the state binding before log construction can invoke a sink, retires capture if construction fails and checks for reentrancy before binding the log. Capture and its single binding registry retain their own implementations and lifecycle laws.

The factory's complete behavior test lives beside it. Existing lifecycle and repair integration tests stay in `test/lib/memory/unit/`. Record contracts such as `LogAddress` remain type-only imports from memory; the sibling direction rule governs runtime imports.
