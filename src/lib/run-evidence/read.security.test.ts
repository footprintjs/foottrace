/**
 * The reader's threat model: a record file is untrusted input.
 *
 *   own data     accessors, custom prototypes and sparse arrays are refused; a getter never runs
 *   hostile ids  `__proto__`, `constructor`: inert; a bad grammar is refused
 *   forged rows  a decision with no commit, a parent at or after its child, a cycle, a mount that does not lead in,
 *                a duplicate seq, a duplicate about
 *   caps         each cap holds; past it the row is unread and the channel is partial (truncated)
 *   no second scrub   a masked threshold stays a hole, and nothing else is rewritten
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { bundleFor, evidenceStore } from '../../../test/helpers/evidenceFixture';
import type { RecordEntry } from '../memory/sink';
import { readStoredRecord } from '../time-travel/storedRecord';
import { RUN_EVIDENCE_LIMITS, type StoredFilterRule } from './kinds';
import { readRunEvidence, type RunEvidence } from './read';

const ADDRESS = { logRunId: 'r', drillPath: [] as string[] };
const opened = { kind: 'opened', address: ADDRESS, at: 1, initialState: {}, collects: { v: 1, reads: 'keys' } };
const commit = (id: string, idx: number, about?: unknown, extra: object = {}) => ({
  kind: 'commit',
  address: ADDRESS,
  at: 1,
  bundle: { ...bundleFor(id), idx, ...extra },
  ...(about === undefined ? {} : { about }),
});
const note = (kind: string, data: unknown) => ({ kind: 'note', address: ADDRESS, at: 1, note: kind, data });
const closed = (commits: number, runNotes: unknown) => ({
  kind: 'closed',
  address: ADDRESS,
  at: 1,
  outcome: 'ok',
  commits,
  runNotes,
});
const read = (entries: readonly unknown[], limits?: Parameters<typeof readRunEvidence>[2]): RunEvidence =>
  readRunEvidence(readStoredRecord(entries), 'r', limits);
const gaps = (channel: { status: string }) => (channel as { gaps?: readonly string[] }).gaps;

/** A file with one forged row in the middle of an otherwise whole log. */
function fileWith(row: unknown, runNotes: unknown = 1) {
  return [opened, commit('seed#0', 0, {}), row, closed(1, runNotes)];
}

const decision = (over: object = {}) => ({ seq: 0, id: 'seed#0', by: 'plain', chosen: 'b', ...over });
const filterRule = (conditions: unknown, over: object = {}) => ({
  type: 'filter',
  ruleIndex: 0,
  branch: 'b',
  matched: true,
  conditions,
  ...over,
});
const condition = (over: object = {}) => ({
  key: 'k',
  op: 'eq',
  threshold: 1,
  actualSummary: '1',
  result: true,
  redacted: false,
  ...over,
});
const decided = (rules: unknown, over: object = {}) =>
  note('run.decision', decision({ by: 'decide', evidence: { rules, chosen: 'b', default: 'b', ...over } }));

