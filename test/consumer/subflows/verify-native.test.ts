import { describe, expect, it } from 'vitest';
import { assertCaptureState, assertSeedBinding } from './verify-native.mjs';

// Contract controls for the protocol assertions, not a substitute for the installed native pair.
function fixture() {
  const address = { logRunId: 'one', drillPath: ['actual-mount'] };
  const inputHandoff = {
    version: 1,
    attribution: 'observed-read-prefix',
    status: 'captured',
    limitations: [] as string[],
    child: { address, runtimeStageId: 'actual-mount', commitIdx: 0 },
    writes: [{ path: 'item', reads: ['items'] }],
  };
  return {
    mount: { child: address, runtimeStageId: 'actual-mount', inputHandoff },
    child: { commitLog: [{ idx: 0, runtimeStageId: 'actual-mount', trace: [{ path: 'item' }] }] },
  };
}

describe('native protocol capture assertions', () => {
  it('accepts the unmodified seed and explicit capture claim', () => {
    const { mount, child } = fixture();
    expect(() => assertCaptureState(mount.inputHandoff)).not.toThrow();
    expect(() => assertSeedBinding(mount, child)).not.toThrow();
  });

  it('does not accept degraded raw capture as the successful fixture', () => {
    const { mount } = fixture();
    mount.inputHandoff.status = 'partial';
    mount.inputHandoff.limitations = ['budget-exhausted'];
    expect(() => assertCaptureState(mount.inputHandoff)).toThrow();
  });

  it('does not accept a partial claim without its limitation', () => {
    const { mount } = fixture();
    mount.inputHandoff.status = 'partial';
    expect(() => assertCaptureState(mount.inputHandoff)).toThrow();
  });

  it.each([false, true])('keeps privacy and selector uncertainty explicit: %s', (selectorUnavailable) => {
    const { mount } = fixture();
    const handoff = mount.inputHandoff;
    handoff.status = 'partial';
    handoff.limitations = ['privacy-active', ...(selectorUnavailable ? ['selector-reads-unavailable'] : [])];
    handoff.writes[0].reads = [];
    expect(() => assertCaptureState(handoff, { privateView: true, selectorUnavailable })).not.toThrow();
    handoff.limitations = selectorUnavailable ? ['selector-reads-unavailable'] : [];
    expect(() => assertCaptureState(handoff, { privateView: true, selectorUnavailable })).toThrow();
  });

  it('rejects source names in an explicitly private view', () => {
    const { mount } = fixture();
    mount.inputHandoff.status = 'partial';
    mount.inputHandoff.limitations = ['privacy-active'];
    expect(() => assertCaptureState(mount.inputHandoff, { privateView: true })).toThrow();
  });

  it.each(['missing', 'address', 'runtime', 'cutoff', 'seed-runtime', 'seed-index', 'writes'])
    ('rejects a mismatched generated seed: %s', (fault) => {
      const { mount, child } = fixture();
      if (fault === 'missing') Reflect.deleteProperty(mount, 'inputHandoff');
      if (fault === 'address') mount.inputHandoff.child.address = { logRunId: 'other', drillPath: [] };
      if (fault === 'runtime') mount.inputHandoff.child.runtimeStageId = 'other';
      if (fault === 'cutoff') mount.inputHandoff.child.commitIdx = 1;
      if (fault === 'seed-runtime') child.commitLog[0].runtimeStageId = 'other';
      if (fault === 'seed-index') child.commitLog[0].idx = 1;
      if (fault === 'writes') mount.inputHandoff.writes = [];
      expect(() => assertSeedBinding(mount, child)).toThrow();
    });
});
