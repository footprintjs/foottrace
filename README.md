# foottrace

Execution records and the tools to read them: replay, time travel, slices, and evidence about where values came from. No flowchart engine, AI provider, or runtime dependency is required.

This package extracts FootPrint's established record layer. It does not introduce a second writer or a different replay law. The first release preserves the frozen record fixtures from footprintjs 9.48.1 and includes the coordinated 9.48.2 copy-safety correction: an own `__proto__` payload field stays data, never the copy's prototype. See the [changelog](CHANGELOG.md) for the limited rich-value behavior change.

**Release status:** extraction candidate. Version 1.0.0 is not ready to publish until review and release checks are complete.

## Three entry points

| Import | Responsibility |
| --- | --- |
| `foottrace` | Record types, runtime IDs, replay, time-travel cursors, causal and variable slices, honesty codes |
| `foottrace/write` | `SharedMemory`, `EventLog`, `RecordFrame`, encoding and write types, writer-owned freezing |
| `foottrace/paths` | Record-path encoding/decoding, nested access and safe diagnostic writes |

Every declaration has one public entry point. There are no public deep imports or `/testing` entry point. FootPrint's engine, observer channels, recorders and stores remain in `footprintjs`.

## Write and replay

```ts
import { stateAt } from 'foottrace';
import { EventLog, RecordFrame, SharedMemory } from 'foottrace/write';

const state = new SharedMemory(undefined, { count: 0 });
const log = new EventLog(state.getState());
const frame = new RecordFrame(state, log);
frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
const count = frame.read([], 'count') as number;
frame.noteRead([], 'count');
frame.write(frame.at([], 'count'), count + 1, 'set');
frame.commit(() => ({
  stage: 'Increment', stageId: 'increment', runtimeStageId: 'increment#0',
}));
frame.release();

const result = stateAt({ initialState: log.getInitialState(), commitLog: log.list() }, 0);
console.log(result.state); // { count: 1 }
```

Writers record during execution. Readers query what was recorded; they do not reconstruct missing events or infer certainty from absent evidence. A slice can be conservative or incomplete: retain its honesty codes when presenting it to a person or a model.

See the [record contract](docs/guides/record-contract.md), [time-travel contract](src/lib/time-travel/README.md), and [slice contract](src/lib/slice/README.md).

## Paths are not interchangeable

- `idPathSegments` (root entry) splits runtime IDs on `/` and drops empty segments. `isExecutionKey` detects `#`; it is not a complete validator.
- `pathSegments` and `normaliseStateKey` (`/paths`) decode/encode record paths with the existing unit-separator codec. Empty segments and literal dots are preserved.
- `nativeGet` and `nativeHas` accept dot-selector strings or literal segment arrays. Use arrays for literal dotted keys.
- `nativeHas` recognizes own properties, including an own `undefined` and dangerous-name data keys. `nativeGet` refuses dangerous segments and returns its default for `undefined`.
- `setNestedValue` and `updateNestedValue` refuse `__proto__`, `constructor`, or `prototype` anywhere in the target address before making any write. Refusal is a silent no-op, as in 9.48.1. Payload keys are data and are not filtered. Updates retain the existing shallow object merge and duplicate-preserving array concatenation; empty arrays replace. These helpers are not the record replay merge law.

## Ownership and equality

`freezeRecord` (`/write`) operates on **writer-owned** data in place and registers mutable built-in values for safe serving. It can replace a sliced buffer view. Do not pass an object whose ownership belongs to a caller. `serveRecord` (root entry) uses that registration to serve protected copies; it does not secure an arbitrary unregistered object. The entries share one freezing module within each module format.

`deepFreeze` (`/write`) is ordinary object freezing, not full immutability of Date/Map internals, and it does not descend through an already frozen object. Do not substitute it for `freezeRecord`.

`deepEqual` is the record's equality rule, not general-purpose deep equality: absent and own-undefined properties can compare equal, signed zero compares equal, array expando properties are ignored, and Map object keys use identity. The `'copies'` option treats opaque values of the same kind as equivalent. Preserve these distinctions when using it for change detection.

## Compatibility and development

Node.js 22 or newer; develop with Node.js 24 and npm 11. Both CommonJS and ESM are provided. Browser-capable source uses no Node runtime APIs. Use one module format consistently in an application; CJS and ESM have separate module instances.

```sh
npm ci
npm run check
```

No engine is installed in this package's test environment. Engine integration and the original flowchart byte fixtures are checked separately in FootPrint. Runtime dependencies remain empty. The original file history was retained with `git filter-repo`; see [extraction evidence](docs/extraction.md).

Record bytes are part of the versioning promise: refactors never re-pin; a named law fix requires a documented minor release; any other byte change requires a major. See the [fixture policy](test/fixtures/README.md).

MIT license. Contact: sanjay@footprintjs.dev.
