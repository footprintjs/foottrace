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
