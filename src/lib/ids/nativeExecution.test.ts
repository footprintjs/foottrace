import { describe, expect, it } from 'vitest';
import { nativeExecution } from './nativeExecution.js';

describe('native execution admission', () => {
  it('admits the first execution without a subflow', () => {
    expect(nativeExecution('score#0')).toEqual({
      stageId: 'score',
      executionIndex: 0,
      subflowPath: undefined,
    });
  });

  it('preserves a nested subflow address and a safe execution index', () => {
    expect(nativeExecution('outer/inner/score#9007199254740991')).toEqual({
      stageId: 'score',
      executionIndex: Number.MAX_SAFE_INTEGER,
      subflowPath: 'outer/inner',
    });
  });

  it.each(['', 'score', '#1', '/score#1', 'score#', 'score#-1', 'score#9007199254740992'])(
    'refuses an absent or invalid execution address: %j',
    (id) => expect(nativeExecution(id)).toBeUndefined(),
  );

  it.each(['score#01', 'score#+1', 'score#-0', 'score#1.5', 'score#1suffix'])(
    'refuses a suffix the permissive parser cannot round-trip: %j',
    (id) => expect(nativeExecution(id)).toBeUndefined(),
  );
});
