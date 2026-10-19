import { describe, expect, it, vi } from 'vitest';
import { dataString, ProvBudget } from '../../../src/lib/prov/budget.js';
import { admitProvRecord } from '../../../src/lib/prov/admission.js';
import { provOptions, ProvExportRefusal } from '../../../src/lib/prov/options.js';

const limits = () => provOptions({ base: 'urn:example:run:one/' });
const bundle = (path = 'x', extra: Record<string, unknown> = {}) => ({
  runtimeStageId: 'write#0',
  trace: [{ path, verb: 'set' }],
  ...extra,
});

describe('PROV ordinary record admission', () => {
  it('keeps historical optional fields and empty paths without reading state values', () => {
    let calls = 0;
    const patch = Object.defineProperty({}, 'x', {
      enumerable: true,
      get: () => {
        calls++;
        throw Error('secret');
      },
    });
    const source = { initialState: patch, commitLog: [bundle('', { overwrite: patch })] };
    const result = admitProvRecord(source, limits());
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].rows[0].path).toBe('');
    expect(result.log[0].overwrite).toEqual({});
    expect(result.complete).toBe(false);
    expect(calls).toBe(0);
  });

  it('preserves original indexes and canonical replay refusal reasons', () => {
    const result = admitProvRecord({ commitLog: [bundle(), null, bundle('y')] }, limits());
    expect(result.commits.map((c) => c.commitIdx)).toEqual([0, 2]);
    expect(result.log).toHaveLength(3);
    expect(result.gaps).toContainEqual({ code: 'invalid-data', commitIdx: 1, reason: 'not an object (null)' });
  });

  it('never invokes bundle or row getters', () => {
    let calls = 0;
    const bad = Object.defineProperty({}, 'runtimeStageId', {
      get: () => {
        calls++;
        return 'private#0';
      },
    });
    const result = admitProvRecord({ commitLog: [bad] }, limits());
    expect(calls).toBe(0);
    expect(result.commits).toHaveLength(0);
    expect(result.gaps.some((g) => g.code === 'invalid-data')).toBe(true);
  });

  it('collects redaction over later writes before disclosing earlier paths', () => {
    const result = admitProvRecord(
      { commitLog: [bundle('secret'), bundle('secret', { redactedPaths: ['secret'] })] },
      limits(),
    );
    expect(result.privacy.hides('secret')).toBe(true);
    expect(result.privacy.hides('secret\u001fnested')).toBe(true);
    expect(result.privacy.hides('other')).toBe(false);
  });

  it('fails privacy closed when a later redaction list cannot be inspected', () => {
    let calls = 0;
    const later = Object.defineProperty(bundle('later'), 'redactedPaths', {
      get: () => {
        calls++;
        return [];
      },
    });
    const result = admitProvRecord({ commitLog: [bundle('early'), later] }, limits());
    expect(calls).toBe(0);
    expect(result.privacy.hideAllPaths).toBe(true);
    expect(result.privacy.hides('early')).toBe(true);
  });

  it('does not claim privacy for an uninspected truncated tail', () => {
    const result = admitProvRecord(
      { commitLog: [bundle('early'), bundle('late', { redactedPaths: ['early'] })] },
      provOptions({ base: 'urn:test:', maxCommits: 1 }),
    );
    expect(result.privacy.hideAllPaths).toBe(true);
    expect(result.gaps.some((g) => g.code === 'truncated')).toBe(true);
  });

  it('retains repeated rows, original ordinals and read-prefix empty versus absent', () => {
    const result = admitProvRecord(
      {
        commitLog: [
          bundle('x', {
            trace: [
              { path: 'x', verb: 'set', readKeys: [] },
              { path: 'x', verb: 'set', readKeys: ['a'] },
            ],
          }),
        ],
      },
      limits(),
    );
    expect(result.commits[0].rows.map((r) => [r.rowIdx, r.readKeys])).toEqual([
      [0, []],
      [1, ['a']],
    ]);
  });

  it('collects stageReads keys only, keeps captured empty maps and bounds cyclic trees', () => {
    let calls = 0;
    const stageReads = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        calls++;
        throw Error('secret');
      },
    });
    const tree: Record<string, unknown> = { runtimeStageId: 'write#0', stageReads };
    tree.next = tree;
    const result = admitProvRecord(
      { commitLog: [bundle()], executionTree: tree, reads: { 'empty#1': [] }, controlDeps: {}, attention: {} },
      limits(),
    );
    expect(result.reads?.get('write#0')).toEqual(['secret']);
    expect(result.reads?.get('empty#1')).toEqual([]);
    expect(result.control?.size).toBe(0);
    expect(result.attention?.size).toBe(0);
    expect(result.gaps.some((g) => g.code === 'cycle')).toBe(true);
    expect(calls).toBe(0);
  });

  it('bounds pending tree work before inspecting children beyond the node allowance', () => {
    let inspected = 0;
    const first = new Proxy(
      { runtimeStageId: 'first#1' },
      {
        getOwnPropertyDescriptor(target, key) {
          inspected++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const result = admitProvRecord(
      {
        commitLog: [],
        executionTree: {
          runtimeStageId: 'root#0',
          next: first,
          children: [{ runtimeStageId: 'second#2' }, { runtimeStageId: 'third#3' }],
        },
      },
      provOptions({ base: 'urn:test:', maxNodes: 2 }),
    );
    expect(result.gaps.some((gap) => gap.code === 'truncated')).toBe(true);
    // The next node gets its reserved allowance rather than being displaced by queued children.
    expect(inspected).toBeGreaterThan(0);
  });

  it('unions repeated write-prefix evidence in linear retained-read work', () => {
    let added = 0;
    const original = Set.prototype.add;
    const spy = vi.spyOn(Set.prototype, 'add').mockImplementation(function (this: Set<unknown>, value: unknown) {
      if (typeof value === 'string' && value.startsWith('source:')) added++;
      return original.call(this, value);
    });
    try {
      const trace = Array.from({ length: 160 }, (_, index) => ({
        path: 'x',
        verb: 'set',
        readKeys: [`source:${index}`],
      }));
      const result = admitProvRecord({ commitLog: [bundle('x', { trace })] }, limits());
      expect(result.reads?.get('write#0')).toHaveLength(160);
      expect(added).toBeLessThanOrEqual(640);
    } finally {
      spy.mockRestore();
    }
  });

  it('unions repeated tree read evidence in linear retained-read work', () => {
    let added = 0;
    const original = Set.prototype.add;
    const spy = vi.spyOn(Set.prototype, 'add').mockImplementation(function (this: Set<unknown>, value: unknown) {
      if (typeof value === 'string' && value.startsWith('source:')) added++;
      return original.call(this, value);
    });
    try {
      let tree: Record<string, unknown> | undefined;
      for (let index = 0; index < 80; index++)
        tree = {
          runtimeStageId: 'write#0',
          stageReads: { [`source:${index}`]: null },
          ...(tree ? { next: tree } : {}),
        };
      const result = admitProvRecord({ commitLog: [], executionTree: tree }, limits());
      expect(result.reads?.get('write#0')).toHaveLength(80);
      expect(added).toBeLessThanOrEqual(320);
    } finally {
      spy.mockRestore();
    }
  });

  it('retains attention from repeated structural nodes rather than silently replacing it', () => {
    const mark = (evidence: string) => [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: [evidence] }];
    const result = admitProvRecord(
      {
        commitLog: [],
        executionTree: {
          runtimeStageId: 'write#0',
          attention: mark('commit:0'),
          next: { runtimeStageId: 'write#0', attention: mark('commit:1') },
        },
      },
      limits(),
    );
    expect(result.attention?.get('write#0')?.map((attention) => attention.evidence)).toEqual([
      ['commit:0'],
      ['commit:1'],
    ]);
  });

  it.each(['subflowResults', 'subflowId'])('discloses the P1 boundary for %s without walking child data', (field) => {
    let called = 0;
    const child = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        called++;
        throw Error('private');
      },
    });
    const source =
      field === 'subflowResults'
        ? { commitLog: [], subflowResults: child }
        : { commitLog: [], executionTree: { runtimeStageId: 'mount#0', subflowId: child } };
    const result = admitProvRecord(source, limits());
    expect(result.gaps.some((gap) => gap.code === 'scope-boundary')).toBe(true);
    expect(called).toBe(0);
    expect(JSON.stringify(result.gaps)).not.toContain('secret');
  });

  it('refuses an accessor at the child-scope boundary without invoking it', () => {
    let called = 0;
    const source = Object.defineProperty({ commitLog: [] }, 'subflowResults', {
      get: () => {
        called++;
        throw Error('private child');
      },
    });
    const result = admitProvRecord(source, limits());
    expect(result.gaps.some((gap) => gap.code === 'invalid-data')).toBe(true);
    expect(called).toBe(0);
    expect(JSON.stringify(result.gaps)).not.toContain('private child');
  });

  it('captures actual drill segments but never infers producer or people', () => {
    const result = admitProvRecord({ address: { logRunId: 'run', drillPath: ['mount#2'] }, commitLog: [] }, limits());
    expect(result.address).toEqual({ logRunId: 'run', drillPath: ['mount#2'] });
    expect(Object.keys(result)).not.toContain('producer');
  });

  it('bounds row and field work and omits raw errors', () => {
    const result = admitProvRecord(
      { commitLog: [bundle('x', { trace: Array.from({ length: 8 }, () => ({ path: 'x', verb: 'set' })) })] },
      provOptions({ base: 'urn:test:', maxRows: 1 }),
    );
    expect(result.commits).toHaveLength(0);
    expect(result.gaps.some((g) => g.code === 'truncated')).toBe(true);
    expect(JSON.stringify(result.gaps)).not.toContain('stack');
  });

  it('stops scanning strings after the shared byte allowance is refused', () => {
    const budget = new ProvBudget(provOptions({ base: 'urn:test:', maxStringBytes: 16 }));
    expect(() => dataString('😀😀😀😀😀', budget)).toThrow();
    const spy = vi.spyOn(String.prototype, 'charCodeAt');
    try {
      expect(() => dataString('z'.repeat(16), budget)).toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['row', 'write-read', 'stage-read', 'tree-read', 'redaction'])(
    'bounds %s path depth before canonical index construction',
    (where) => {
      const deep = 'segment' + '\u001f'.repeat(10000);
      const source: Record<string, unknown> = { commitLog: [bundle('public')] };
      if (where === 'row') source.commitLog = [bundle(deep), bundle('later')];
      if (where === 'write-read')
        source.commitLog = [bundle('public', { trace: [{ path: 'public', verb: 'set', readKeys: [deep] }] })];
      if (where === 'stage-read') source.reads = { 'write#0': [deep] };
      if (where === 'tree-read') source.executionTree = { runtimeStageId: 'write#0', stageReads: { [deep]: null } };
      if (where === 'redaction') source.commitLog = [bundle('public', { redactedPaths: [deep] })];
      const result = admitProvRecord(source, provOptions({ base: 'urn:test:', maxDepth: 8, maxWork: 2000000 }));
      expect(result.gaps.some((gap) => gap.code === 'depth-limit')).toBe(true);
      expect(result.commits.flatMap((commit) => commit.rows).every((row) => !row.path.includes('\u001f'))).toBe(true);
      if (where === 'redaction') expect(result.privacy.hideAllPaths).toBe(true);
      if (where === 'row') expect(result.commits.map((commit) => commit.commitIdx)).toEqual([1]);
    },
  );

  it('refuses ill-formed Unicode rather than replacing identity', () => {
    const result = admitProvRecord({ commitLog: [bundle('\ud800')] }, limits());
    expect(result.commits).toHaveLength(0);
    expect(result.gaps.some((g) => g.code === 'invalid-data')).toBe(true);
  });
});

