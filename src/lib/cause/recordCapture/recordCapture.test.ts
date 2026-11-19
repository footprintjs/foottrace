import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRecordGraph } from '../../../cause.js';
import type { RecordScope } from '../recordTypes.js';

const address = { logRunId: 'root', drillPath: [] };
const context = { signal: new AbortController().signal };
const interval = { from: 0, to: 2 };
const query = { channel: 'reads', ...interval, mode: 'full' } as const;
const complete = { mode: 'full', status: 'collected', reasons: [] };
const unknown = { mode: 'unknown', status: 'unknown', reasons: ['unverified'] };
const disabled = { mode: 'off', status: 'disabled', reasons: [] };
const commit = (idx: number) => ({
  idx,
  stage: 's',
  stageId: 's',
  runtimeStageId: 's#' + idx,
  overwrite: {},
  updates: {},
  trace: [],
  redactedPaths: [],
});
const scope = {
  address,
  commitLog: [commit(0), commit(1)],
  complete: true,
  captureWitness: { runId: 'run', commits: interval, boundary: 'completed', source: 'live' },
} satisfies RecordScope;
function note(reads: { mode: string; status: string; reasons: string[] } = complete) {
  return {
    version: 3,
    scope: 'log',
    runId: 'run',
    logAddress: address,
    commits: interval,
    boundary: { status: 'completed' },
    persistence: 'memory-only',
    channels: {
      reads,
      writes: unknown,
      commitWrites: unknown,
      writePrefixes: unknown,
      nestedReads: unknown,
      readSources: unknown,
      inputHandoff: unknown,
      outputHandoff: unknown,
      fanoutHandoff: unknown,
      attention: unknown,
      control: unknown,
    },
  };
}

const coverage = (capture: unknown, options = {}, base: RecordScope = scope) =>
  createRecordGraph([{ ...base, capture }]).captureCoverage(address, { ...query, ...options }, context);

