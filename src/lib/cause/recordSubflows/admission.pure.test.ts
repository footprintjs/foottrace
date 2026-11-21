import { describe, expect, it } from 'vitest';
import type { CommitBundle } from '../../memory/types.js';
import { prepareRecordSubflows } from './admission.js';

const parent = { logRunId: 'run-a', drillPath: [] as string[] };
function fixture() {
  const child = { logRunId: 'run-a', drillPath: ['mount#1'] };
  const log: CommitBundle[] = ['source#0', 'mount#1'].map((runtimeStageId, idx) => ({
    idx,
    runtimeStageId,
    stage: runtimeStageId,
    stageId: runtimeStageId,
    trace: [{ path: idx ? 'result' : 'source', verb: 'set', readKeys: [] }],
    overwrite: {},
    updates: {},
    redactedPaths: [],
  }));
  const input = {
    version: 1,
    attribution: 'observed-read-prefix',
    parent: { address: parent, beforeCommitIdx: 1 },
    child: { address: child, runtimeStageId: 'mount#1', commitIdx: 0 },
    writes: [{ path: 'seed', reads: ['source'] }],
    status: 'captured',
    limitations: [] as string[],
  };
  const output = {
    version: 1,
    attribution: 'observed-read-prefix',
    parent: { address: parent, runtimeStageId: 'mount#1', commitIdx: 1 },
    child: { address: child, beforeCommitIdx: 2 },
    writes: [{ path: 'result', reads: ['literal.dotted'] }],
    status: 'captured',
    limitations: [] as string[],
  };
  const collection = {
    version: 1,
    attribution: 'observed-scope-collection',
    parent: { address: parent, runtimeStageId: 'mount#1', commitIdx: 1, path: 'result' },
    totalItems: 1,
    branchCount: 1,
    slots: [{ index: 0, child: { address: child, beforeCommitIdx: 2 }, observation: 'scope-snapshot' }],
    status: 'captured',
    limitations: [] as string[],
  };
  const mount = { runtimeStageId: 'mount#1', child, inputHandoff: input, outputHandoff: output };
  const inventory = { version: 1, status: 'captured', mounts: [mount], collections: [collection] };
  return { log, input, output, collection, mount, inventory };
}
const read = (f: ReturnType<typeof fixture>, left = 10000, maxScopes = 32) =>
  prepareRecordSubflows(f.inventory, parent, f.log, { left }, maxScopes);
const refused = (f: ReturnType<typeof fixture>, code = 'invalid-data') => {
  const before = JSON.stringify(f.log);
  expect(read(f)).toEqual({ gaps: [code] });
  expect(JSON.stringify(f.log)).toBe(before);
};

