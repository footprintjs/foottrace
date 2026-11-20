import { createRecordGraph } from 'foottrace/cause';
import type { RecordScope, SourceLinkPolicy, SourceLinkRow } from 'foottrace/cause';
import type { CommitBundle } from 'foottrace';

const address = { logRunId: 'demo', drillPath: [] };
const input = { key: 'history', element: 0 };
const output = { key: 'answer', checkedIn: 'written' } as const;
const witness: SourceLinkRow = {
  kind: 'source-link',
  version: 1,
  linkBasis: 'reference',
  check: 'redeemed',
  consumer: 'consumer',
  input,
  output,
};

function commit(idx: number, execution: string, overwrite: Record<string, unknown>): CommitBundle {
  return {
    idx,
    stage: execution,
    stageId: execution,
    runtimeStageId: execution,
    trace: Object.keys(overwrite).map((path) => ({ path, verb: 'set' })),
    overwrite,
    updates: {},
    redactedPaths: [],
  };
}

const scope: RecordScope = {
  address,
  initialState: { history: ['kept input'] },
  commitLog: [
    commit(0, 'consumer', {
      served: [{ kind: 'served', version: 1, consumer: 'consumer', served: [{ key: 'history', elements: [[0, 1]] }] }],
    }),
    commit(1, 'check', { answer: 'kept input', evidence: [witness] }),
  ],
  sourceLinks: {
    version: 1,
    status: 'captured',
    limitations: [],
    links: [
      {
        linkBasis: 'reference',
        check: 'redeemed',
        consumer: { runtimeStageId: 'consumer' },
        input,
        output: { ...output, runtimeStageId: 'check', commitIdx: 1 },
        served: { key: 'served' },
        witness: { key: 'evidence', element: 0, runtimeStageId: 'check', commitIdx: 1 },
      },
    ],
  },
};

const sourceLinkPolicy: SourceLinkPolicy = (locator) => {
  if (
    locator.address.logRunId !== address.logRunId ||
    locator.address.drillPath.length ||
    locator.pointer !== undefined
  )
    return false;
  if (locator.at === 'view')
    return locator.consumer === 'consumer' && locator.key === 'history' && locator.element === 0;
  if (locator.span !== undefined) return false;
  if (locator.key === 'served')
    return locator.runtimeStageId === 'consumer' && locator.commitIdx === undefined && locator.element === undefined;
  if (locator.runtimeStageId !== 'check' || locator.commitIdx !== 1) return false;
  return (
    (locator.key === 'answer' && locator.element === undefined) || (locator.key === 'evidence' && locator.element === 0)
  );
};

async function main() {
  const graph = createRecordGraph([scope], { sourceLinkPolicy });
  const node = graph.nodeId(address, { runtimeStageId: 'check', commitIdx: 1, key: 'answer' });
  const page = await graph.parents(node, { signal: new AbortController().signal });
  console.log(page.sourceLinks?.[0].standing, page.sourceLinkGaps?.[0].code); // witnessed unavailable
}

void main();