describe('PROV trusted configuration boundary', () => {
  it('uses documented finite defaults', () => {
    expect(limits()).toMatchObject({
      values: 'none',
      maxCommits: 4096,
      maxRows: 16384,
      maxDepth: 128,
      maxOutputBytes: 1048576,
    });
  });
  it.each([
    { base: 'http://example.test/' },
    { base: '/relative' },
    { base: 'https://example.test/#fragment' },
    { base: 'https://user:pass@example.test/' },
    { base: 'urn:test:?query' },
    { base: 'urn:test:', values: 'digest' },
    { base: 'urn:test:', agents: () => [] },
    { base: 'urn:test:', scopes: [] },
    ...['<bad>', '"bad"', '{bad}', '|bad', '^bad', '`bad', '%zz', '%0'].flatMap((part) => [
      { base: `https://example.test/${part}` },
      { base: `urn:test:${part}` },
    ]),
    { base: 'urn:test:', maxOutputBytes: 2047 },
    { base: 'urn:test:', maxRows: Infinity },
  ])('rejects unsupported or unsafe options with a typed fixed refusal', (options) => {
    expect(() => provOptions(options as never)).toThrow(ProvExportRefusal);
    try {
      provOptions(options as never);
    } catch (error) {
      expect((error as ProvExportRefusal).code).toBe('PROV_EXPORT_OPTIONS');
    }
  });
  it('does not invoke option getters', () => {
    let calls = 0;
    const options = Object.defineProperty({}, 'base', {
      get: () => {
        calls++;
        return 'urn:test:';
      },
    });
    expect(() => provOptions(options as never)).toThrow(ProvExportRefusal);
    expect(calls).toBe(0);
  });
});
