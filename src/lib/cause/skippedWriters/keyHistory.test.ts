import { describe, expect, it } from 'vitest';

import { EventLog } from '../../memory/EventLog.js';
import type { LogAddress } from '../../memory/eventPosition.js';
import { LOG_PLACEHOLDER } from '../../memory/placeholders.js';
import { type RecordEntry, memorySink } from '../../memory/sink.js';
import type { CommitBundle, MemoryPatch, TraceEntry } from '../../memory/types.js';
import { normalisePath } from '../../record-paths/codec.js';
import { readStoredRecord } from '../../time-travel/storedRecord.js';
import { readSkippedKeyHistory } from './keyHistory.js';

const root: LogAddress = { logRunId: 'run', drillPath: [] };

function record(base: Record<string, unknown>, bundles: CommitBundle[], address = root) {
  const sink = memorySink();
  const log = new EventLog(base, { sink, address });
  for (const item of bundles) log.record(item);
  log.close('ok');
  return sink.entries;
}

function bundle(
  stageId: string,
  trace: TraceEntry[],
  overwrite: MemoryPatch = {},
  updates: MemoryPatch = {},
  redactedPaths: string[] = [],
): CommitBundle {
  return { stageId, stage: stageId, runtimeStageId: `${stageId}#0`, trace, overwrite, updates, redactedPaths };
}

function history(entries: readonly RecordEntry[], key: string, beforeIdx: number, budget = { left: 1000 }) {
  return readSkippedKeyHistory(readStoredRecord(entries).log(root)!, key, beforeIdx, budget);
}

describe('readSkippedKeyHistory', () => {
  it('separates a whole-commit net change from repeated and reverted direct writes', () => {
    const entries = record({ stock: 5 }, [
      bundle('seed-no-op', [{ path: 'stock', verb: 'set' }], { stock: 5 }),
      bundle('drop', [{ path: 'stock', verb: 'delete' }]),
      bundle(
        'revert',
        [
          { path: 'stock', verb: 'set' },
          { path: 'stock', verb: 'delete' },
        ],
        { stock: 8 },
      ),
      bundle('future', [{ path: 'stock', verb: 'set' }], { stock: 6 }),
    ]);
    expect(history(entries, 'stock', 1)).toEqual({ status: 'ready', observed: new Set(['seed-no-op']) });
    expect(history(entries, 'stock', 3)).toEqual({
      status: 'ready',
      lastChangeIdx: 1,
      observed: new Set(['seed-no-op', 'drop', 'revert']),
    });
  });

  it('retains presence differences even when the key reads as undefined on both sides', () => {
    const entries = record({ stock: undefined }, [bundle('drop', [{ path: 'stock', verb: 'delete' }])]);
    expect(history(entries, 'stock', 1)).toEqual({ status: 'ready', lastChangeIdx: 0, observed: new Set(['drop']) });
  });

  it.each(['full', 'delta'] as const)('tests an ancestor by net effect for %s payloads', (encoding) => {
    const key = normalisePath(['sku', 'stock']);
    const entries = record({ sku: { stock: [1], price: 1 } }, [
      bundle('prices', [{ path: 'sku', verb: 'set' }], { sku: { stock: [1], price: 2 } }),
      bundle('update-stock', [{ path: key, verb: encoding === 'full' ? 'set' : 'append' }], {
        sku: { stock: encoding === 'full' ? [1, 2] : [2] },
      }),
    ]);
    expect(history(entries, key, 2)).toEqual({
      status: 'ready',
      lastChangeIdx: 1,
      observed: new Set(['update-stock']),
    });
  });

  it('sees a changed key under a parent write without counting another scope', () => {
    const key = normalisePath(['sku', 'stock']);
    const parent = record({ sku: { stock: 1 } }, [
      bundle('parent', [{ path: 'sku', verb: 'set' }], { sku: { stock: 2 } }),
    ]);
    const child = record({ stock: 1 }, [bundle('child', [{ path: 'stock', verb: 'set' }], { stock: 2 })], {
      ...root,
      drillPath: ['mount#1'],
    });
    expect(history([...child, ...parent], key, 1)).toEqual({
      status: 'ready',
      lastChangeIdx: 0,
      observed: new Set(['parent']),
    });
  });

  it('refuses a lost opening or a missing commit inside the prefix', () => {
    const entries = record({}, [
      bundle('set', [{ path: 'stock', verb: 'set' }], { stock: 1 }),
      bundle('drop', [{ path: 'stock', verb: 'delete' }]),
    ]);
    expect(history(entries.slice(1), 'stock', 1)).toEqual({ status: 'unknown', reason: 'not-collected' });
    expect(
      history(
        entries.filter((_, index) => index !== 1),
        'stock',
        2,
      ),
    ).toEqual({
      status: 'unknown',
      reason: 'not-collected',
    });
    expect(
      history(
        entries.filter((_, index) => index !== 2),
        'stock',
        1,
      ),
    ).toEqual({
      status: 'ready',
      lastChangeIdx: 0,
      observed: new Set(['set']),
    });
  });

  it('reports related redaction and ambiguous served base values without comparing them', () => {
    const entries = record({}, [bundle('mark', [{ path: 'sku', verb: 'set' }], { sku: LOG_PLACEHOLDER }, {}, ['sku'])]);
    expect(history(entries, normalisePath(['sku', 'stock']), 1)).toEqual({ status: 'unknown', reason: 'redacted' });
    expect(history(record({ sku: LOG_PLACEHOLDER }, []), normalisePath(['sku', 'stock']), 0)).toEqual({
      status: 'unknown',
      reason: 'conservative',
    });
  });

  it('does not poison the shared allowance when malformed marks pass structural log admission', () => {
    const entries = record({}, [bundle('set', [{ path: 'stock', verb: 'set' }], { stock: 1 })]);
    const supplied = entries.map((entry) =>
      entry.kind === 'commit' ? { ...entry, bundle: { ...entry.bundle, redactedPaths: [1] } } : entry,
    );
    const log = readStoredRecord(supplied).log(root)!;
    const budget = { left: 1000 };
    expect(readSkippedKeyHistory(log, 'stock', 1, budget)).toEqual({ status: 'unknown', reason: 'invalid-data' });
    expect(Number.isFinite(budget.left)).toBe(true);
  });

  it('charges selected text comparisons to the shared budget', () => {
    const entries = record({ stock: 'a'.repeat(2000) }, [
      bundle('set', [{ path: 'stock', verb: 'set' }], { stock: 'b'.repeat(2000) }),
    ]);
    const budget = { left: 1000 };
    expect(history(entries, 'stock', 1, budget)).toEqual({ status: 'unknown', reason: 'truncated' });
    expect(budget.left).toBeLessThan(1);
  });
});