describe('pure bounded metadata admission', () => {
  it('retains valid input/output and collection data without claiming graph completeness', () => {
    const f = fixture();
    expect(read(f)).toEqual({ record: f.inventory, gaps: [] });
  });
  it('makes absence optional and preserves a captured empty inventory', () => {
    expect(prepareRecordSubflows(undefined, parent, [], { left: 0 }, 32)).toEqual({ gaps: [] });
    const empty = { version: 1, status: 'captured', mounts: [], collections: [] };
    expect(prepareRecordSubflows(empty, parent, [], { left: 100 }, 32)).toEqual({ record: empty, gaps: [] });
  });
  it('accepts inert null-prototype own data', () => {
    const f = fixture();
    Object.setPrototypeOf(f.inventory, null);
    Object.setPrototypeOf(f.output, null);
    expect(read(f).gaps).toEqual([]);
    expect(read(f).record).toBeDefined();
  });
  it('detaches and freezes every retained object and list', () => {
    const f = fixture(),
      result = read(f).record!;
    const visit = (v: unknown): void => {
      if (v && typeof v === 'object') {
        expect(Object.isFrozen(v)).toBe(true);
        Object.values(v).forEach(visit);
      }
    };
    visit(result);
    f.output.writes[0].reads[0] = 'changed';
    f.mount.child.drillPath.push('other#2');
    f.collection.slots.splice(0);
    expect(result.mounts[0].outputHandoff!.writes[0].reads).toEqual(['literal.dotted']);
    expect(result.mounts[0].child.drillPath).toEqual(['mount#1']);
    expect(result.collections[0].slots).toHaveLength(1);
  });
  it('does not call getters, toJSON or proxy property reads', () => {
    const f = fixture();
    let calls = 0;
    Object.defineProperty(f.output, 'writes', {
      enumerable: true,
      get() {
        calls++;
        throw Error('private');
      },
    });
    refused(f);
    expect(calls).toBe(0);
    const g = fixture();
    Object.assign(g.inventory, {
      toJSON() {
        calls++;
        throw Error('private');
      },
    });
    refused(g);
    const h = fixture();
    h.inventory = new Proxy(h.inventory, {
      get() {
        calls++;
        throw Error('private');
      },
    });
    expect(read(h).record).toBeDefined();
    expect(calls).toBe(0);
  });
  it('contains trap failures without copying their text', () => {
    const f = fixture();
    f.inventory = new Proxy(f.inventory, {
      ownKeys() {
        throw Error('PRIVATE');
      },
    });
    expect(read(f)).toEqual({ gaps: ['invalid-data'] });
  });
  it('rejects hidden, inherited and symbol fields', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => Object.defineProperty(f.inventory, 'private', { value: 'secret' }),
      (f: ReturnType<typeof fixture>) => Object.setPrototypeOf(f.inventory, { hidden: true }),
      (f: ReturnType<typeof fixture>) => Object.assign(f.inventory, { [Symbol('private')]: 'secret' }),
    ]) {
      const f = fixture();
      mutate(f);
      refused(f);
    }
  });
  it('counts fields before traversing a sparse oversized list', () => {
    const f = fixture();
    let calls = 0;
    f.inventory.mounts = new Array(257);
    Object.defineProperty(f.inventory.mounts, '0', {
      get() {
        calls++;
        throw Error('private');
      },
    });
    expect(read(f)).toEqual({ gaps: ['node-limit'] });
    expect(calls).toBe(0);
  });
  it('rejects a sparse or extended array without invoking entries', () => {
    const f = fixture();
    delete f.output.writes[0].reads[0];
    refused(f);
    const g = fixture();
    Object.assign(g.output.writes[0].reads, { extra: 'private' });
    refused(g);
  });
  it('uses the shared field budget, without changing the admitted log', () => {
    const f = fixture(),
      budget = { left: 10 };
    expect(prepareRecordSubflows(f.inventory, parent, f.log, budget, 32)).toEqual({ gaps: ['node-limit'] });
    expect(budget.left).toBeLessThan(0);
    expect(f.log).toHaveLength(2);
  });
  it('refuses reader writes beyond the native trace ceiling before projecting them', () => {
    const f = fixture();
    f.output.writes = Array.from({ length: 129 }, (_, i) => ({ path: `p${i}`, reads: [] }));
    refused(f, 'node-limit');
  });
  it('limits source references even where the number of writes is small', () => {
    const f = fixture();
    f.output.writes[0].reads = Array.from({ length: 4097 }, (_, i) => `r${i}`);
    refused(f, 'node-limit');
  });
  it('refuses a reference list whose UTF-8 bytes exceed the envelope despite fewer code units', () => {
    const f = fixture();
    f.output.writes[0].reads = Array.from({ length: 40 }, (_, index) => `${index}:${'é'.repeat(1000)}`);
    refused(f, 'node-limit');
  });
  it('retains literal dots and refuses a root reference containing the path separator', () => {
    const f = fixture();
    expect(read(f).record!.mounts[0].outputHandoff!.writes[0].reads).toEqual(['literal.dotted']);
    f.output.writes[0].reads = ['a\u001fb'];
    refused(f);
  });
  it('binds output to its actual committed path and rejects an exit', () => {
    const f = fixture();
    f.output.writes[0].path = 'missing';
    refused(f);
    const g = fixture();
    g.log[1].phase = 'exit';
    refused(g);
  });
  it('charges the shared index, later execution bundles and each path comparison', () => {
    const f = fixture();
    const start = 10000;
    const baseline = { left: start };
    expect(prepareRecordSubflows(f.inventory, parent, f.log, baseline, 32).record).toBeDefined();
    const later = f.log[1];
    f.log.push(
      { ...later, idx: 2, runtimeStageId: 'other#2' },
      { ...later, idx: 3, phase: 'exit' },
      { ...later, idx: 4, phase: 'repeat', trace: [{ path: 'other', verb: 'set' }] },
    );
    // Index the three added bundles, then visit the two matching bundles and compare one path.
    const extraWork = 3 + 2 + 1;
    const at = { left: start - baseline.left + extraWork };
    expect(prepareRecordSubflows(f.inventory, parent, f.log, at, 32).record).toBeDefined();
    expect(at.left).toBe(0);
    const below = { left: start - baseline.left + extraWork - 1 };
    expect(prepareRecordSubflows(f.inventory, parent, f.log, below, 32)).toEqual({ gaps: ['node-limit'] });
    expect(f.log).toHaveLength(5);
  });
  it('skips the suffix when an output handoff maps no writes', () => {
    const f = fixture();
    f.output.writes = [];
    const budget = { left: 10000 };
    expect(prepareRecordSubflows(f.inventory, parent, f.log, budget, 32).record).toBeDefined();
    const after = { left: 10000 };
    f.log.push({ ...f.log[1], idx: 2, phase: 'repeat' });
    expect(prepareRecordSubflows(f.inventory, parent, f.log, after, 32).record).toBeDefined();
    expect(after.left).toBe(budget.left);
  });
  it('refuses a future parent cutoff instead of borrowing a later write', () => {
    const f = fixture();
    f.input.parent.beforeCommitIdx = 2;
    refused(f);
  });
  it('retains a missing parent commit as explicit incomplete coverage', () => {
    const f = fixture();
    f.inventory.collections = [];
    Reflect.deleteProperty(f.mount, 'outputHandoff');
    f.log.pop();
    expect(read(f).gaps).toEqual(['not-collected']);
    expect(read(f).record!.mounts[0].inputHandoff).toEqual(f.input);
  });
  it.each(['privacy-active', 'parent-log-advanced', 'selector-reads-unavailable'])(
    'withholds input reads for %s',
    (code) => {
      const f = fixture();
      f.input.status = 'partial';
      f.input.limitations = [code];
      refused(f);
      f.input.writes[0].reads = [];
      expect(read(f).record).toBeDefined();
    },
  );
  it('accepts a restored seed only as partial with no asserted mapped writes', () => {
    const f = fixture();
    f.input.status = 'partial';
    f.input.limitations = ['resume-seed'];
    refused(f);
    f.input.writes = [];
    expect(read(f).record).toBeDefined();
  });
  it('requires privacy to remove output reads and fanout child slots', () => {
    const f = fixture();
    f.output.status = 'partial';
    f.output.limitations = ['privacy-active'];
    refused(f);
    f.output.writes[0].reads = [];
    expect(read(f).record).toBeDefined();
    f.collection.status = 'partial';
    f.collection.limitations = ['privacy-active'];
    refused(f);
    f.collection.slots = [];
    expect(read(f).record).toBeDefined();
  });
  it('accepts a true zero-branch collection, but no fabricated slot', () => {
    const f = fixture();
    f.collection.totalItems = 0;
    f.collection.branchCount = 0;
    f.collection.slots = [];
    expect(read(f).record).toBeDefined();
    f.collection.slots = fixture().collection.slots;
    refused(f);
  });
  it('requires explicit partial evidence for an unknown omitted child', () => {
    const f = fixture();
    f.collection.slots = [];
    refused(f);
    f.collection.status = 'partial';
    f.collection.limitations = ['missing-child-record'];
    expect(read(f).record!.collections[0].branchCount).toBe(1);
  });
  it('records truncation independently of dispatched slot coverage', () => {
    const f = fixture();
    f.collection.totalItems = 2;
    refused(f);
    f.collection.status = 'partial';
    f.collection.limitations = ['branches-truncated'];
    expect(read(f).record!.collections[0].slots).toHaveLength(1);
  });
  it.each(['explicit-output', 'failed-slot'])('keeps %s distinct from a scope snapshot', (observation) => {
    const f = fixture();
    f.collection.slots[0].observation = observation;
    refused(f);
    f.collection.status = 'partial';
    f.collection.limitations = [observation];
    expect(read(f).record!.collections[0].slots[0].observation).toBe(observation);
  });
  it('requires each slot to have a known native child identity', () => {
    const f = fixture();
    Reflect.deleteProperty(f.collection.slots[0], 'child');
    refused(f);
  });
  it('keeps actual slot indexes ordered and unique', () => {
    const f = fixture();
    f.collection.totalItems = f.collection.branchCount = 2;
    f.collection.slots.push({
      index: 1,
      child: { address: { logRunId: 'run-a', drillPath: ['other#2'] }, beforeCommitIdx: 0 },
      observation: 'scope-snapshot',
    });
    expect(read(f).record).toBeDefined();
    f.collection.slots.reverse();
    refused(f);
  });
});