describe('native capture coverage on the record graph', () => {
  it.each([
    [complete, 'covered', []],
    [disabled, 'not-collected', []],
    [{ mode: 'full', status: 'partial', reasons: ['redacted'] }, 'partial', ['redacted']],
    [{ mode: 'full', status: 'failed', reasons: ['capture-failed'] }, 'failed', ['capture-failed']],
    [unknown, 'collection-unknown', ['unverified']],
  ])('reports the channel outcome %j', async (channel, state, reasons) => {
    expect(await coverage(note(channel))).toMatchObject({ state, reasons });
  });

  it('keeps missing, malformed and newer observations unknown without rejecting ordinary record nodes', async () => {
    const late = { ...note(), version: 4 };
    for (const capture of [undefined, late, note({ ...complete, reasons: ['untrusted-text'] })]) {
      const graph = createRecordGraph([{ ...scope, capture }]);
      expect(await graph.captureCoverage(address, query, context)).toMatchObject({ state: 'collection-unknown' });
      expect(await graph.openScope(address, context)).toHaveLength(2);
    }
  });

  it('requires an independently bound complete local interval and a sufficient mode', async () => {
    const checks = [
      coverage(note(), { to: 3 }),
      coverage(note({ ...complete, mode: 'summary' })),
      coverage(note(), { crossing: 'transport' }),
      coverage(note(), { crossing: 'worker' }),
      coverage({ ...note(), runId: 'other-leg' }),
      coverage({ ...note(), logAddress: { ...address, drillPath: ['child'] } }),
      coverage(note(), {}, { ...scope, commitLog: [commit(1)] }),
      coverage(note(), {}, { ...scope, captureWitness: undefined }),
      coverage(note(), {}, { ...scope, captureWitness: { ...scope.captureWitness, source: 'saved' } }),
    ];
    for (const answer of checks) expect((await answer).state).not.toBe('covered');
  });

  it('uses the child’s own witness without borrowing coverage from the parent', async () => {
    const child = { ...address, drillPath: ['parent/mount#1'] };
    const childScope = { ...scope, address: child, captureWitness: { ...scope.captureWitness, runId: 'child-leg' } };
    const root = { ...scope, capture: note() };
    const graph = createRecordGraph([root, childScope]);
    expect((await graph.captureCoverage(child, query, context)).state).toBe('collection-unknown');
    const observedChild = { ...childScope, capture: { ...note(), logAddress: child, runId: 'child-leg' } };
    expect((await createRecordGraph([root, observedChild]).captureCoverage(child, query, context)).state).toBe(
      'covered',
    );
  });

  it('preserves observed writer edges when the optional note is malformed or missing', async () => {
    const writer = { ...commit(0), overwrite: { x: 1 }, trace: [{ path: 'x', verb: 'set' as const }] };
    const base = { ...scope, commitLog: [writer, commit(1)], reads: { 's#1': ['x'] } };
    const without = createRecordGraph([base]);
    const target = without.nodeId(address, { runtimeStageId: 's#1', commitIdx: 1 });
    const expected = await without.parents(target, context);
    expect(expected.edges).toHaveLength(1);
    for (const capture of [note(), { ...note(), version: 4 }])
      expect(await createRecordGraph([{ ...base, capture }]).parents(target, context)).toEqual(expected);
  });

  it('keeps a safe failure category when the native stage identity is overlong', async () => {
    const failure = { category: 'timeout', stage: { runId: 'run', runtimeStageId: 'x'.repeat(1025) } };
    const failed = { ...note(), boundary: { status: 'failed', failure } };
    const base = { ...scope, captureWitness: { ...scope.captureWitness, boundary: 'failed' as const } };
    expect(await coverage(failed, {}, base)).toMatchObject({
      state: 'partial',
      failure: { category: 'timeout' },
    });
    expect((await coverage(failed, {}, base)).failure).toEqual({ category: 'timeout' });
  });

  it('does not evaluate a getter in an optional capture note', async () => {
    let reads = 0;
    const capture = Object.defineProperty(note(), 'channels', {
      enumerable: true,
      get: () => {
        reads++;
        return {};
      },
    });
    expect(await coverage(capture)).toMatchObject({ state: 'collection-unknown' });
    expect(reads).toBe(0);
  });

  it('never strengthens coverage when v2 observations are restated in v3 without a new witness', async () => {
    const cases = [
      ['redacted-export', 'redacted'],
      ['redaction-active', 'redacted'],
      ['custom-scope', 'unsupported-scope'],
      ['read-retention-failed', 'capture-failed'],
      ['execution-broken', 'interval-incomplete'],
      ['modes-unavailable', 'unverified'],
      ['checkpoint-history-not-included', 'missing-evidence'],
    ] as const;
    await fc.assert(
      fc.asyncProperty(
        fc.subarray([...cases]),
        fc.constantFrom('completed', 'paused', 'failed'),
        fc.integer({ min: 0, max: 3 }),
        fc.boolean(),
        async (gaps, boundary, to, off) => {
          const limits = [
            'tracked-state-only',
            'final-attempt-views',
            'child-scopes-not-attested',
            'storage-not-attested',
          ];
          const mode = off ? 'off' : 'full';
          const reasons = [...new Set(gaps.map(([, reason]) => reason))];
          const v2 = {
            ...note(),
            version: 2,
            scope: 'root-log',
            boundary: { status: boundary },
            channels: {
              reads: off ? 'disabled' : 'captured',
              writes: 'unknown',
              attention: 'unknown',
              control: 'unknown',
              readSources: 'unknown',
            },
            modes: {
              readTracking: mode,
              writeTracking: 'unknown',
              commitValues: 'unknown',
              writeProvenance: 'unknown',
            },
            limitations: [...limits, ...gaps.map(([name]) => name)],
          };
          const v3 = {
            ...note(off ? disabled : reasons.length ? { mode, status: 'unknown', reasons } : complete),
            boundary: { status: boundary },
          };
          const base = { ...scope, captureWitness: { ...scope.captureWitness, boundary } };
          const before = await coverage(v2, { to }, base);
          const after = await coverage(v3, { to }, base);
          if (after.state === 'covered' || after.state === 'not-collected') expect(before.state).toBe(after.state);
        },
      ),
    );
  });
});
