# Optional host observation records

`createObservationRecord` (`foottrace/write`) puts bounded, already-served observations beside a native run using the existing `EventLog`, `RecordSink` and `RecordEntry` framing. `readObservationRecord` (`foottrace`) interprets only this optional convention after `readStoredRecord`. It adds no storage adapter, checksum, attempt recorder, engine dependency or causal graph.

## Meaning and authority

A host binds an independent observation log address to one exact subject: native log address, run, runtime stage, optional canonical attempt ID and opaque operation reference. The reader requires the same tuple from authorized host state outside the imported file. Matching is lookup isolation, **not authentication**. Every result has `authenticity: 'unverified'`; a self-consistent malicious rewrite can still be structurally collected. Checksums or an adapter's own trust label cannot establish otherwise. Authentication and authorization remain the host's responsibility.

`collected` means the declared observation cut is structurally complete within these limits. `partial` means some declared observations were omitted, lost, unreadable or outside limits. `not-collected` means no supported, matching opening declaration was admitted. Neither collected nor the observation log's `closed('ok')` means the business operation succeeded, storage is durable, a customer received an answer, or an external service stopped.

A row sequence records local note order. `observedAt` is an optional report on a named clock. Different clocks are incomparable, and even one observer's arrival order does not prove the original order of remote events. HTTP 504, latency, retries and queue samples alone never establish a physical root cause. This API returns no cause/impact edges and does not alter native capture, cause queries or PROV.

## Storage convention and closure

The ordinary `opened.meta.observations` holds `{v: 1, subject}`. Ordinary `note('observation', data)` holds `{v: 1, sequence, event, observedAt?, facts?}`. Ordinary `closed.meta.observations` holds `{v: 1, rows, omissions}`. There is no second transport framing or digest protocol.

The writer seals once. After closing, a note is refused without inspecting its input. Retained sequences start at one. Invalid or bounded-out rows are omitted whole and counted by fixed reason; counters saturate at `Number.MAX_SAFE_INTEGER`, meaning at least that many. Counts expose an accidentally missing tail even when the generic log has zero commits. Counts do not defeat deliberate edits of both data and counts. Missing close, unsupported closing version, duplicate/holey sequences, unread input or an omission prevents `collected`.

`noted` only means accepted for dispatch through the existing EventLog. A throwing/rejecting sink may still lose it; close counts let a reopen detect that loss. The host owns sink flushing and any separate durability acknowledgement. Sink methods must be own data functions. They execute only after admission; schema checking does not invoke them. An adapter may queue work, so a read before it settles remains provisional.

## Data, privacy and bounds

The host must serve/redact input **before** passing it to this opt-in writer. IDs, endpoint-like labels and scalar text can themselves be private. There is no automatic scope capture or new privacy policy. Withhold the capability if its subject or facts cannot be safely disclosed; consumers must keep the explanation unknown. Public output should use host-projected opaque references.

The writer and reader use existing canonical JSON admission, select own data fields, and make detached frozen output. Getters, custom iterators, `toJSON`, functions, class instances, nested fact objects, undefined values, nonfinite numbers and extra fields are refused. Optional fields must be absent, rather than present as `undefined`. The reader does not execute a caller's `StoredRecord.log` callback or overridden Map lookup. Ordinary Proxy descriptor traps can still execute: this is admission, not a JavaScript sandbox. The generic `readStoredRecord` input iterator remains governed by its existing contract.

Published policy ceilings are 256 retained rows, 128 KiB of admitted note JSON in total, 4 KiB per encoded note, and 16 scalar facts per note. Options may lower the first three limits, using positive safe integers, but cannot raise them. These caps exclude the existing framing/metadata, generated reference strings, temporary preparation and caller-owned callback work; they are not measured peak-memory or runtime guarantees. Event and clock names are lowercase machine labels of at most 128 characters. Fact names allow 128 characters; scalar text allows 256. Subject names allow 1,024 characters; each address allows 32 segments and 4,096 characters total. Subject preparation has its own 8 KiB budget.

## Refusals and recovery

| Result or gap                                                                                   | How the host can address it                                                                                                                                 |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ObservationError('invalid-options')`                                                           | Supply the documented own data fields, a separate host address, matching stage/attempt identities and positive limits no greater than `OBSERVATION_LIMITS`. |
| `invalid-data`                                                                                  | Serve plain finite scalar facts and supported own fields; remove accessors, custom objects and undefined properties.                                        |
| `scope-mismatch`                                                                                | Resolve the authorized exact subject and observation address from host state; never substitute another run.                                                 |
| `not-collected` / `unsupported-version`                                                         | Keep evidence unknown; collect a supported observation stream or use a matching reader.                                                                     |
| `incomplete-record` / `missing-note` / `count-mismatch` / `duplicate-sequence` / `unread-entry` | Recover and reopen the original complete stream; do not repair it by inventing a close, count or row.                                                       |
| `omitted` / `row-limit` / `byte-limit`                                                          | Keep the cut partial. Capture a smaller bounded observation set; a reader may use the published ceilings if its own lower limit caused the refusal.         |
| live refusal `closed`                                                                           | Start a new independent observation log for a new cut; do not append to the sealed one.                                                                     |

## Module owners

`types.ts` defines neutral results and fixed refusal vocabulary. `fields.ts` selects own data; `limits.ts` owns configurable ceilings; `codec.ts` admits the typed convention with existing canonical JSON and identity helpers. `writer.ts` uses EventLog. `reader.ts` has no runtime writer/EventLog import. Adjacent tests save and reopen genuine writer entries, remove a real final note, and test hostile inputs, bounds, omissions, exact subject matching and sink failures. No network or provider is used.
