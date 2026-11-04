# record-paths/ — the state path codec

`codec.ts` owns the delimiter, normalization and segment decoding used by record writers and readers. Dotted keys and empty segments remain data. The execution-ID grammar in `../ids/` has different rules and stays separate.

This leaf imports nothing. Memory, read sources and record readers depend on it; it depends on none of them. `src/paths.ts` and the existing utility exports preserve their public contracts. Codec tests live beside the implementation.
