# ids/ — runtime-ID grammar

A recorded step has an address, `[subflowPath/]stageId#executionIndex`, such as `sf-tools/execute-tool-calls#8`. This directory constructs and parses that grammar without importing an engine.

```ts
import { buildRuntimeStageId, parseRuntimeStageId } from 'foottrace';

const id = buildRuntimeStageId('score', 14, 'review~2');
parseRuntimeStageId(id); // { stageId: 'score', executionIndex: 14, subflowPath: 'review~2' }
```

The root entry exposes the ID grammar. `idPathSegments` splits slash-delimited ID paths and drops empty segments; it is not the record path codec. Record `pathSegments` and `normaliseStateKey` belong to `foottrace/paths`.

A generated segment such as `review~2` is opaque to readers. The engine owns branch-name generation and reserved-ID admission; those files remain in FootPrint. Readers never load them. `isExecutionKey` checks a delimiter, not full admission validity.

`RuntimeStageId`, `ExecutionIndex` and `CommitIdx` are type-only brands assignable to their underlying string/number. The grammar is a dependency-free leaf, checked by the package fence.

## Attempt ids (1.1.0)

One attempt under a stage execution has an address too: `<runtimeStageId>@<n>` for attempt `n` of the stage, and `<runtimeStageId>@<n>.<k>@<m>` for attempt `m` of the `k`-th call that stage attempt made. Every count starts at 1 and is written without leading zeros, so one attempt has one spelling and an id is a safe join key.

```ts
import { buildAttemptId, parseAttemptId } from 'foottrace';

buildAttemptId('charge#4', 2);                              // 'charge#4@2'
buildAttemptId('charge#4', 2, { ordinal: 1, attempt: 3 });  // 'charge#4@2.1@3'
parseAttemptId('charge#4@2.1@3'); // { runtimeStageId: 'charge#4', attempt: 2, call: { ordinal: 1, attempt: 3 } }
parseAttemptId('sf/v1.2@x#7@3');  // { runtimeStageId: 'sf/v1.2@x#7', attempt: 3 }
parseAttemptId('charge#4');       // undefined — a stage execution, not an attempt
```

The parser reads from the right: a runtime ID always ends in `#<index>` and the attempt suffix holds no `#`, so the last `#` is the execution delimiter whatever the stage ID contains. No character is newly reserved — `@`, `.` and `~` stay legal in stage IDs, and the engine's reserved-ID refusal is unchanged. `buildAttemptId` refuses what `parseAttemptId` could not give back (a string that is not a runtime ID, a count that is not a positive integer); `parseAttemptId` never throws and returns `undefined` for anything that is not an attempt ID. `AttemptId` is a type-only brand, like `RuntimeStageId`.
