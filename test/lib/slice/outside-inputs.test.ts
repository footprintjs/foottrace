import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  type CommitBundle,
  causalChain,
  commitValueAt,
  findLastWriter,
  formatCausalChain,
  formatSlice,
  isCommitBundle,
  keysReadFromExecutionTree,
  sliceForKey,
  sliceToJSON,
} from '../../../src/index.js';
import { recordRun } from '../../helpers/recordRun.js';

function quoteRecording(commitValues: 'full' | 'delta', hiddenValue?: string) {
  const run = recordRun({}, { commitValues, writeProvenance: 'reads-prefix' });
  run.step('seed', (stage) => {
    stage.set('config', 4);
    stage.set('history', ['started']);
  });
  run.step(
    'quote',
    (stage) => {
      stage.set('quote', Number(stage.read('config')) + 1);
      stage.set('history', ['started', 'done']);
      if (hiddenValue !== undefined) stage.set('privateValue', hiddenValue, { whole: true });
    },
    { untrackedSources: new Set(['env']) },
  );
  run.step('decide', (stage) => stage.set('decision', stage.read('quote') === 5));
  return run.snapshot();
}

function view({ commitLog, executionTree }: ReturnType<typeof quoteRecording>) {
  const reads = keysReadFromExecutionTree(executionTree);
  const walk = causalChain(commitLog, 'decide#2', reads.lookup)!;
  const slice = sliceForKey(commitLog, 'decision', reads);
  return { walk, slice: sliceToJSON(slice), walkText: formatCausalChain(walk), sliceText: formatSlice(slice) };
}

function saved<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// The test writer predates the engine producer for this field. Copy its
// immutable bundles before projecting equivalent reader inputs onto them.
function readerInput(recording: ReturnType<typeof quoteRecording>) {
  return { ...recording, commitLog: recording.commitLog.map((bundle) => ({ ...bundle })) };
}

const outsideInputs = {
  declared: ['clock', 'calendar'],
  call: { targets: ['quote-service', 'inventory-service'], incomplete: true },
} as const;

// The original writer and reader bytes from main 2f47435659a2, before this optional field.
const oldLogHash = {
  full: 'e4c77e17168aefdf69e84d30754cf02fa74d41cd8ab6df9bda88b71f9382fddc',
  delta: '151ed971f33403082e9d8c91c2f92c74065bf66c574ae66bc38eb9487a475fc0',
};
const oldViewHashes = [
  '5158b054d88b8a52be9949decbef1bca7084cfe0e397b7a122da8c979558c4a9',
  '272258e4a89d5519aeab895504612cfe56fd0b88741d669b5a6890e8dded6c0a',
  'b0c6d78c7a894919dec267642ba5734814c434793e5b7f3582bd7877c6eed72f',
  '4fb0e7db654fdd661573a2dd018fec74c288c283ed83501c00ed569b50a8e02a',
];

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe.each(['full', 'delta'] as const)('backward outside-input evidence with %s commit values', (encoding) => {
  it('preserves the old log, walk, slice and rendered bytes before and after JSON', () => {
    const live = quoteRecording(encoding);
    expect(live.commitLog[1].trace.find(({ path }) => path === 'history')?.verb).toBe(
      encoding === 'full' ? 'set' : 'append',
    );
    for (const recording of [live, saved(live)]) {
      const { walk, slice, walkText, sliceText } = view(recording);
      expect(hash(JSON.stringify(recording.commitLog))).toBe(oldLogHash[encoding]);
      expect([JSON.stringify(walk), walkText, JSON.stringify(slice), sliceText].map(hash)).toEqual(oldViewHashes);
    }
  });

  it('lists declared and distinct observed names while retaining tracked parents in live and saved records', () => {
    const live = readerInput(quoteRecording(encoding));
    live.commitLog[1].outsideInputs = {
      declared: ['clock', 'calendar'],
      call: { targets: ['quote-service', 'inventory-service', 'quote-service'], incomplete: true },
    };
    for (const recording of [live, saved(live)]) {
      const inputBytes = JSON.stringify(recording);
      const { walk, slice, walkText, sliceText } = view(recording);
      expect(walk).not.toHaveProperty('outsideInputs');
      expect(walk.parents[0]).toMatchObject({ runtimeStageId: 'quote#1', incompleteSources: ['env'], outsideInputs });
      expect(walk.parents[0]).not.toHaveProperty('outsideInputGap');
      expect(walk.parents[0].parentEdges).toMatchObject([
        { kind: 'data', key: 'config', parent: { runtimeStageId: 'seed#0' } },
      ]);
      expect(slice.nodes?.['quote#1']).toMatchObject({ outsideInputs });
      expect(slice.edges).toMatchObject([
        { from: 'decide#2', to: 'quote#1', kind: 'data', key: 'quote' },
        { from: 'quote#1', to: 'seed#0', kind: 'data', key: 'config' },
      ]);
      for (const text of [walkText, sliceText]) {
        expect(text).toMatch(/outside: clock[^\n]*incomplete/i);
        expect(text).toContain('inventory-service');
        expect(text.match(/quote-service/g)).toHaveLength(1);
        expect(text).toMatch(/outside call target list[^\n]*incomplete/i);
      }
      expect(commitValueAt(recording.commitLog, 2, 'quote')).toBe(5);
      expect(JSON.stringify(recording)).toBe(inputBytes);
    }
  });

  it('serves the same names when differences are confined to hidden values', () => {
    const left = readerInput(quoteRecording(encoding, 'private-value-left'));
    const right = readerInput(quoteRecording(encoding, 'private-value-right'));
    left.commitLog[1].outsideInputs = outsideInputs;
    right.commitLog[1].outsideInputs = outsideInputs;
    expect(left.commitLog[1].redactedPaths).toContain('privateValue');
    const leftBytes = JSON.stringify(view(saved(left)));
    expect(leftBytes).toBe(JSON.stringify(view(saved(right))));
    expect(leftBytes).toContain('outside: clock');
    expect(leftBytes).not.toMatch(/private-value-(left|right)/);
  });
});

