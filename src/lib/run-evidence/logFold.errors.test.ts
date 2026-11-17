import { describe, expect, it } from 'vitest';
import { readStoredRecord } from '../time-travel/storedRecord.js';
import { RUN_EVIDENCE_LIMITS } from './kinds.js';
import { readRunEvidence } from './read.js';

const address = { logRunId: 'r', drillPath: [] };
const opened = { kind: 'opened', address, at: 1, initialState: {}, collects: { v: 1, reads: 'keys' } };
const note = (data: unknown) => ({ kind: 'note', address, at: 1, note: 'run.stage', data });
const closed = { kind: 'closed', address, at: 1, outcome: 'ok', commits: 0, runNotes: 1 };
const read = (rows: readonly unknown[]) => readRunEvidence(readStoredRecord([opened, ...rows, closed]), 'r');

describe('run-evidence fixed refusal reasons', () => {
  it('does not inspect foreign errors thrown by a row prototype check', () => {
    let reads = 0;
    const second = new Proxy(
      {},
      {
        getPrototypeOf() {
          reads++;
          throw new Error('PRIVATE_ROW_ERROR');
        },
      },
    );
    const error = new Proxy(
      {},
      {
        getPrototypeOf() {
          reads++;
          throw second;
        },
      },
    );
    const data = new Proxy(
      { seq: 0, id: 'go#1' },
      {
        getPrototypeOf() {
          throw error;
        },
      },
    );
    let result: ReturnType<typeof read> | 'threw';
    try {
      result = read([note(data)]);
    } catch {
      result = 'threw';
    }
    expect(result).not.toBe('threw');
    if (result === 'threw') return;
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ROW_ERROR');
    expect(result.stages.status).toBe('partial');
    expect(reads).toBe(0);
  });

  it('retains its fixed duplicate reason', () => {
    const result = read([note({ seq: 0, id: 'go#1' }), note({ seq: 0, id: 'go#1' })]);
    expect(JSON.stringify(result)).toContain('a run note with a duplicate seq; the first stands');
  });

  it('keeps broad base-refusal codes from bounded row admission', () => {
    const result = read([note({ seq: 0, id: 'x'.repeat(RUN_EVIDENCE_LIMITS.text + 1) + '#1' })]);
    expect(JSON.stringify(result)).toContain('truncated');
  });
});
