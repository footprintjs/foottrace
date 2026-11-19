import { describe, expect, it, vi } from 'vitest';

import { stateAt } from '../../../src/index.js';
import { foldLegsFrom, readSource } from '../../../src/lib/time-travel/stateAt.js';

describe('a one-shot replay owns its result', () => {
  it('copies the seed once and hands out the detached, deeply frozen plain graph', () => {
    const shared = { value: 3 };
    const seed = { left: shared, right: shared, list: [shared] };
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      const { state } = stateAt({ initialState: seed, commitLog: [] }, -1);
      expect(clone).toHaveBeenCalledTimes(1);
      expect(state.left).toBe(state.right);
      expect(state.left).toBe((state.list as object[])[0]);
      expect(state.left).not.toBe(shared);
      expect(Object.isFrozen(state.left)).toBe(true);
      shared.value++;
      expect(state.left).toEqual({ value: 3 });
    } finally {
      clone.mockRestore();
    }
  });

  it('freezes a plain result after a write without another whole-state copy', () => {
    const source = {
      initialState: { untouched: { name: 'storage' } },
      commitLog: [{ runtimeStageId: 'a', trace: [{ verb: 'set', path: 'value' }], overwrite: { value: [7] } }],
    };
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      const { state } = stateAt(source, 0);
      expect(clone).toHaveBeenCalledTimes(2); // the seed and recorded operand
      expect(Object.isFrozen(state.value)).toBe(true);
      expect(source.commitLog[0]!.overwrite.value).not.toBe(state.value);
    } finally {
      clone.mockRestore();
    }
  });

  it('preserves cycles, recorded values, redactions and gaps, and leaves the cursor free to advance', () => {
    const alias = { count: 2 };
    const graph = { alias, aliasAgain: alias, self: {} };
    graph.self = graph;
    const operand = { digest: [1, 2] };
    const source = {
      initialState: { graph },
      commitLog: [
        null,
        {
          runtimeStageId: 'a',
          trace: [{ verb: 'set', path: 'result' }],
          overwrite: { result: operand },
          redactedPaths: ['secret'],
        },
        {
          runtimeStageId: 'b',
          trace: [{ verb: 'set', path: 'result\u001fdigest' }],
          overwrite: { result: { digest: [3] } },
        },
      ],
    };
    const leg = readSource(source);
    const first = foldLegsFrom([leg], 0, 1);
    const one = stateAt(source, 1);
    expect(one).toEqual(first.folded);
    expect(one.state.graph).not.toBe(graph);
    const copy = one.state.graph as typeof graph;
    expect(copy.self).toBe(copy);
    expect(copy.alias).toBe(copy.aliasAgain);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen((one.state.result as typeof operand).digest)).toBe(true);
    expect(Object.isFrozen(operand.digest)).toBe(false);
    operand.digest[0] = 9;
    expect((one.state.result as typeof operand).digest).toEqual([1, 2]);
    const next = foldLegsFrom([leg], 0, 2, first.memo);
    expect(next.folded).toEqual(stateAt(source, 2));
    expect((first.folded.state.result as typeof operand).digest).toEqual([1, 2]);
    expect(Object.isFrozen(first.memo.out)).toBe(false);
  });

  it('detaches binary operands and preserves aliases in an appended tail with no recorded seed', () => {
    const bytes = new Uint8Array([3, 7]);
    const source = {
      history: [
        { runtimeStageId: 'a', trace: [{ verb: 'append', path: 'data' }], overwrite: { data: [bytes, bytes] } },
      ],
    };
    const result = stateAt(source, 0);
    expect(result.basis).toBe('log-only');
    const tail = result.state.data as Uint8Array[];
    expect(tail[0]).toBe(tail[1]);
    expect(tail[0]).not.toBe(bytes);
    tail[0]![0] = 9;
    expect(bytes[0]).toBe(3);
    expect((stateAt(source, 0).state.data as Uint8Array[])[0]![0]).toBe(3);
  });

  it('preserves native clone normalization and isolation on mutable non-JSON leaves', () => {
    const bytes = new Uint8Array([3, 7]);
    const source = {
      initialState: { bytes, buffer: bytes.buffer, clock: new Date(10), rx: /x/g, objects: new Map([['a', { n: 1 }]]) },
      commitLog: [
        {
          runtimeStageId: 'a',
          trace: [
            { verb: 'set', path: 'clock\u001fnote' },
            { verb: 'set', path: 'rx\u001flastIndex' },
          ],
          overwrite: { clock: { note: 'private expando' }, rx: { lastIndex: 3 } },
        },
      ],
    };
    const standalone = stateAt(source, 0);
    const cursor = foldLegsFrom([readSource(source)], 0, 0);
    expect(standalone).toEqual(cursor.folded);
    const state = standalone.state as typeof source.initialState;
    expect(Object.hasOwn(state.clock, 'note')).toBe(false);
    expect(state.rx.lastIndex).toBe(0);
    expect(state.bytes.buffer).toBe(state.buffer);
    state.bytes.fill(5);
    state.clock.setTime(14);
    state.objects.get('a')!.n = 4;
    expect(source.initialState.bytes[0]).toBe(3);
    expect(source.initialState.clock.getTime()).toBe(10);
    expect(source.initialState.objects.get('a')!.n).toBe(1);
    const second = stateAt(source, 0).state as typeof source.initialState;
    expect(second.bytes[0]).toBe(3);
    expect(second.clock.getTime()).toBe(10);
    expect(second.objects.get('a')!.n).toBe(1);
  });
});
