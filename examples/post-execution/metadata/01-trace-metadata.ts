/**
 * Value-free trace metadata: a saved projection that kept stage identities and
 * written path names, but no verbs, values or patches (docs/metadata.md).
 *
 * The reader lists candidate-read links, never proof of derivation, and always
 * says the state effect is unknown and the answer incomplete.
 */
import { readTraceMetadata, traceMetadata } from 'foottrace/metadata';

async function main(): Promise<void> {
  const scope = { sourceId: 'saved-child', runId: 'run-1', invocationId: 'child#8' };
  const source = readTraceMetadata({
    scope,
    addressBasis: 'projection-local',
    commits: [
      { stage: 'Seed', stageId: 'seed', runtimeStageId: 'seed#9', trace: [{ path: 'input' }] },
      {
        stage: 'Calculate',
        stageId: 'calculate',
        runtimeStageId: 'calculate#10',
        trace: [
          {
            path: 'total',
            reads: { keys: ['input'], kind: 'per-write', before: { commitIndex: 1, traceIndex: 0 } },
          },
        ],
      },
    ],
  });
  const result = await traceMetadata(source, {
    scope,
    key: 'total',
    before: { commitIndex: 2, traceIndex: 0 },
  });
  console.log('Edges:', result.edges.length); // 1: total's write read input, a candidate-read link.
  console.log('State effect:', result.stateEffect); // unknown: no values were kept.
  console.log('Complete:', result.complete); // false, always.
}

void main();
