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

  it('treats a served position under an intervening union as ambiguous', async () => {
    const input = { key: 'history', element: 2 };
    const wire = { ...laterLink, input };
    const served = [{ ...servedRow, served: [{ key: input.key, elements: [[0, 3] as const] }] }];
    const source = fixture(served, wire, { ...row, input });
    const policy: SourceLinkPolicy = (locator) =>
      locator.key !== input.key || (locator.at === 'view' && locator.element === input.element);
    const read = (first: string, verb: 'merge' | 'append') =>
      laterParents(
        withLaterWrite(
          source,
          { history: [first, 'second', 'selected'] },
          {
            ...bundle('change', 1, { history: ['second'] }),
            trace: [{ path: 'history', verb }],
            updates: { history: ['second'] },
          },
        ),
        policy,
      );
    const union = await read('first', 'merge');
    expect(union.sourceLinks).toBeUndefined();
    expect(union.sourceLinkGaps).toMatchObject([{ code: 'ambiguous' }]);
    expect(JSON.stringify(await read('second', 'merge'))).toBe(JSON.stringify(union));
    const append = await read('first', 'append');
    expect(append.sourceLinks?.[0].standing).toBe('witnessed');
    expect(JSON.stringify(await read('second', 'append'))).toBe(JSON.stringify(append));
  });

  it('checks array positions in pointers and limits the union check to their branch and witness', async () => {
    const input = { key: 'profile', pointer: '/items/2' };
    const wire = { ...laterLink, input };
    const served = [{ ...servedRow, served: [{ key: input.key }] }];
    const source = fixture(served, wire, { ...row, input });
    const initialState = { profile: { items: ['first', 'second', 'selected'] } };
    const merge = (delta: object, idx = 1): CommitBundle => ({
      ...bundle('change', idx, {}),
      trace: [{ path: 'profile', verb: 'merge' }],
      updates: { profile: delta },
    });
    const beforeWitness = await laterParents(withLaterWrite(source, initialState, merge({ items: ['second'] })));
    expect(beforeWitness.sourceLinkGaps).toMatchObject([{ code: 'ambiguous' }]);
    const [consumer, door] = source.commitLog as readonly CommitBundle[];
    const beforeView = {
      ...source,
      initialState,
      commitLog: [merge({ items: ['second'] }, 0), { ...consumer, idx: 1 }, { ...door, idx: 2 }],
    };
    expect((await laterParents(beforeView)).sourceLinkGaps).toMatchObject([{ code: 'ambiguous' }]);
    const beside = withLaterWrite(source, initialState, merge({ other: { items: ['second'] } }));
    const besidePage = await laterParents(beside);
    expect(besidePage.sourceLinks?.[0].standing).toBe('witnessed');
    const afterWitness = { ...beside, commitLog: [...beside.commitLog, merge({ items: ['second'] }, 3)] };
    expect(await laterParents(afterWitness)).toEqual(besidePage);
  });

  it.each(['output', 'witness'] as const)('uses the same projection for a position under a %s union', async (role) => {
    const key = role === 'output' ? 'answer' : 'evidence';
    const wire: RecordSourceLink =
      role === 'output'
        ? { ...link, output: { ...link.output, element: 2 } }
        : { ...link, witness: { ...link.witness, element: 2 } };
    const witness = { ...row, ...(role === 'output' ? { output: { ...row.output, element: 2 } } : {}) };
    const source = fixture([servedRow], wire, witness);
    const [consumer, door] = source.commitLog as readonly CommitBundle[];
    const policy: SourceLinkPolicy = (locator) =>
      locator.key !== key || (locator.at === 'write' && locator.element === 2);
    const read = (first: string) => {
      const scope = {
        ...source,
        initialState: { ...source.initialState, [key]: [first, 'second'] },
        commitLog: [
          consumer,
          {
            ...door,
            trace: door.trace.map((item) => (item.path === key ? { ...item, verb: 'merge' } : item)),
            updates: { [key]: ['second', role === 'output' ? 'selected' : witness] },
          },
        ],
      };
      const reader = graph(scope, policy);
      return reader.parents(reader.nodeId(address, wire.output), context());
    };
    const first = await read('first');
    if (role === 'output') {
      expect(first.sourceLinks).toBeUndefined();
      expect(first.sourceLinkGaps).toMatchObject([{ code: 'ambiguous' }]);
    } else {
      expect(first.sourceLinks?.[0].standing).toBe('declared');
    }
    expect(JSON.stringify(await read('second'))).toBe(JSON.stringify(first));
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

  const allowSelectedProfile: SourceLinkPolicy = (locator) =>
    locator.key !== 'profile' || (locator.at === 'view' && locator.pointer === selectedProfile.pointer);

  it('returns identical public bytes for different text in an ungranted sibling', async () => {
    const read = (other: string) =>
      laterParents(
        profileWrite(other, { selected: 'unchanged', other }, 'profile\u001fother'),
        allowSelectedProfile,
        20000,
      );
    const short = await read('');
    const long = await read('synthetic sibling text '.repeat(300));
    expect(short.sourceLinks?.[0].standing).toBe('witnessed');
    expect(JSON.stringify(long)).toBe(JSON.stringify(short));
  });

  it('treats ungranted base text equally on both sides of the old log text limit', async () => {
    const wire = { ...link, input: selectedProfile };
    const source = fixture([{ ...servedRow, served: [{ key: selectedProfile.key }] }], wire, {
      ...row,
      input: selectedProfile,
    });
    const read = (length: number) => {
      const initialState = { profile: { selected: 'unchanged', other: 'x'.repeat(length) } };
      const reader = graph({ ...source, initialState }, allowSelectedProfile);
      return reader.parents(reader.nodeId(address, output), context());
    };
    const atLimit = await read(65_536);
    const aboveLimit = await read(65_537);
    expect(atLimit.sourceLinks?.[0].standing).toBe('witnessed');
    expect(JSON.stringify(aboveLimit)).toBe(JSON.stringify(atLimit));
  });

  it('discloses the same selected field with a long ungranted committed value', async () => {
    const read = (length: number) =>
      laterParents(
        profileWrite('', { selected: 'unchanged', other: 'x'.repeat(length) }, 'profile\u001fother'),
        allowSelectedProfile,
      );
    const before = await read(65_536);
    expect(before.sourceLinks?.[0].standing).toBe('witnessed');
    expect(JSON.stringify(await read(65_537))).toBe(JSON.stringify(before));
  });

  it('keeps an early object citation after 100 appends at default limits', async () => {
    const entry = () => ({
      rows: Array.from({ length: 20 }, () => ({ a: 1, b: 2, c: 3, d: 4, e: 5 })),
    });
    const input = { key: 'history', element: 1 };
    const appends = Array.from(
      { length: 100 },
      (_, index): CommitBundle => ({
        ...bundle('append', index + 1, { history: [entry()] }),
        trace: [{ path: 'history', verb: 'append' }],
      }),
    );
    const commitIdx = appends.length + 1;
    const wire = {
      ...link,
      input,
      output: { ...link.output, commitIdx },
      witness: { ...link.witness, commitIdx },
    };
    const served = [{ ...servedRow, served: [{ key: input.key, elements: [[0, 2] as const] }] }];
    const source = fixture(served, wire, { ...row, input });
    const [consumer, door] = source.commitLog as readonly CommitBundle[];
    const reader = graph(
      {
        ...source,
        initialState: { history: [entry(), entry()] },
        commitLog: [consumer, ...appends, { ...door, idx: commitIdx }],
      },
      allow,
    );
    const result = await reader.parents(reader.nodeId(address, wire.output), context());
    expect(result.sourceLinks?.[0].standing).toBe('witnessed');
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

  it('binds a write when an unrelated base field exceeds the old log text limit', () => {
    const scope = fixture();
    const initialState = { ...scope.initialState, other: 'x'.repeat(65_537) };
    expect(bindSourceLinkWrite({ ...scope, initialState }, location)).toEqual(shared.boundWrite);
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