describe('own data only', () => {
  it('an accessor never runs, on any field of a row', () => {
    let ran = 0;
    const getter = {
      enumerable: true,
      get() {
        ran++;
        return 'value';
      },
    };
    const rows = [
      note('run.stop', Object.defineProperty({ seq: 0, id: 'seed#0' }, 'by', getter)),
      note('run.stage', Object.defineProperty({ seq: 0 }, 'id', getter)),
      note('run.decision', Object.defineProperty({ seq: 0, id: 'seed#0', by: 'plain' }, 'chosen', getter)),
      commit('s#1', 1, Object.defineProperty({}, 'parent', getter)),
      Object.defineProperty(commit('s#1', 1), 'about', getter),
      Object.defineProperty(closed(1, undefined), 'runNotes', getter),
    ];
    for (const row of rows) expect(read(fileWith(row)).stops.rows).toEqual([]);
    expect(ran).toBe(0);
  });

  it('a row whose whole data is an accessor never reaches admission: the stored reader lists it', () => {
    const row = Object.defineProperty({ kind: 'note', address: ADDRESS, at: 1, note: 'run.stop' }, 'data', {
      enumerable: true,
      get: () => 'value',
    });
    const evidence = read(fileWith(row));
    expect(evidence.stops.rows).toEqual([]);
    expect(evidence.stops.status).toBe('partial');
  });

  it('an accessor on an entry’s own fields is a refused row, never a throw', () => {
    const accessor = { enumerable: true, get: () => 'note' };
    const rows = [
      Object.defineProperty({ address: ADDRESS, at: 1, note: 'run.stop', data: {} }, 'kind', accessor),
      Object.defineProperty({ kind: 'note', address: ADDRESS, at: 1, data: {} }, 'note', {
        enumerable: true,
        get: () => 'run.stop',
      }),
    ];
    for (const row of rows) {
      const evidence = read(fileWith(row));
      expect(evidence.stops.status).toBe('partial');
      expect(evidence.stops.rows).toEqual([]);
    }
  });

  it('a custom prototype is refused, and an inherited field is no field', () => {
    class Forged {
      seq = 0;
      id = 'seed#0';
      by = 'break';
    }
    expect(read(fileWith(note('run.stop', new Forged()))).stops.rows).toEqual([]);
    const inherited = Object.create({ id: 'seed#0', by: 'break' });
    inherited.seq = 0;
    const evidence = read(fileWith(note('run.stop', inherited)));
    expect(evidence.stops.rows).toEqual([]);
    expect(evidence.unread).toHaveLength(1);
  });

  it('a sparse array is refused', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [, 'b'];
    const evidence = read(fileWith(note('run.decision', decision({ chosen: sparse }))));
    expect(evidence.decisions.rows).toEqual([]);
    expect(evidence.decisions.status).toBe('partial');
  });

  it('an array with a custom prototype is refused', () => {
    const forged = Object.setPrototypeOf(['b'], { evil: true });
    expect(read(fileWith(note('run.decision', decision({ chosen: forged })))).decisions.rows).toEqual([]);
  });

  it('a revoked proxy is a refused row, never a throw', () => {
    const { proxy, revoke } = Proxy.revocable({ seq: 0, id: 'seed#0', by: 'break' }, {});
    revoke();
    expect(() =>
      read(fileWith({ kind: 'note', address: ADDRESS, at: 1, note: 'run.stop', data: proxy })),
    ).not.toThrow();
  });

  it('unknown fields are ignored and never copied: an additive field keeps the version', () => {
    const evidence = read(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'break', later: { a: 1 } })));
    expect(evidence.stops.rows[0]).not.toHaveProperty('later');
    expect(evidence.stops.status).toBe('collected');
  });
});

