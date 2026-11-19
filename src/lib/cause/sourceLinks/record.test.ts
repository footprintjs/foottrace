import { sharedSourceLinksV1 as shared } from '../../../../test/fixtures/source-links/read.js';
import { describe, expect, it, vi } from 'vitest';
import {
  bindSourceLinkWrite,
  createRecordGraph,
  createStoredRecordGraph,
  explain,
  readServedRow,
  readSourceLinkRow,
} from '../../../cause.js';
import type {
  RecordScope,
  RecordSourceLink,
  ServedRow,
  SourceLinkPolicy,
  SourceLinkRow,
  StoredRecordScope,
} from '../../../cause.js';
import type { CommitBundle } from '../../memory/types.js';

const { address, servedRow, witnessRow: row, witness: location } = shared;
const context = () => ({ signal: new AbortController().signal });
const link: RecordSourceLink = {
  linkBasis: row.linkBasis,
  check: row.check,
  consumer: { runtimeStageId: row.consumer },
  output: { ...row.output, runtimeStageId: 'door', commitIdx: 1 },
  input: row.input,
  served: { key: 'served' },
  witness: location,
};

function bundle(runtimeStageId: string, idx: number, writes: Record<string, unknown>): CommitBundle {
  return {
    idx,
    runtimeStageId,
    stageId: runtimeStageId,
    stage: runtimeStageId,
    trace: Object.keys(writes).map((path) => ({ path, verb: 'set' })),
    overwrite: writes,
    updates: {},
    redactedPaths: [],
  };
}

function fixture(rows: readonly ServedRow[] = [servedRow], wire = link, witness = row): RecordScope {
  return {
    address,
    initialState: structuredClone(shared.initialState),
    commitLog: [
      bundle('consumer', 0, { served: rows.map((row) => structuredClone(row)) }),
      bundle('door', 1, { answer: 'synthetic answer', evidence: [witness] }),
    ],
    reads: { consumer: ['history'], door: [] },
    controlDeps: {},
    attention: {},
    complete: true,
    sourceLinks: { version: 1, status: 'captured', links: [wire], limitations: [] },
  };
}

function stored(scope: RecordScope): StoredRecordScope {
  return {
    ...scope,
    entries: [
      { kind: 'opened', at: 0, address, initialState: scope.initialState },
      ...scope.commitLog.map((bundle) => ({ kind: 'commit', at: 1, address, bundle })),
      { kind: 'closed', at: 2, address, outcome: 'ok', commits: scope.commitLog.length },
    ],
  };
}

const output = { runtimeStageId: 'door', commitIdx: 1, key: 'answer' };
const allow: SourceLinkPolicy = () => true;

