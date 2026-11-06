# Run evidence: what a real engine says

Captured through published `footprintjs@11.0.0` and `agentfootprint@14.0.0` public APIs on 2026-11-06, with a mock provider and no network call. No library source was modified.

The engine does not write run evidence yet (stage S3), so `generate.cjs` records what its seams will hand the writer: each execution's `parentRuntimeStageId`, its tracked reads, each decision and pause event, placed in the order the real `fileSink` file held its commits. `live` holds what the real `ControlDepRecorder · lookup` answered for each execution, asked right after its leg. Mount entries get `run.stage`, and the executions on a resume's pause path get `resumes`, as the design's review requires.

| Scenario | What it is |
| --- | --- |
| `branches` | Decide with filter and function rules, a select with parallel branches, a subflow with its own decider, a decider loop, a fork with no function of its own |
| `agent` | A real agent chart: 3 model turns, 2 tool calls, 20 logs, 69 executions |
| `resume-same` | A pause two subflows deep, resumed on the same executor: one root log, two closes |
| `resume-fresh` | The same pause, resumed on a fresh executor: a second root log, parentless at its re-entered mount |

`engine-11.0.0.json` SHA-256: `802d357da8c6aff6701756c8ee261c0428b4f44402675a255449cd52f3a2abb2`. It is never silently regenerated.

```sh
node test/fixtures/run-evidence/generate.cjs /path/to/an-install > test/fixtures/run-evidence/engine-11.0.0.json
```

`real-1.11.1.jsonl` is one whole file the real `fileSink` wrote under `footprintjs@11.0.0` and `foottrace@1.11.1`: a subflow that fails, unedited. It holds no evidence, and must read `not-collected`.

`test/helpers/evidenceFixture.ts` replays the rows through the real `EventLog`, so what the reader reads is what the writer writes.
