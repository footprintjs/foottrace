import { describe, expect, it } from 'vitest';
import { assertCaptureState, assertSeedBinding, uniqueStage } from './verify-native.mjs';
import * as readerIds from '../../../src/lib/ids/runtimeStageId';
import { nativeExecution as canonicalNativeExecution } from '../../../src/lib/ids/nativeExecution';

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

  it.each(['missing', 'address', 'runtime', 'cutoff', 'seed-runtime', 'seed-index', 'writes'])(
    'rejects a mismatched generated seed: %s',
    (fault) => {
      const { mount, child } = fixture();
      if (fault === 'missing') Reflect.deleteProperty(mount, 'inputHandoff');
      if (fault === 'address') mount.inputHandoff.child.address = { logRunId: 'other', drillPath: [] };
      if (fault === 'runtime') mount.inputHandoff.child.runtimeStageId = 'other';
      if (fault === 'cutoff') mount.inputHandoff.child.commitIdx = 1;
      if (fault === 'seed-runtime') child.commitLog[0].runtimeStageId = 'other';
      if (fault === 'seed-index') child.commitLog[0].idx = 1;
      if (fault === 'writes') mount.inputHandoff.writes = [];
      expect(() => assertSeedBinding(mount, child)).toThrow();
    },
  );
});

describe('native fixture stage identity', () => {
  // Projection from the real source-producer diagnostic after the inspected hosted pair failed.
  // Display names are prefixed on mount; neither display spelling nor a suffix identifies a record.
  const row = () => ({
    idx: 1,
    stage: 'mapped/Compute',
    stageId: 'mapped/compute',
    runtimeStageId: 'mapped/compute#2',
  });
  it('binds the namespaced work by exact native stage ID', () => {
    const scope = {
      commitLog: [{ idx: 0, stage: 'Mapped child', stageId: 'mapped', runtimeStageId: 'mapped#1' }, row()],
    };
    expect(uniqueStage(scope, 'mapped/compute', readerIds)).toBe(1);
  });
  it('rejects display-label lookalikes in a different namespace', () => {
    const other = {
      ...row(),
      idx: 0,
      stage: 'mapped/compute',
      stageId: 'other/compute',
      runtimeStageId: 'other/compute#2',
    };
    expect(() => uniqueStage({ commitLog: [other] }, 'mapped/compute', readerIds)).toThrow();
  });
  it.each([
    'other/compute#2',
    'mapped/compute',
    'mapped/compute#NaN',
    'mapped/compute#-1',
    'mapped/compute#9007199254740992',
  ])('rejects an inconsistent execution tuple: %s', (runtimeStageId) => {
    const other = { ...row(), idx: 0, stage: 'mapped/compute', runtimeStageId };
    expect(() => uniqueStage({ commitLog: [other] }, 'mapped/compute', readerIds)).toThrow();
  });
  it('does not admit an empty local stage that the canonical record owner rejects', () => {
    expect(canonicalNativeExecution('#2')).toBeUndefined();
    const other = { ...row(), idx: 0, stageId: '', runtimeStageId: '#2' };
    expect(() => uniqueStage({ commitLog: [other] }, '', readerIds)).toThrow();
  });
  it('still rejects duplicate matching work records', () => {
    expect(() => uniqueStage({ commitLog: [row(), { ...row(), idx: 2 }] }, 'mapped/compute', readerIds)).toThrow();
  });
});
