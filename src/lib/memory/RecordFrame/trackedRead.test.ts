import { expect, it } from 'vitest';
import { EventLog, RecordFrame, SharedMemory } from '../../../write.js';

for (const located of [false, true])
  for (const source of [false, true]) {
    it(`preserves the original tracking decision across a reentrant encoding change: located=${located}, source=${source}`, () => {
      const state = new SharedMemory(undefined, { cfg: {} });
      const log = new EventLog(state.getState());
      const frame = new RecordFrame(state, log);
      frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix', nestedReadTracking: true });
      Object.defineProperty(state.getState().cfg as object, 'n', {
        get() {
          frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix', nestedReadTracking: false });
          return 7;
        },
      });
      const owner = { runtimeStageId: 'read#0' };
      const value = located
        ? source
          ? frame.readWithLocation(['cfg'], 'n', owner).value
          : frame.readWithLocation(['cfg'], 'n').value
        : source
        ? frame.readWithSource(['cfg'], 'n', owner).value
        : frame.readTracked(['cfg'], 'n');
      expect(value).toBe(7);
      frame.write(['result'], value, 'set');
      frame.commit(() => ({ stage: 'Write', stageId: 'write', runtimeStageId: 'write#0' }));
      // Original tracked mode decides before reading; original source mode checks again after reading.
      expect(log.list()[0].trace[0].readKeys).toEqual(source ? [] : ['cfg\u001fn']);
    });
  }
