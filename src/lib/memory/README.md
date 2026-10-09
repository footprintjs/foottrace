# memory/ — the record writer and read model

This directory owns the record, not the engine that produces it. It was extracted from FootPrint 9.48.1 without changing recorded bytes. Historical rationale remains in Git; current laws are in the [record contract](../../../docs/guides/record-contract.md).

## One rule per owner

- Leaves: record types, encoded paths, safe nested access, value equality and merging.
- Verb law: one implementation of set/update/append/delete replay, used by live commits and readers.
- Staging and commit: the private transaction buffer, admission, encoding, scrub bytes and bundle construction.
- Public writer: `SharedMemory` holds copy-on-write state, `EventLog` owns the frozen base and append-only bundles, and `RecordFrame` stages one step's reads/writes and commits them.
- Readers: commit queries and causal analysis; slice and time-travel libraries compose these rules.

Dependency ranks are explicit in `scripts/layers.json`. The checker rejects unranked source, upward runtime edges, cycles, external imports and unresolved or opaque imports. This package loads no engine, scope, runner, provider or Node API.

## Public boundary

`foottrace` owns record types, queries, IDs and honesty codes. `foottrace/write` owns the public writer classes, their types and writer-owned freezing. `foottrace/paths` owns record paths, nested access and safe diagnostic writes. Consumers do not import private files or copy record rules.

The writer supplies an address as literal segments, commit identity and retention decisions. The record does not invent run namespaces, perform a traversal or decide what should be redacted. A frame captures its first-touch base and read evidence and applies the same law to live state and the log. `release()` resets frame-local staging. Retry, pause/resume, scope liveness, observer callbacks and runtime redaction policy belong to the consuming engine.

`freezeRecord` and `serveRecord` share registration within each module format: JSON-shaped records are shared frozen; mutable built-ins are served as protected copies. This is not a generic immutability promise for arbitrary inputs. See the root README for ownership, unsupported values and equality distinctions.

## Diagnostics are not records

`setNestedValue` and `updateNestedValue` on `foottrace/paths` retain the nested-write law. Dangerous selector segments are refused before mutation; literal segment arrays preserve dotted keys; arrays concatenate without deduplication; empty collections replace. Payload keys are data. These helpers do not produce commit bundles or define a second replay law.

## Honest readers

A recorded write is not proof of semantic influence on an AI response. Slices describe recorded structure; gaps and untracked sources retain their honesty reasons. Keep those reasons when presenting results to a person or a model.

Time travel folds a detached view of saved history. It does not rerun a tool, restore an external system or resume execution. [Time travel](../time-travel/README.md) and [slicing](../slice/README.md) have focused contracts.
