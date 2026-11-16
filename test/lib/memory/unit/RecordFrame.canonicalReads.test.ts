import { describe, expect, it } from 'vitest';

import { EventLog } from '../../../../src/lib/memory/EventLog';
import { RecordFrame } from '../../../../src/lib/memory/RecordFrame';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';

const CANONICAL = { commitValues: 'full', writeProvenance: 'reads-prefix', nestedReadTracking: true } as const;

function setup(initial: Record<string, unknown> = {}, address: string[] = []) {
  const state = new SharedMemory(undefined, initial);
  const log = new EventLog(state.getState());
  const frame = new RecordFrame(state, log, address);
  frame.useEncoding(CANONICAL);
  return { state, log, frame };
}

function commit(frame: RecordFrame, stage = 'result') {
  frame.commit(() => ({ stage, stageId: stage, runtimeStageId: `${stage}#0` }));
  frame.release();
}

describe('RecordFrame canonical tracked read prefixes', () => {
  it('uses the write-path codec for nested names and keeps literal dotted keys distinct', () => {
    const { frame, log } = setup({ a: { b: 2 }, 'a.b': 3 });
    expect(frame.readTracked(['a'], 'b')).toBe(2);
    frame.noteRead(['a'], 'b'); // the existing producer notification adds no dotted alias
    frame.write(['nested'], 2, 'set');
    expect(frame.readTracked([], 'a.b')).toBe(3);
    frame.write(['literal'], 3, 'set');
    commit(frame);
    expect(log.list()[0].trace).toEqual([
      { path: 'nested', verb: 'set', readKeys: ['a\u001fb'] },
      { path: 'literal', verb: 'set', readKeys: ['a\u001fb', 'a.b'] },
    ]);
  });

  it('collects the selected namespace or root fallback rather than assuming the frame address', () => {
    const { frame, log } = setup({ cfg: { fee: 5 }, runs: { item: { cfg: { amount: 30 } } } }, ['runs', 'item']);
    expect(frame.readTracked(['cfg'], 'amount')).toBe(30);
    expect(frame.readTracked(['cfg'], 'fee')).toBe(5);
    frame.write(frame.at([], 'total'), 35, 'set');
    commit(frame);
    expect(log.list()[0].trace).toEqual([
      {
        path: 'runs\u001fitem\u001ftotal',
        verb: 'set',
        readKeys: ['runs\u001fitem\u001fcfg\u001famount', 'cfg\u001ffee'],
      },
    ]);
  });

  it('selects live root fallback after first touch and does not replay a getter to determine its address', () => {
    const { state, frame, log } = setup({}, ['runs', 'item']);
    frame.read([], 'absent'); // pin an empty first-touch view silently
    let calls = 0;
    Object.defineProperty(state.getState(), 'late', {
      configurable: true,
      get: () => {
        calls++;
        return 5;
      },
    });
    expect(frame.readTracked([], 'late')).toBe(5);
    expect(calls).toBe(1);
    frame.write(frame.at([], 'total'), 5, 'set');
    commit(frame);
    expect(log.list()[0].trace[0].readKeys).toEqual(['late']);
  });

  it('retains a staged hard undefined at the local address instead of assigning the root fallback', () => {
    const { frame, log } = setup({ cfg: { amount: 99 } }, ['runs', 'item']);
    frame.write(frame.at([], 'cfg'), { amount: undefined }, 'set');
    expect(frame.readTracked(['cfg'], 'amount')).toBeUndefined();
    frame.write(frame.at([], 'result'), 'missing', 'set');
    commit(frame);
    expect(log.list()[0].trace.at(-1)?.readKeys).toEqual(['runs\u001fitem\u001fcfg\u001famount']);
  });

  it('leaves internal, keyless and legacy-name-only notifications out of canonical evidence', () => {
    const { frame, log } = setup({ cfg: { n: 1 } });
    frame.read(['cfg'], 'n');
    frame.readTracked(['cfg']);
    frame.noteRead(['cfg'], 'n');
    frame.write(['result'], 1, 'set');
    commit(frame);
    expect(log.list()[0].trace[0].readKeys).toEqual([]);
  });

  it('does not retain a failed value read or evaluate it twice', () => {
    let calls = 0;
    const { frame, log } = setup();
    const raw = frame.state.getState();
    Object.defineProperty(raw, 'bad', {
      get: () => {
        calls++;
        throw new Error('failed read');
      },
    });
    expect(() => frame.readTracked([], 'bad')).toThrow('failed read');
    expect(calls).toBe(1);
    frame.write(['result'], 1, 'set');
    commit(frame);
    expect(log.list()[0].trace[0].readKeys).toEqual([]);
  });

  it('does not capture extra prefixes without reads-prefix, and keeps default dotted bytes', () => {
    const { frame, log } = setup({ cfg: { n: 1 } });
    frame.useEncoding({ ...CANONICAL, writeProvenance: 'off' });
    frame.readTracked(['cfg'], 'n');
    frame.write(['without'], 1, 'set');
    commit(frame);
    expect(log.list()[0].trace[0]).toEqual({ path: 'without', verb: 'set' });
    frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    frame.readTracked(['cfg'], 'n');
    frame.write(['legacy'], 1, 'set');
    commit(frame);
    expect(log.list()[1].trace[0].readKeys).toEqual(['cfg.n']);
  });

  it('readWithSource captures the same canonical fallback even when bounded source capture is absent', () => {
    const { frame, log } = setup({ cfg: { fee: 5 } }, ['runs', 'item']);
    expect(frame.readWithSource(['cfg'], 'fee', { runtimeStageId: 'combine#0' }).value).toBe(5);
    frame.noteRead(['cfg'], 'fee');
    frame.write(frame.at([], 'result'), 5, 'set');
    commit(frame);
    expect(log.list()[0].trace[0].readKeys).toEqual(['cfg\u001ffee']);
  });
});