it.each(['repeat', 'exit'] as const)('uses first-bundle outside-input ownership at the %s writer', (phase) => {
  const run = recordRun();
  run.step('seed', (stage) => stage.set('config', 4));
  run.step('quote', (stage) => stage.read('config'));
  run.step('late', (stage) => stage.set('config', 99));
  run.step('quote', (stage) => stage.set('quote', 5), { phase });
  run.step('decide', (stage) => stage.set('decision', stage.read('quote') === 5));
  const recording = readerInput(run.snapshot());
  const { commitLog, executionTree } = recording;
  const reads = keysReadFromExecutionTree(executionTree);
  commitLog[1].outsideInputs = { declared: ['clock'] };
  commitLog[3].outsideInputs = { declared: ['wrong-phase'] };

  const anchored = sliceForKey(commitLog, 'quote', reads);
  expect(anchored.writer).toBe(commitLog[3]);
  expect(anchored.root).toMatchObject({ keysWritten: ['quote'], outsideInputs: { declared: ['clock'] } });
  const later = causalChain(commitLog, 'decide#3', reads.lookup)!;
  expect(later.parents[0]).toMatchObject({
    runtimeStageId: 'quote#1',
    outsideInputs: { declared: ['clock'] },
    parents: [{ runtimeStageId: 'seed#0' }],
  });
  expect(formatSlice(anchored)).not.toContain('wrong-phase');
  expect(formatCausalChain(later)).not.toContain('wrong-phase');
  delete commitLog[1].outsideInputs;
  expect(sliceForKey(commitLog, 'quote', reads).root).not.toHaveProperty('outsideInputs');
});

function withGetter(target: object, key: string, get: () => never): object {
  return Object.defineProperty(target, key, { enumerable: true, get });
}

function malformedField(bundle: CommitBundle, value: unknown): void {
  Object.defineProperty(bundle, 'outsideInputs', { enumerable: true, value });
}

const badFields: [string, (bundle: CommitBundle, get: () => never) => void, 'invalid-data' | 'node-limit'][] = [
  ['malformed declared names', (bundle) => malformedField(bundle, { declared: ['clock', 42] }), 'invalid-data'],
  ['outer accessor', (bundle, get) => withGetter(bundle, 'outsideInputs', get), 'invalid-data'],
  ['nested accessor', (bundle, get) => malformedField(bundle, withGetter({}, 'declared', get)), 'invalid-data'],
  [
    'call target accessor',
    (bundle, get) => malformedField(bundle, { declared: ['clock'], call: { targets: withGetter(['svc'], '0', get) } }),
    'invalid-data',
  ],
  [
    'declared names over the cap',
    (bundle, get) => malformedField(bundle, { declared: withGetter(Array(129), '0', get) }),
    'node-limit',
  ],
  [
    'call targets over the cap',
    (bundle, get) => malformedField(bundle, { call: { targets: withGetter(Array(1001), '0', get) } }),
    'node-limit',
  ],
];

it.each(badFields)('reports %s as its own gap and preserves the valid commit', (_label, attach, gap) => {
  const recording = readerInput(quoteRecording('delta'));
  const { commitLog } = recording;
  const writer = commitLog[1];
  const get = vi.fn(() => {
    throw new Error('outside-input getter was invoked');
  });
  attach(writer, get);
  expect(isCommitBundle(writer)).toBe(true);
  expect(findLastWriter(commitLog, 'quote')).toBe(writer);
  expect(commitValueAt(commitLog, 2, 'quote')).toBe(5);
  const { walk, slice, walkText, sliceText } = view(recording);
  const quoted = walk.parents[0];
  expect(quoted).toMatchObject({
    runtimeStageId: 'quote#1',
    outsideInputGap: gap,
    incompleteSources: ['env'],
    parents: [{ runtimeStageId: 'seed#0' }],
  });
  expect(quoted).not.toHaveProperty('outsideInputs');
  expect(slice.nodes?.['quote#1']).toMatchObject({ outsideInputGap: gap });
  expect(slice.nodes?.['quote#1']).not.toHaveProperty('outsideInputs');
  expect(walkText).toContain(gap);
  expect(sliceText).toContain(gap);
  expect(get).not.toHaveBeenCalled();
});

it('shows an observed call with incomplete targets even if no target name was retained', () => {
  const recording = readerInput(quoteRecording('full'));
  const get = vi.fn(() => {
    throw new Error('foreign call payload was read');
  });
  const call = { targets: [], incomplete: true } as const;
  withGetter(call, 'payload', get);
  recording.commitLog[1].outsideInputs = { call };
  const { walk, slice, walkText } = view(recording);
  expect(walk.parents[0].outsideInputs).toEqual({ call: { targets: [], incomplete: true } });
  expect(slice.nodes?.['quote#1']?.outsideInputs).toEqual({ call: { targets: [], incomplete: true } });
  expect(walkText).toMatch(/outside: call[^\n]*incomplete/i);
  expect(get).not.toHaveBeenCalled();
});
