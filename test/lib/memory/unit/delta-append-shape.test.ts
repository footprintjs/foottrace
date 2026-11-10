/**
 * Under `commitValues: 'delta'` a grown array is recorded as an `append` of its tail, and replay
 * rebuilds it as `[...current, ...tail]`. A spread carries indexed elements only, so the append is
 * allowed only for an array that is dense and holds nothing but its indices. The check counted own
 * keys against the length, which a hole and a named key together satisfy: the append was written,
 * and replay (and live state, built from the same bundle) lost the named key and filled the hole.
 */
import { describe, expect, it } from 'vitest';

import { EventLog } from '../../../../src/lib/memory/EventLog.js';
import { RecordFrame } from '../../../../src/lib/memory/RecordFrame.js';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory.js';
import type { CommitValuesMode } from '../../../../src/lib/memory/types.js';

function write(next: unknown[], commitValues: CommitValuesMode) {
  const state = new SharedMemory(undefined, { h: [1, 2] });
  const log = new EventLog(state.getState());
  const frame = new RecordFrame(state, log);
  frame.useEncoding({ commitValues, writeProvenance: 'off' });
  frame.write(['h'], next, 'set');
  frame.commit(() => ({ stage: 's', stageId: 's', runtimeStageId: 's#0' }));
  frame.release();
  const live = state.getState().h as unknown[] & { note?: string };
  return { verb: log.list()[0].trace[0].verb, keys: Object.keys(live), note: live.note, length: live.length };
}

/** `[1, 2, <hole>, 4]` with a named key: four own keys, length four. */
function holeAndNamedKey(): unknown[] {
  const next: unknown[] & { note?: string } = [1, 2];
  next[3] = 4;
  next.note = 'n';
  return next;
}

describe("'delta' append — only for an array that survives a spread", () => {
  it('a hole and a named key that cancel out in the key count are a `set`, and nothing is lost', () => {
    const delta = write(holeAndNamedKey(), 'delta');
    expect(delta.verb).toBe('set');
    expect(delta).toEqual({ verb: 'set', keys: ['0', '1', '3', 'note'], note: 'n', length: 4 });
    expect(delta).toEqual(write(holeAndNamedKey(), 'full'));
  });

  it('a named key alone, and a hole alone, are a `set` too', () => {
    const named: unknown[] & { note?: string } = [1, 2, 3];
    named.note = 'n';
    expect(write(named, 'delta').verb).toBe('set');
    const holed: unknown[] = [1, 2];
    holed[3] = 4;
    expect(write(holed, 'delta').verb).toBe('set');
  });

  it('a dense array that only grew is still an `append`', () => {
    expect(write([1, 2, 3, 4], 'delta')).toEqual({
      verb: 'append',
      keys: ['0', '1', '2', '3'],
      note: undefined,
      length: 4,
    });
  });
});