describe('hostile keys and ids', () => {
  it('ids that name prototype fields are inert: rows live in a Map, and no object is polluted', () => {
    const entries = JSON.parse(
      JSON.stringify([
        opened,
        commit('__proto__#0', 0, { reads: ['__proto__', 'constructor'] }),
        commit('constructor#1', 1, { parent: '__proto__#0' }),
        note('run.decision', decision({ id: '__proto__#0' })),
        closed(2, 1),
      ]),
    );
    const evidence = read(entries);
    expect(evidence.control('constructor#1')).toMatchObject({ decider: '__proto__#0', status: 'collected' });
    expect(evidence.reads.rows[0].keys).toEqual(['__proto__', 'constructor']);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('a `__proto__` key inside a payload stays an own data field', () => {
    const row = JSON.parse('{"seq":0,"id":"seed#0","by":"pause","payload":{"__proto__":{"polluted":true},"a":1}}');
    const { payload } = read(fileWith(note('run.stop', row))).stops.rows[0];
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect((payload as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.keys(payload as object)).toContain('__proto__');
  });

  it.each(['no-hash', 'a#', '#1', 'a#1#2', 'a#-1', 'a#01', 'a#1.5', 'a#99999999999999999999', '', 'a\u0000b#1'])(
    'the id %j is refused by its grammar',
    (id) => {
      const evidence = read(fileWith(note('run.stop', { seq: 0, id, by: 'break' })));
      expect(evidence.stops.rows).toEqual([]);
      expect(gaps(evidence.stops)).toEqual(['invalid-data']);
    },
  );
});

describe('forged rows', () => {
  it('a decision whose id has no commit in its log is refused', () => {
    const evidence = read(fileWith(note('run.decision', decision({ id: 'forged#9' }))));
    expect(evidence.decisions.rows).toEqual([]);
    expect(gaps(evidence.decisions)).toEqual(['invalid-data']);
    expect(evidence.unread).toEqual([{ address: ADDRESS, index: 2, reason: expect.stringContaining('no commit') }]);
  });

  it('a decision is not refused when its commit may be the one the store lost', () => {
    const file = [opened, commit('seed#1', 1, {}), note('run.decision', decision({ id: 'lost#0' })), closed(2, 1)];
    const evidence = read(file);
    expect(evidence.decisions.rows.map((row) => row.id)).toEqual(['lost#0']);
    expect(evidence.decisions.status).toBe('partial');
  });

  it.each([
    ['a parent after its child', 's#1', { parent: 's#2' }],
    ['a parent equal to its child', 's#1', { parent: 's#1' }],
    ['resumes after its child', 's#1', { resumes: 's#2' }],
    ['resumes equal to its child', 's#1', { resumes: 's#1' }],
    ['a parent that is not an id', 's#1', { parent: 'not an id' }],
  ])('%s is refused', (_name, id, about) => {
    const evidence = read([opened, commit('seed#0', 0, {}), commit(id, 1, about), closed(2, 0)]);
    expect(evidence.stages.rows.map((row) => row.id)).toEqual(['seed#0']);
    expect(gaps(evidence.stages)).toEqual(['invalid-data']);
    expect(evidence.unread).toHaveLength(1);
    expect(evidence.control(id).status).toBe('not-collected');
  });

  it('a chain cycle cannot form: its back edge is refused, and the walk ends', () => {
    const evidence = read([
      opened,
      commit('a#0', 0, {}),
      commit('b#1', 1, { parent: 'a#0' }),
      commit('a#0', 2, { parent: 'b#1' }),
      closed(3, 0),
    ]);
    expect(evidence.control('b#1').status).toBe('partial');
    expect(evidence.unread).toHaveLength(1);
  });

  it('a run.stage forged the same way is refused', () => {
    const evidence = read(fileWith(note('run.stage', { seq: 0, id: 's#1', parent: 's#5' })));
    expect(evidence.stages.rows.map((row) => row.id)).toEqual(['seed#0']);
    expect(gaps(evidence.stages)).toEqual(['invalid-data']);
  });

  it('run.stage and about that disagree on a parent: the first stands', () => {
    const evidence = read([
      opened,
      commit('seed#0', 0, {}),
      commit('p#1', 1, { parent: 'seed#0' }),
      note('run.stage', { seq: 0, id: 'm#2', parent: 'seed#0' }),
      commit('m#2', 2, { parent: 'p#1' }),
      closed(3, 1),
    ]);
    expect(evidence.stages.rows.find((row) => row.id === 'm#2')).toMatchObject({ parent: 'seed#0', committed: true });
    expect(gaps(evidence.stages)).toEqual(['invalid-data']);
  });

  it('run.stage and about that agree are one execution, committed', () => {
    const evidence = read([
      opened,
      commit('seed#0', 0, {}),
      note('run.stage', { seq: 0, id: 'm#1', parent: 'seed#0' }),
      commit('m#1', 1, { parent: 'seed#0', reads: ['k'] }),
      closed(2, 1),
    ]);
    expect(evidence.stages.status).toBe('collected');
    expect(evidence.stages.rows.filter((row) => row.id === 'm#1')).toHaveLength(1);
    expect(evidence.stages.rows.find((row) => row.id === 'm#1')).toMatchObject({ committed: true });
  });

  it('a mount log whose first execution does not point at its mount is refused', () => {
    const mountAddress = { logRunId: 'r', drillPath: ['m#1'] };
    const at = (row: Record<string, unknown>) => ({ ...row, address: mountAddress });
    const evidence = read([
      opened,
      commit('seed#0', 0, {}),
      note('run.stage', { seq: 0, id: 'm#1', parent: 'seed#0' }),
      at(opened),
      at(commit('m/in#2', 0, { parent: 'seed#0' })),
      at(closed(1, 0)),
      closed(1, 1),
    ]);
    expect(evidence.stages.rows.map((row) => row.id)).not.toContain('m/in#2');
    expect(gaps(evidence.stages)).toEqual(['invalid-data']);
  });

  it('a mount’s first execution may carry `resumes` instead, and its seed carries none', () => {
    const mountAddress = { logRunId: 'r', drillPath: ['m#1'] };
    const at = (row: Record<string, unknown>) => ({ ...row, address: mountAddress });
    const evidence = read([
      opened,
      commit('seed#0', 0, {}),
      note('run.stage', { seq: 0, id: 'm#1', parent: 'seed#0' }),
      at(opened),
      at(commit('m#1', 0)),
      at(commit('m/in#2', 1, { resumes: 'seed#0' })),
      at(closed(2, 0)),
      closed(1, 1),
    ]);
    expect(evidence.stages.status).toBe('collected');
  });

  it('an about on a mount log’s seed is refused: the mount’s own bundle holds it', () => {
    const mountAddress = { logRunId: 'r', drillPath: ['m#1'] };
    const at = (row: Record<string, unknown>) => ({ ...row, address: mountAddress });
    const evidence = read([
      opened,
      commit('seed#0', 0, {}),
      note('run.stage', { seq: 0, id: 'm#1', parent: 'seed#0' }),
      at(opened),
      at(commit('m#1', 0, { parent: 'seed#0' })),
      at(closed(1, 0)),
      closed(1, 1),
    ]);
    expect(evidence.unread).toHaveLength(1);
    expect(evidence.unread[0].reason).toContain('seed');
  });

  it('an about on a continuation is refused', () => {
    const evidence = read([opened, commit('seed#0', 0, {}), commit('seed#0', 1, {}, { phase: 'exit' }), closed(2, 0)]);
    expect(evidence.unread[0].reason).toContain('continuation');
  });

  it('a duplicate about keeps the first', () => {
    const evidence = read([
      opened,
      commit('seed#0', 0, {}),
      commit('s#1', 1, { parent: 'seed#0', reads: ['first'] }),
      commit('s#1', 2, { parent: 'seed#0', reads: ['second'] }),
      closed(3, 0),
    ]);
    expect(evidence.reads.rows.find((row) => row.id === 's#1')!.keys).toEqual(['first']);
    expect(evidence.unread).toEqual([{ address: ADDRESS, index: 3, reason: expect.stringContaining('duplicate') }]);
  });

  it('a duplicate seq keeps the first', () => {
    const evidence = read([
      opened,
      commit('seed#0', 0, {}),
      note('run.stop', { seq: 0, id: 'seed#0', by: 'break', reason: 'first' }),
      note('run.stop', { seq: 0, id: 'seed#0', by: 'break', reason: 'second' }),
      closed(1, 1),
    ]);
    expect(evidence.stops.rows.map((row) => row.reason)).toEqual(['first']);
    expect(evidence.unread).toHaveLength(1);
  });

  it('a duplicate decision keeps the first', () => {
    const evidence = read([
      opened,
      commit('seed#0', 0, {}),
      note('run.decision', decision({ seq: 0, chosen: 'first' })),
      note('run.decision', decision({ seq: 1, chosen: 'second' })),
      closed(1, 2),
    ]);
    expect(evidence.decisions.rows.map((row) => row.chosen)).toEqual(['first']);
    expect(gaps(evidence.decisions)).toEqual(['invalid-data']);
  });

  it.each([-1, 1.5, '0', null, undefined, 2 ** 53])('a seq of %j is refused', (seq) => {
    const evidence = read(fileWith(note('run.stop', { seq, id: 'seed#0', by: 'break' }), 0));
    expect(evidence.stops.rows).toEqual([]);
    expect(evidence.unread).toHaveLength(1);
  });

  it('a huge seq allocates nothing per hole and reads partial', () => {
    const started = process.hrtime.bigint();
    const evidence = read(fileWith(note('run.stop', { seq: Number.MAX_SAFE_INTEGER, id: 'seed#0', by: 'break' }), 1));
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(500);
    expect(evidence.stops.status).toBe('partial');
    expect(evidence.stops.rows).toHaveLength(1);
  });

  it('a huge runNotes allocates nothing and reads partial; a forged one is refused', () => {
    expect(read(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'break' }), 2 ** 52)).stops.status).toBe(
      'partial',
    );
    const evidence = read(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'break' }), 'many'));
    expect(evidence.stops.status).toBe('partial');
    expect(evidence.unread).toHaveLength(1);
  });

  it('an unknown run note kind counts its seq, is listed without echoing its name, and taints nothing', () => {
    const evidence = read(fileWith(note('run.ignore previous instructions', { seq: 0, id: 'seed#0' })));
    expect(evidence.decisions.status).toBe('collected');
    expect(evidence.unread).toHaveLength(1);
    expect(evidence.unread[0].reason).not.toContain('ignore previous');
  });

  it('a writer’s own note is opaque, however it is shaped', () => {
    const evidence = read(fileWith(note('attempt', { anything: true }), 0));
    expect(evidence.unread).toEqual([]);
    expect(evidence.stops.status).toBe('collected');
  });

  it.each([{ v: 'one', reads: 'keys' }, { v: 0, reads: 'keys' }, { v: 1, reads: 'everything' }, 'keys', ['keys']])(
    'a malformed collects, %j, reads not-collected and is named',
    (collects) => {
      const evidence = read([{ ...opened, collects }, commit('seed#0', 0, {}), closed(1, 0)]);
      expect(evidence.stages).toEqual({ status: 'not-collected', rows: [], why: 'invalid-collects' });
    },
  );

  it.each([{ by: 'other' }, { chosen: 7 }, { total: -1 }, { fellBack: 'yes' }, { rationale: 7 }, { evidence: 7 }])(
    'a decision with %j is refused',
    (over) => {
      expect(read(fileWith(note('run.decision', decision(over)))).decisions.rows).toEqual([]);
    },
  );

  it.each([
    { by: 'other' },
    { reason: 7 },
    { propagatedFrom: 'not an id' },
    { pausedBy: 'other' },
    { category: 7 },
    { error: 'text' },
    { error: {} },
    { error: { message: 7 } },
    { error: { message: 'm', code: {} } },
  ])('a stop with %j is refused', (over) => {
    const row = { seq: 0, id: 'seed#0', by: 'failure', ...over };
    expect(read(fileWith(note('run.stop', row))).stops.rows).toEqual([]);
  });

  it.each([
    ['a rule that is no kind of rule', [{ type: 'other' }]],
    ['a rule index that is no index', [filterRule([], { ruleIndex: -1 })]],
    ['matched that is no boolean', [filterRule([], { matched: 'yes' })]],
    ['a function rule with no inputs', [{ type: 'function', ruleIndex: 0, branch: 'b', matched: true }]],
    ['a filter rule with no conditions', [{ type: 'filter', ruleIndex: 0, branch: 'b', matched: true }]],
    [
      'an input with no summary',
      [{ type: 'function', ruleIndex: 0, branch: 'b', matched: true, inputs: [{ key: 'k' }] }],
    ],
    ['a condition with no key', [filterRule([condition({ key: 7 })])]],
    ['a thresholdRedacted that is not true', [filterRule([condition({ thresholdRedacted: 'yes' })])]],
    ['a thresholdSummarized that is not true', [filterRule([condition({ thresholdSummarized: 1 })])]],
    ['a label that is no text', [filterRule([], { label: 7 })]],
    ['a matchError that is no text', [filterRule([], { matchError: 7 })]],
  ])('evidence with %s is refused', (_name, rules) => {
    const evidence = read(fileWith(decided(rules)));
    expect(evidence.decisions.rows).toEqual([]);
    expect(gaps(evidence.decisions)).toEqual(['invalid-data']);
  });

  it('evidence whose form does not match its `by` is refused', () => {
    const selectForm = { rules: [], selected: ['b'] };
    expect(
      read(fileWith(note('run.decision', decision({ by: 'decide', evidence: selectForm })))).decisions.rows,
    ).toEqual([]);
    expect(
      read(
        fileWith(note('run.decision', decision({ by: 'plain', evidence: { rules: [], chosen: 'b', default: 'b' } }))),
      ).decisions.rows,
    ).toEqual([]);
  });

  it('a retry loop’s forged decision is refused, and a real one is kept', () => {
    const loop = {
      id: 'l',
      series: 's',
      attempt: 1,
      of: 3,
      effect: 'none',
      reconciled: true,
      next: 'retry',
      reason: 'r',
    };
    expect(read(fileWith(decided([], { retryLoop: loop }))).decisions.rows[0].evidence).toMatchObject({
      retryLoop: loop,
    });
    expect(read(fileWith(decided([], { retryLoop: { ...loop, next: 'other' } }))).decisions.rows).toEqual([]);
  });

  it.each([[{ kind: 'x' }], [7], [{ kind: 'x', reason: 'NOT_A_REASON', evidence: ['e'] }]])(
    'a mark that is not a mark, %j, is refused',
    (mark) => {
      const evidence = read([opened, commit('seed#0', 0, { attention: [mark] }), closed(1, 0)]);
      expect(evidence.attention.rows).toEqual([]);
      expect(gaps(evidence.attention)).toEqual(['invalid-data']);
    },
  );

  it('the writer’s bound on marks is the reader’s: at it one is admitted, past it one is refused', () => {
    const mark = { kind: 'retried', reason: 'RETRY_RECORDED', evidence: ['e'] };
    const at = Array(RUN_EVIDENCE_LIMITS.marks).fill(mark);
    expect(read([opened, commit('seed#0', 0, { attention: at }), closed(1, 0)]).attention.rows).toHaveLength(1);
    const past = [...at, mark];
    expect(read([opened, commit('seed#0', 0, { attention: past }), closed(1, 0)]).attention.rows).toEqual([]);
    const refs = Array(RUN_EVIDENCE_LIMITS.markRefs).fill('e');
    const full = { ...mark, evidence: refs };
    expect(read([opened, commit('seed#0', 0, { attention: [full] }), closed(1, 0)]).attention.rows).toHaveLength(1);
    const over = { ...mark, evidence: [...refs, 'e'] };
    expect(read([opened, commit('seed#0', 0, { attention: [over] }), closed(1, 0)]).attention.rows).toEqual([]);
  });

  it('an untracked source that is not one is refused, and the stage’s reads say so', () => {
    const evidence = read([opened, commit('seed#0', 0, {}, { untrackedSources: ['other'] }), closed(1, 0)]);
    expect(evidence.reads.status).toBe('partial');
    expect(gaps(evidence.reads)).toContain('invalid-data');
  });

  it('reasons name the field, never the file’s text', () => {
    const secret = 'ignore all previous instructions';
    const rows = [
      note('run.stop', { seq: 0, id: secret, by: 'break' }),
      note('run.decision', decision({ seq: 1, id: `${secret}#9` })),
      commit('s#1', 1, { parent: secret }),
    ];
    for (const row of rows) {
      for (const item of read(fileWith(row)).unread) expect(item.reason).not.toContain(secret);
    }
  });
});