describe.each([
  {
    name: 'memory',
    graph: (scope: RecordScope, sourceLinkPolicy?: SourceLinkPolicy, maxFields?: number) =>
      createRecordGraph([scope], { sourceLinkPolicy, maxFields }),
  },
  {
    name: 'storage',
    graph: (scope: RecordScope, sourceLinkPolicy?: SourceLinkPolicy, maxFields?: number) =>
      createStoredRecordGraph({ loadLog: () => stored(scope) }, { sourceLinkPolicy, maxFields }),
  },
])('$name source links', ({ graph }) => {
  it('keeps one witnessed link and its neutral origin gap separate from traversal', async () => {
    const scope = fixture();
    const reader = graph(scope, allow);
    const baseline = graph({ ...scope, sourceLinks: undefined }, allow);
    const selected = reader.nodeId(address, output);
    const plain = await baseline.parents(selected, context());
    const { sourceLinks, sourceLinkGaps, ...recorded } = await reader.parents(selected, context());
    expect(recorded).toEqual(plain);
    expect(sourceLinks).toMatchObject([
      { standing: 'witnessed', attribution: 'source-link', input: { view: { element: 0 } } },
    ]);
    expect(sourceLinks?.[0].input.origin).toBeUndefined();
    expect(sourceLinkGaps).toMatchObject([{ code: 'unavailable', reason: 'Origin is unavailable for this view.' }]);
    const rankRoots = vi.fn((_eligible: readonly import('../types.js').MarkedNode[]) => []);
    const result = await explain(reader, selected, { includeBackward: true, rankRoots });
    const control = await explain(baseline, selected, { includeBackward: true, rankRoots });
    expect(rankRoots.mock.calls[0]?.[0]).toEqual(rankRoots.mock.calls[1]?.[0]);
    expect(result.sourceLinks).toEqual(sourceLinks);
    expect(result.backward?.nodes).toEqual(control.backward?.nodes);
    expect(result.backward?.edges).toEqual(control.backward?.edges);
    expect(result.path).toEqual(control.path);
    expect(result.rootCause).toEqual(control.rootCause);
    expect(result.confidence).toEqual(control.confidence);
  });

  const laterOutput = { ...output, commitIdx: 2 };
  const laterLink = {
    ...link,
    output: { ...link.output, commitIdx: 2 },
    witness: { ...link.witness, commitIdx: 2 },
  };

  function withLaterWrite(
    source: RecordScope,
    initialState: Record<string, unknown>,
    change: CommitBundle,
  ): RecordScope {
    const [consumer, door] = source.commitLog as readonly CommitBundle[];
    return { ...source, initialState, commitLog: [consumer, change, { ...door, idx: 2 }] };
  }

  function listWrite(value: readonly string[], verb: 'set' | 'append') {
    const source = fixture([servedRow], laterLink);
    const change = bundle('change', 1, { history: [...value] });
    return withLaterWrite(
      source,
      { history: ['synthetic value', 'original'] },
      {
        ...change,
        trace: [{ path: 'history', verb }],
      },
    );
  }

  async function laterParents(scope: RecordScope, policy: SourceLinkPolicy = allow, maxFields?: number) {
    const reader = graph(scope, policy, maxFields);
    return reader.parents(reader.nodeId(address, laterOutput), context());
  }

  it('returns the same witnessed link when the same append is recorded as full or delta', async () => {
    const full = await laterParents(listWrite(['synthetic value', 'original', 'later'], 'set'));
    const delta = await laterParents(listWrite(['later'], 'append'));
    expect(full.sourceLinks?.[0].standing).toBe('witnessed');
    expect(delta.sourceLinks).toEqual(full.sourceLinks);
    expect(delta.sourceLinkGaps).toEqual(full.sourceLinkGaps);
  });

  it.each([
    ['full', 'history'],
    ['delta', 'history\u001f1'],
  ] as const)('keeps the selected list entry when a different entry changes (%s)', async (_, path) => {
    const changed = { history: ['synthetic value', 'changed'] };
    const source = fixture([servedRow], laterLink);
    const initialState = { history: ['synthetic value', 'original'] };
    const page = await laterParents(
      withLaterWrite(source, initialState, {
        ...bundle('change', 1, changed),
        trace: [{ path, verb: 'set' }],
      }),
    );
    expect(page.sourceLinks?.[0].standing).toBe('witnessed');

    const stale = await laterParents(
      withLaterWrite(source, initialState, {
        ...bundle('change', 1, { history: ['replacement', 'original'] }),
        trace: [{ path: path === 'history' ? path : 'history\u001f0', verb: 'set' }],
      }),
    );
    expect(stale.sourceLinks).toBeUndefined();
    expect(stale.sourceLinkGaps?.[0].code).toBe('stale');
  });

  const selectedProfile = { key: 'profile', pointer: '/selected' };

  function profileWrite(before: string, after: { selected: string; other: string }, path: string) {
    const wire = { ...laterLink, input: selectedProfile };
    const source = fixture([{ ...servedRow, served: [{ key: selectedProfile.key }] }], wire, {
      ...row,
      input: selectedProfile,
    });
    return withLaterWrite(
      source,
      { profile: { selected: 'unchanged', other: before } },
      {
        ...bundle('change', 1, { profile: after }),
        trace: [{ path, verb: 'set' }],
      },
    );
  }

  it.each([
    ['full', 'profile'],
    ['delta', 'profile\u001fother'],
  ] as const)('keeps a selected field of a whole served object when a sibling changes (%s)', async (_, path) => {
    const page = await laterParents(profileWrite('', { selected: 'unchanged', other: 'after' }, path));
    expect(page.sourceLinks?.[0].standing).toBe('witnessed');

    const selected = path === 'profile' ? path : 'profile\u001fselected';
    const stale = await laterParents(profileWrite('', { selected: 'replacement', other: '' }, selected));
    expect(stale.sourceLinks).toBeUndefined();
    expect(stale.sourceLinkGaps?.[0].code).toBe('stale');
  });

  it('returns identical public bytes for different text in an ungranted sibling', async () => {
    const allowSelected: SourceLinkPolicy = (locator) =>
      locator.key !== 'profile' || (locator.at === 'view' && locator.pointer === selectedProfile.pointer);
    const read = (other: string) =>
      laterParents(profileWrite(other, { selected: 'unchanged', other }, 'profile\u001fother'), allowSelected, 20000);
    const short = await read('');
    const long = await read('synthetic sibling text '.repeat(300));
    expect(short.sourceLinks?.[0].standing).toBe('witnessed');
    expect(JSON.stringify(long)).toBe(JSON.stringify(short));
  });

  it('requires authorization of the whole served write before looking for duplicates', async () => {
    const one = fixture();
    const two = fixture([servedRow, servedRow]);
    const denyServed: SourceLinkPolicy = (locator) => locator.key !== 'served';
    const parents = async (scope: RecordScope, policy: SourceLinkPolicy) => {
      const reader = graph(scope, policy);
      return reader.parents(reader.nodeId(address, output), context());
    };
    expect((await parents(two, allow)).sourceLinkGaps).toMatchObject([{ code: 'ambiguous' }]);
    const first = await parents(one, denyServed);
    const second = await parents(two, denyServed);
    expect(first.sourceLinks).toBeUndefined();
    expect(first.sourceLinkGaps).toMatchObject([{ code: 'not-permitted' }]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('closes the optional channel without a host policy', async () => {
    const reader = graph(fixture());
    const page = await reader.parents(reader.nodeId(address, output), context());
    expect(page.sourceLinks).toBeUndefined();
    expect(page.sourceLinkGaps).toEqual([{ code: 'not-permitted' }]);
  });

  it('rechecks authorization when a result is assembled', async () => {
    let views = 0;
    const reader = graph(fixture(), (locator) => locator.at !== 'view' || ++views === 1);
    const page = await reader.parents(reader.nodeId(address, output), context());
    expect(page.sourceLinks).toBeUndefined();
    expect(page.sourceLinkGaps).toMatchObject([{ code: 'not-permitted' }]);
    expect(views).toBe(2);
  });

  it('calls a well-formed mismatched committed check declared', async () => {
    const reader = graph(fixture([servedRow], { ...link, linkBasis: 'match', check: 'value-found' }), allow);
    const result = await reader.parents(reader.nodeId(address, output), context());
    expect(result.sourceLinks?.[0].standing).toBe('declared');
  });
});

describe('shared check-pair contract', () => {
  it.each(shared.checkPairs)(
    'records $linkBasis and $check with its own standing',
    async ({ gap, standing, ...pair }) => {
      const scope = fixture([servedRow], { ...link, ...pair }, { ...row, ...pair });
      const reader = createRecordGraph([scope], { sourceLinkPolicy: allow });
      const answer = await reader.parents(reader.nodeId(address, output), context());
      expect(answer.sourceLinks?.[0].standing).toBe(standing);
      if (gap) expect(answer.sourceLinkGaps?.[0].code).toBe(gap);
    },
  );
});

describe('public source-link row decoding and binding', () => {
  it('binds the same written output as the record adapter', () => {
    expect(readSourceLinkRow(row)).toEqual(row);
    expect(readServedRow(servedRow)).toEqual(servedRow);
    expect(bindSourceLinkWrite(fixture(), location)).toEqual(shared.boundWrite);
  });

  it('rejects invalid ranges, unknown versions and accessors without running them', () => {
    expect(
      readServedRow({
        ...servedRow,
        served: [
          {
            key: 'history',
            elements: [
              [0, 2],
              [1, 3],
            ],
          },
        ],
      }),
    ).toBeUndefined();
    expect(readSourceLinkRow({ ...row, version: 2 })).toBeUndefined();
    const getter = vi.fn(() => row.output);
    expect(readSourceLinkRow(Object.defineProperty({ ...row }, 'output', { get: getter }))).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('served occurrences at the read-window boundary', () => {
  function answer(scope: RecordScope, policy: SourceLinkPolicy = allow) {
    const reader = createRecordGraph([scope], { sourceLinkPolicy: policy });
    const output = scope.sourceLinks!.links[0].output;
    return reader.parents(reader.nodeId(address, output), context());
  }

  function withInput(scope: RecordScope, rows: readonly CommitBundle[], wire: RecordSourceLink): RecordScope {
    return {
      ...scope,
      commitLog: rows,
      sourceLinks: { version: 1, status: 'captured', limitations: [], links: [wire] },
    };
  }

  it.each([
    {
      description: 'list membership',
      input: { key: 'history', element: 0 },
      served: [{ key: 'history', elements: [[0, 1]] as const }],
    },
    { description: 'whole value', input: { key: 'history' }, served: [{ key: 'history' }] },
  ])('matches $description only to the same kind of served entry', async ({ input, served }) => {
    const wire = { ...link, input };
    const witness = { ...row, input };
    const result = await answer(fixture([{ ...servedRow, served }], wire, witness));
    expect(result.sourceLinks?.[0].standing).toBe('witnessed');
    const incompatible = 'elements' in served[0] ? [{ key: 'history' }] : servedRow.served;
    expect(
      (await answer(fixture([{ ...servedRow, served: incompatible }], wire, witness))).sourceLinkGaps?.[0].code,
    ).toBe('no-match');
  });

  it('keeps complete omission, bounded omission, unreadable row and missing input separate', async () => {
    expect((await answer(fixture([{ ...servedRow, served: [] }]))).sourceLinkGaps?.[0].code).toBe('no-match');
    expect((await answer(fixture([{ ...servedRow, served: [], bounded: true }]))).sourceLinkGaps?.[0].code).toBe(
      'truncated',
    );
    expect((await answer(fixture([]))).sourceLinkGaps?.[0].code).toBe('not-collected');
    expect((await answer(fixture([{ ...servedRow, consumer: 'someone else' }]))).sourceLinkGaps?.[0].code).toBe(
      'not-collected',
    );
    expect(
      (await answer({ ...fixture([{ ...servedRow, served: [] }]), initialState: { history: [] } })).sourceLinkGaps?.[0]
        .code,
    ).toBe('stale');
  });

  it('binds a second full-encoded row by its new position even if an older row was rewritten', async () => {
    const old = { ...servedRow, consumer: 'old' };
    const previous = bundle('old', 0, { served: [structuredClone(old)] });
    const rewritten = { ...old, served: [] };
    const consumer = bundle('consumer', 1, { served: [structuredClone(rewritten), structuredClone(servedRow)] });
    const witness = bundle('door', 2, { answer: 'a', evidence: [row] });
    const wire = { ...link, output: { ...link.output, commitIdx: 2 }, witness: { ...link.witness, commitIdx: 2 } };
    const scope = withInput(fixture(), [previous, consumer, witness], wire);
    expect((await answer(scope)).sourceLinks?.[0].standing).toBe('witnessed');
    const replacedOnly = bundle('consumer', 1, { served: [servedRow] });
    const overwritten = withInput(scope, [previous, replacedOnly, witness], wire);
    expect((await answer(overwritten)).sourceLinkGaps?.[0].code).toBe('not-collected');
    const logOnly = { ...scope, initialState: undefined };
    expect((await answer(logOnly)).sourceLinks).toBeUndefined();
    const missing = withInput(scope, [previous, { ...consumer, idx: 2 }, { ...witness, idx: 3 }], wire);
    expect((await answer(missing)).sourceLinks).toBeUndefined();
  });

  it('keeps the refused origin byte-identical to the same value coming with the base', async () => {
    const producer = bundle('origin', 0, { history: ['synthetic value'] });
    const consumer = bundle('consumer', 1, { served: [servedRow] });
    const witness = bundle('door', 2, { answer: 'a', evidence: [row] });
    const wire = { ...link, output: { ...link.output, commitIdx: 2 }, witness: { ...link.witness, commitIdx: 2 } };
    const seeded = withInput(fixture(), [bundle('origin', 0, { other: 1 }), consumer, witness], wire);
    const produced = withInput({ ...fixture(), initialState: {} }, [producer, consumer, witness], wire);
    const refused = await answer(produced, (locator) => locator.at !== 'write' || locator.runtimeStageId !== 'origin');
    const fromBase = await answer(seeded);
    expect(refused.sourceLinks).toHaveLength(1);
    expect(JSON.stringify([refused.sourceLinks, refused.sourceLinkGaps])).toBe(
      JSON.stringify([fromBase.sourceLinks, fromBase.sourceLinkGaps]),
    );
    expect((await answer(produced)).sourceLinks?.[0].input.origin?.write.runtimeStageId).toBe('origin');
  });

  it('uses the pinned view and reports an overlapping tracked read as ambiguous', async () => {
    const sibling: CommitBundle = {
      ...bundle('sibling', 0, { history: ['late result'] }),
      trace: [{ path: 'history', verb: 'append' }],
    };
    const consumer = bundle('consumer', 1, { served: [servedRow] });
    const witness = bundle('door', 2, { answer: 'a', evidence: [row] });
    const wire = { ...link, output: { ...link.output, commitIdx: 2 }, witness: { ...link.witness, commitIdx: 2 } };
    const scope = withInput(fixture(), [sibling, { ...consumer, beganAt: 0 }, witness], wire);
    expect((await answer(scope)).sourceLinks?.[0].standing).toBe('witnessed');
    const overlapping = withInput(scope, [sibling, { ...consumer, beganAt: 0, sawUntil: 1 }, witness], wire);
    expect((await answer(overlapping)).sourceLinkGaps?.[0].code).toBe('ambiguous');
    const rewrite = bundle('sibling', 0, { history: ['changed value'] });
    const stale = withInput(scope, [rewrite, { ...consumer, beganAt: 0 }, witness], wire);
    expect((await answer(stale)).sourceLinkGaps?.[0].code).toBe('stale');
  });
});

describe('scope snapshot and accounted history', () => {
  it('copies the source-link base when the scope log is admitted', async () => {
    const scope = fixture();
    const reader = createRecordGraph([scope], { sourceLinkPolicy: allow });
    await reader.openScope(address, context());
    (scope.initialState!.history as string[]).length = 0;
    const page = await reader.parents(reader.nodeId(address, output), context());
    expect(page.sourceLinks?.[0].standing).toBe('witnessed');
  });

  it('reports missing history separately from a selector missing in observed state', async () => {
    const read = (scope: RecordScope) => {
      const reader = createRecordGraph([scope], { sourceLinkPolicy: allow });
      return reader.parents(reader.nodeId(address, output), context());
    };
    const withoutBase = await read({ ...fixture(), initialState: undefined });
    expect(withoutBase.sourceLinkGaps?.[0].code).toBe('not-collected');
    const badSpan = { ...link, output: { ...link.output, span: [0, 100] as const } };
    expect((await read(fixture([servedRow], badSpan))).sourceLinkGaps?.[0].code).toBe('stale');
  });
});