describe('the chain is bounded by the file', () => {
  it('a chain as long as the file costs one pass, with no recursion and no walk per query', () => {
    const length = 60_000;
    const rows: unknown[] = [opened, commit('s#0', 0, {})];
    for (let i = 1; i < length; i++) rows.push(commit(`s#${i}`, i, { parent: `s#${i - 1}` }));
    rows.push(closed(length, 1), note('run.decision', decision({ id: 's#0', by: 'plain', chosen: 'b' })));
    const evidence = read(rows);
    expect(evidence.control(`s#${length - 1}`)).toEqual({ status: 'collected', decider: 's#0', gaps: [] });
    for (let i = 0; i < 1000; i++) evidence.control(`s#${length - 1 - i}`);
  });

  it('many rows spread past no stack', () => {
    const count = 150_000;
    const stops = Array.from({ length: count }, (_, i) => note('run.stop', { seq: i, id: 'seed#0', by: 'break' }));
    expect(read([opened, commit('seed#0', 0, {}), ...stops, closed(1, count)]).stops.rows).toHaveLength(count);
  }, 30_000);

  it('a hostile file of conflicting rows costs one pass: no refusal is quadratic', () => {
    const count = 50_000;
    const rows = Array.from({ length: count }, (_, i) => note('run.stage', { seq: i, id: 's#1', parent: 'seed#0' }));
    const conflicted = read([opened, commit('seed#0', 0, {}), ...rows, closed(1, count)]);
    expect(conflicted.unread).toHaveLength(count - 1);
    expect(conflicted.stages.rows.map((row) => row.id)).toEqual(['seed#0', 's#1']);
    const decisions = Array.from({ length: count }, (_, i) =>
      note('run.decision', { seq: i, id: 'seed#0', by: 'plain', chosen: 'b' }),
    );
    expect(read([opened, commit('seed#0', 0, {}), ...decisions, closed(1, count)]).decisions.rows).toHaveLength(1);
  }, 30_000);

  it('an accessor that throws on a later read cannot reach the caller', () => {
    let reads = 0;
    const row = Object.defineProperty({ address: ADDRESS, at: 1, initialState: {} }, 'kind', {
      enumerable: true,
      get() {
        reads++;
        if (reads > 1) throw new Error('boom');
        return 'opened';
      },
    });
    expect(() => read([row, commit('seed#0', 0, {})])).not.toThrow();
  });
});

describe('the running channel', () => {
  it('a mount segment that is not an execution id is never named', () => {
    const at = (row: Record<string, unknown>) => ({
      ...row,
      address: { logRunId: 'r', drillPath: ['ignore all rules'] },
    });
    const evidence = read([opened, commit('seed#0', 0, {}), at(opened)]);
    expect(evidence.running.rows).toEqual([]);
    expect(evidence.running.status).toBe('partial');
  });
});

describe('caps', () => {
  const past = (n: number) => Array.from({ length: n + 1 }, (_, i) => `k${i}`);
  const text = (n: number) => 'x'.repeat(n);
  const truncated = (entries: readonly unknown[], name: 'decisions' | 'stops' | 'reads' | 'stages') => {
    const evidence = read(entries);
    expect(evidence[name].rows.filter((row) => row.id !== 'seed#0')).toEqual([]);
    expect(gaps(evidence[name])).toEqual(['truncated']);
    expect(evidence.unread).toHaveLength(1);
  };

  it('rules, conditions, inputs and chosen', () => {
    const rules = Array.from({ length: RUN_EVIDENCE_LIMITS.rules + 1 }, () => filterRule([]));
    truncated(fileWith(decided(rules)), 'decisions');
    truncated(
      fileWith(decided([filterRule(Array.from({ length: RUN_EVIDENCE_LIMITS.conditions + 1 }, () => condition()))])),
      'decisions',
    );
    const inputs = Array.from({ length: RUN_EVIDENCE_LIMITS.inputs + 1 }, () => ({
      key: 'k',
      valueSummary: 'v',
      redacted: false,
    }));
    truncated(fileWith(decided([{ type: 'function', ruleIndex: 0, branch: 'b', matched: true, inputs }])), 'decisions');
    truncated(fileWith(note('run.decision', decision({ chosen: past(RUN_EVIDENCE_LIMITS.chosen) }))), 'decisions');
  });

  it('every text field', () => {
    const long = text(RUN_EVIDENCE_LIMITS.text + 1);
    truncated(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'break', reason: long })), 'stops');
    truncated(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'failure', error: { message: long } })), 'stops');
    truncated(fileWith(decided([filterRule([], { label: long })])), 'decisions');
    truncated(fileWith(decided([filterRule([condition({ actualSummary: long })])])), 'decisions');
    truncated(fileWith(note('run.decision', decision({ rationale: long }))), 'decisions');
  });

  it('read names, their length, and a description', () => {
    truncated([opened, commit('s#0', 0, { reads: past(RUN_EVIDENCE_LIMITS.reads) }), closed(1, 0)], 'reads');
    truncated([opened, commit('s#0', 0, { reads: [text(RUN_EVIDENCE_LIMITS.readLength + 1)] }), closed(1, 0)], 'reads');
    truncated(
      [opened, commit('s#0', 0, { description: text(RUN_EVIDENCE_LIMITS.description + 1) }), closed(1, 0)],
      'stages',
    );
  });

  it('a payload past its depth, deep enough to break a recursive walk', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 200_000; i++) deep = { a: deep };
    truncated(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'pause', payload: deep })), 'stops');
    let edge: unknown = 1;
    for (let i = 0; i < RUN_EVIDENCE_LIMITS.payloadDepth; i++) edge = [edge];
    const kept = read(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'pause', payload: edge })));
    expect(kept.stops.status).toBe('collected');
  });

  it('a payload past its size, in a string or in fields', () => {
    const big = text(RUN_EVIDENCE_LIMITS.payloadSize + 1);
    truncated(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'pause', payload: big })), 'stops');
    const wide = Object.fromEntries(Array.from({ length: 150_000 }, (_, i) => [`key${i}`, i]));
    truncated(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'pause', payload: wide })), 'stops');
  });

  it('a payload with what no JSON holds is refused: a cycle, a function, a class instance, a hole', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    // eslint-disable-next-line no-sparse-arrays
    for (const payload of [cycle, () => 0, new Date(0), [, 1], Object.create({ a: 1 })]) {
      const evidence = read(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'pause', payload })));
      expect(evidence.stops.rows).toEqual([]);
      expect(evidence.stops.status).toBe('partial');
    }
  });

  it('a value a payload holds twice is copied twice, and charged twice: a shared object is no cycle', () => {
    const shared = { a: 1 };
    const row = read(
      fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'pause', payload: { x: shared, y: shared } })),
    );
    expect(row.stops.rows[0].payload).toEqual({ x: { a: 1 }, y: { a: 1 } });
    // A small value doubled through 40 levels would be a trillion copies: the size stops it.
    let wide: unknown = 'x'.repeat(16);
    for (let i = 0; i < 30; i++) wide = { l: wide, r: wide };
    const evidence = read(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'pause', payload: wide })));
    expect(evidence.stops.rows).toEqual([]);
    expect(gaps(evidence.stops)).toEqual(['truncated']);
  });

  it('a payload the reader keeps is a detached, frozen copy', () => {
    const payload = { a: [1, { b: 'c' }] };
    const row = read(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'pause', payload }))).stops.rows[0];
    expect(row.payload).toEqual(payload);
    expect(row.payload).not.toBe(payload);
    expect(Object.isFrozen(row.payload)).toBe(true);
    expect(Object.isFrozen((row.payload as { a: unknown }).a)).toBe(true);
  });

  it('a forged non-scalar threshold is capped: depth and size', () => {
    let deep: unknown = 1;
    for (let i = 0; i < RUN_EVIDENCE_LIMITS.payloadDepth + 1; i++) deep = [deep];
    truncated(fileWith(decided([filterRule([condition({ threshold: deep })])])), 'decisions');
    const wide = Array.from({ length: RUN_EVIDENCE_LIMITS.thresholdSize }, (_, i) => i);
    truncated(fileWith(decided([filterRule([condition({ threshold: wide })])])), 'decisions');
    truncated(
      fileWith(decided([filterRule([condition({ threshold: text(RUN_EVIDENCE_LIMITS.text + 1) })])])),
      'decisions',
    );
  });

  it('a failure’s error keeps its name and either kind of code', () => {
    const row = (error: unknown) => read(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'failure', error })));
    expect(row({ name: 'E', message: 'm', code: 'E_X' }).stops.rows[0].error).toEqual({
      name: 'E',
      message: 'm',
      code: 'E_X',
    });
    expect(row({ message: 'm', code: 503 }).stops.rows[0].error).toEqual({ message: 'm', code: 503 });
  });

  it('a short list or an object inside the size is read as a copy', () => {
    const evidence = read(fileWith(decided([filterRule([condition({ threshold: ['a', 'b'] })])])));
    expect(evidence.decisions.status).toBe('collected');
    const rule = evidence.decisions.rows[0].evidence!.rules[0] as StoredFilterRule;
    expect(rule.conditions[0].threshold).toEqual(['a', 'b']);
  });

  it('one aggregate budget per call: past it each further row is unread, and work stops growing', () => {
    const rows = Array.from({ length: 20 }, (_, i) => note('run.stop', { seq: i, id: 'seed#0', by: 'break' }));
    const evidence = read([opened, commit('seed#0', 0, {}), ...rows, closed(1, 20)], { fields: 10 });
    expect(evidence.stops.rows.length).toBeLessThan(20);
    expect(gaps(evidence.stops)).toEqual(['truncated']);
  });

  it('a caller may raise a cap', () => {
    const long = text(RUN_EVIDENCE_LIMITS.text + 1);
    const evidence = read(fileWith(note('run.stop', { seq: 0, id: 'seed#0', by: 'break', reason: long })), {
      text: RUN_EVIDENCE_LIMITS.text + 1,
    });
    expect(evidence.stops.rows[0].reason).toBe(long);
  });
});

describe('no second scrub', () => {
  it('a masked threshold stays a hole with its marker, and a real `[REDACTED]` threshold has none', () => {
    const rules = [
      filterRule([
        condition({ key: 'ssn', threshold: '[REDACTED]', thresholdRedacted: true }),
        condition({ key: 'note', threshold: '[REDACTED]' }),
        condition({ key: 'list', threshold: '[12 items]', thresholdSummarized: true }),
      ]),
    ];
    const { decisions } = read(fileWith(decided(rules)));
    const held = (decisions.rows[0].evidence!.rules[0] as StoredFilterRule).conditions;
    expect(held[0]).toMatchObject({ threshold: '[REDACTED]', thresholdRedacted: true });
    expect(held[1].threshold).toBe('[REDACTED]');
    expect(held[1]).not.toHaveProperty('thresholdRedacted');
    expect(held[2]).toMatchObject({ threshold: '[12 items]', thresholdSummarized: true });
  });

  it('reads the summaries, the mask flags and the payload as written', () => {
    const rules = [
      {
        type: 'function',
        ruleIndex: 0,
        branch: 'b',
        matched: true,
        inputs: [{ key: 'ssn', valueSummary: '[REDACTED]', redacted: true }],
        matchError: '[REDACTED]',
      },
    ];
    const rule = read(fileWith(decided(rules))).decisions.rows[0].evidence!.rules[0];
    expect(rule).toEqual(rules[0]);
  });

  it('a redacted key’s name stays readable: a rule masks values, and never hides a name', () => {
    const store = evidenceStore();
    store.commit(['r'], 'seed#0', { reads: ['ssn'] }, { redactedPaths: ['ssn'] });
    store.close(['r']);
    expect(readRunEvidence(readStoredRecord(store.entries()), 'r').reads.rows[0].keys).toEqual(['ssn']);
  });
});

describe('never throws on a file', () => {
  const anyRow = fc.oneof(
    fc.jsonValue(),
    fc.jsonValue().map((data) => ({ kind: 'note', address: ADDRESS, at: 1, note: 'run.decision', data })),
    fc.jsonValue().map((data) => ({ kind: 'note', address: ADDRESS, at: 1, note: 'run.stop', data })),
    fc.jsonValue().map((data) => ({ kind: 'note', address: ADDRESS, at: 1, note: 'run.stage', data })),
    fc.jsonValue().map((about) => commit('seed#0', 0, about)),
    fc.jsonValue().map((collects) => ({ ...opened, collects })),
    fc.jsonValue().map((runNotes) => closed(1, runNotes)),
  );

  it('any JSON in any evidence field: frozen rows, a stated status, an honest control answer', () => {
    fc.assert(
      fc.property(fc.array(anyRow, { maxLength: 12 }), (rows) => {
        const evidence = readRunEvidence(readStoredRecord([opened, commit('seed#0', 0, {}), ...rows]), 'r');
        for (const channel of [
          evidence.decisions,
          evidence.stops,
          evidence.reads,
          evidence.attention,
          evidence.stages,
        ]) {
          expect(['collected', 'partial', 'not-collected']).toContain(channel.status);
          expect(Object.isFrozen(channel.rows)).toBe(true);
        }
        const answer = evidence.control('seed#0');
        expect(['collected', 'partial', 'not-collected']).toContain(answer.status);
      }),
      { numRuns: 300 },
    );
  });

  it('a mutated real file never throws, and whatever it reads as collected still holds its rows', () => {
    const store = evidenceStore();
    store.commit(['r'], 'seed#0', {});
    store.note(['r'], 'run.decision', { id: 'seed#0', by: 'plain', chosen: 'b' });
    store.commit(['r'], 'b#1', { parent: 'seed#0', reads: ['k'] });
    store.close(['r']);
    const entries: RecordEntry[] = store.entries();
    fc.assert(
      fc.property(fc.nat(entries.length - 1), fc.jsonValue(), (at, junk) => {
        const copy: unknown[] = [...entries];
        copy[at] = { ...(copy[at] as object), about: junk, data: junk, collects: junk, runNotes: junk };
        const evidence = readRunEvidence(readStoredRecord(copy), 'r');
        expect(['collected', 'partial', 'not-collected']).toContain(evidence.control('b#1').status);
      }),
      { numRuns: 300 },
    );
  });
});
