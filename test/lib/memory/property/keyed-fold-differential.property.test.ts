/**
 * Property — the key queries agree with the fold (F3, 9.33.0, ruling R4). The review question, asked as a
 * test: "produce a log and a key where `stateAt` and `commitValueAt` still disagree".
 *
 * Until F3 every key query matched rows on the EXACT path, so a key written through a nested row (a subflow
 * seed `cfg␟a`, an outputMapper merge-back `cfg␟b`, a fork child's `runs␟c0␟x`) read as "never written" while
 * the fold gave its value. Now (`memory/keyPaths.ts`):
 *
 *   VALUE RULE   `commitValueAt(log, i, K)` IS the log-only fold `stateAt({ commitLog: log }, i)` read at K —
 *                for every key: top-level, nested, array index, never written. Against the fold WITH the base
 *                (`initialState`) it differs in exactly one named class: K was in the base and no `set` /
 *                `delete` of K itself is in range (the log alone cannot see the pre-run value — F4b's
 *                `'from-initial-state'`).
 *   WRITER RULE  `findLastWriter(log, K, i + 1)` is the last commit ≤ i with a row on or inside K, or a row
 *                around K across which the value at K changed — a brute-force oracle over `stateAt`.
 *   READS        `keyTimeline` / `forwardSliceForKey` count a read on, inside or around K as a read of K:
 *                the read moments are exactly the commits whose reads provider names such a key.
 *
 * The real engine-log witness stays in footprintjs. These hand-built logs range over
 * a small path alphabet with array-index segments and all four verbs — the shapes the engine rarely writes,
 * where folding only the rows that touch K would be wrong (an array union dedups the WHOLE array).
 */
import fc from 'fast-check';

import { commitValueAt, findLastWriter } from '../../../../src/lib/memory/commitLogUtils';
import { deepEqual } from '../../../../src/lib/memory/equality';
import { relation } from '../../../../src/lib/memory/keyPaths';
import { nativeGet, nativeSet } from '../../../../src/lib/memory/pathOps';
import { DELIM } from '../../../../src/lib/memory/paths';
import type { CommitBundle, MemoryPatch, TraceEntry } from '../../../../src/lib/memory/types';
import { forwardSliceForKey } from '../../../../src/lib/slice/forwardSliceForKey';
import { keysReadFromMap } from '../../../../src/lib/slice/keysReadSources';
import { keyTimeline } from '../../../../src/lib/slice/keyTimeline';
import { stateAt } from '../../../../src/index';

const VOLATILE = new Set([
  'timestamp',
  'runId',
  'pipelineId',
  'durationMs',
  'duration',
  'startTime',
  'endTime',
  'pausedAt',
  // F7 (9.37.0) — the one named checkpoint change: the paused execution the resume
  // event links to. 9.28.0 has no such field; pinned in resume-event-link.test.ts.
  'pausedExecution',
  // F8 (9.39.0) — the named record change: a continuation's `phase` on its bundle ('exit' /
  // 'repeat'; 9.28.0 has none), the checkpoint's `checkpointVersion`, and `continuationStageId`
  // (legacy-only — no longer written). Pinned in one-stage-one-record.test.ts and pause/record.test.ts.
  'phase',
  'checkpointVersion',
  'continuationStageId',
  // The restored redaction law — the one named checkpoint addition: the redaction marks a pause
  // carries to the resumed run (names only; 9.28.0 has none). Pinned in redaction-review-52.test.ts.
  'redactionMarks',
]);

/**
 * The bytes a consumer keeps. JSON with the types JSON loses spelled out
 * (`undefined`, `Date`, `Map`, `Set`) and wall-clock / run-id fields dropped.
 * A shared (non-cyclic) reference serialises twice, exactly as JSON does.
 */
export function bytes(v: unknown): string {
  return JSON.stringify(v, function (this: Record<string, unknown>, k, x) {
    if (VOLATILE.has(k)) return undefined;
    if (x === undefined) return '«undefined»';
    const raw = this[k];
    if (raw instanceof Date) return `«date:${raw.getTime()}»`;
    if (x instanceof Map) return { '«map»': [...x] };
    if (x instanceof Set) return { '«set»': [...x] };
    return x;
  });
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Date);

// ─── The oracles ───────────────────────────────────────────────────────────────

/** Every key worth asking about at commit `i`: top-level keys, every row path and its ancestors, one level of children. */
function keysAt(log: CommitBundle[], i: number, state: Record<string, unknown>): Set<string> {
  const keys = new Set<string>(Object.keys(state));
  for (let c = 0; c <= i; c++) {
    for (const t of log[c].trace) {
      const segs = t.path.split(DELIM);
      for (let k = 1; k <= segs.length; k++) keys.add(segs.slice(0, k).join(DELIM));
    }
  }
  for (const [top, v] of Object.entries(state)) {
    if (isObj(v)) for (const child of Object.keys(v)) keys.add(top + DELIM + child);
    if (Array.isArray(v)) for (let j = 0; j < Math.min(v.length, 3); j++) keys.add(top + DELIM + j);
  }
  keys.add('never-a-key');
  return keys;
}

/** The writer rule, brute force: the last commit ≤ i that wrote K — a row on or inside it, or a row around it that changed it. */
function lastWriterOracle(log: CommitBundle[], folds: unknown[], key: string, i: number): number {
  const segs = key.split(DELIM);
  let last = -1;
  for (let c = 0; c <= i; c++) {
    let atOrInside = false;
    for (const t of log[c].trace) {
      const r = relation(t.path, key);
      if (r === 'exact' || r === 'inside') atOrInside = true;
    }
    const changed = !deepEqual(nativeGet(c > 0 ? folds[c - 1] : {}, segs), nativeGet(folds[c], segs));
    // A commit with no row near the key can still move it: a write THROUGH a string-valued container beside
    // it replaces the string, and the characters the key read from it (the one sibling case).
    if (atOrInside || changed) last = c;
  }
  return last;
}

/** Is K in the base with no `set` / `delete` OF K ITSELF in log[0..i]? The one class the base fold may differ in. */
function fromInitialState(log: CommitBundle[], base: Record<string, unknown> | undefined, key: string, i: number) {
  if (base === undefined || !Object.prototype.hasOwnProperty.call(base, key)) return false;
  for (let c = 0; c <= i; c++) {
    for (const t of log[c].trace) if (t.path === key && (t.verb === 'set' || t.verb === 'delete')) return false;
  }
  return true;
}

type Tally = { values: number; nested: number; writers: number; baseClass: number };

/** Every value, writer and base-class check over one log. Returns what it checked. */
function checkLog(log: CommitBundle[], base: Record<string, unknown> | undefined, tally: Tally): void {
  const folds = log.map((_, i) => stateAt({ commitLog: log }, i).state);
  for (let i = 0; i < log.length; i++) {
    const state = folds[i] as Record<string, unknown>;
    for (const key of keysAt(log, i, state)) {
      const segs = key.split(DELIM);
      tally.values++;
      if (segs.length > 1) tally.nested++;
      expect(bytes(commitValueAt(log, i, key)), `value of ${segs.join('.')} @${i}`).toBe(bytes(nativeGet(state, segs)));
      tally.writers++;
      expect(findLastWriter(log, key, i + 1)?.idx ?? -1, `writer of ${segs.join('.')} @${i}`).toBe(
        lastWriterOracle(log, folds, key, i),
      );
    }
    if (base !== undefined) {
      const withBase = stateAt({ commitLog: log, initialState: base }, i).state as Record<string, unknown>;
      for (const key of new Set([...Object.keys(withBase), ...Object.keys(state)])) {
        if (bytes(commitValueAt(log, i, key)) === bytes(withBase[key])) continue;
        tally.baseClass++;
        expect(fromInitialState(log, base, key, i), `${key} @${i} differs from the base fold outside the class`).toBe(
          true,
        );
      }
    }
  }
}

// ─── Hand-built logs: array-index paths, every verb ────────────────────────────

const FOUR = ['set', 'merge', 'append', 'delete'] as const;
const pathArb = fc
  .array(fc.constantFrom('a', 'b', '0', '1'), { minLength: 1, maxLength: 3 })
  .filter((segs) => segs[0] === 'a' || segs[0] === 'b')
  .map((segs) => segs.join(DELIM));
const payloadArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 2, arbitrary: fc.jsonValue({ maxDepth: 2 }) },
  { weight: 2, arbitrary: fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 4 }) },
  {
    weight: 1,
    arbitrary: fc.dictionary(fc.constantFrom('0', '1', 'x'), fc.integer({ min: 0, max: 3 }), { maxKeys: 2 }),
  },
);
const rowArb = fc.record({ path: pathArb, verb: fc.constantFrom(...FOUR), payload: payloadArb });

function bundleOf(
  rows: Array<{ path: string; verb: (typeof FOUR)[number]; payload: unknown }>,
  n: number,
): CommitBundle {
  const overwrite: MemoryPatch = {};
  const updates: MemoryPatch = {};
  const trace: TraceEntry[] = [];
  for (const { path, verb, payload } of rows) {
    trace.push({ path, verb });
    const segs = path.split(DELIM);
    if (verb === 'merge') nativeSet(updates, segs, structuredClone(payload));
    else nativeSet(overwrite, segs, verb === 'delete' ? undefined : structuredClone(payload));
  }
  return {
    idx: n,
    stage: `S${n}`,
    stageId: `s${n}`,
    runtimeStageId: `s${n}#${n}`,
    trace,
    overwrite,
    updates,
    redactedPaths: [],
  };
}

const handLogArb = fc
  .array(fc.array(rowArb, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 5 })
  .map((perBundle) => perBundle.map((rows, n) => bundleOf(rows, n)));

describe('VALUE + WRITER rules — hand-built logs (array-index paths, all four verbs)', () => {
  it('the same two laws hold where folding only the rows that touch the key would not', () => {
    const tally: Tally = { values: 0, nested: 0, writers: 0, baseClass: 0 };
    fc.assert(
      fc.property(handLogArb, (log) => checkLog(log, undefined, tally)),
      { numRuns: 400 },
    );
    expect(tally.nested).toBeGreaterThan(0);
  });

  it('the directed case: a sibling element moves where a later union leaves a[1]', () => {
    const log = [
      bundleOf([{ path: 'a', verb: 'set', payload: [1, 2] }], 0),
      bundleOf([{ path: ['a', '0'].join(DELIM), verb: 'set', payload: 2 }], 1),
      bundleOf([{ path: 'a', verb: 'merge', payload: [3] }], 2),
    ];
    expect((stateAt({ commitLog: log }, 2).state as { a: unknown }).a).toEqual([2, 3]);
    expect(commitValueAt(log, 2, ['a', '1'].join(DELIM))).toBe(3);
  });
});

// ─── READS — on, inside and around the key ─────────────────────────────────────

const readKeyArb = fc.oneof(pathArb, fc.constantFrom('a.0', 'other'));

describe('READS — a read on, inside or around K is a read of K', () => {
  it('keyTimeline: the write moments are the writer rule, the read moments the commits that read a related key', () => {
    fc.assert(
      fc.property(
        handLogArb,
        fc.array(fc.array(readKeyArb, { maxLength: 3 }), { maxLength: 5 }),
        pathArb,
        (log, readsPerCommit, key) => {
          const map: Record<string, string[]> = {};
          log.forEach((b, c) => (map[b.runtimeStageId] = readsPerCommit[c] ?? []));
          const timeline = keyTimeline(log, key, keysReadFromMap(map));
          const folds = log.map((_, i) => stateAt({ commitLog: log }, i).state);
          const writes = log.map((_, c) => c).filter((c) => lastWriterOracle(log, folds, key, c) === c);
          const reads = log
            .map((b, c) => c)
            .filter((c) => (map[log[c].runtimeStageId] ?? []).some((r) => relation(r, key) !== undefined));
          if (timeline.missing !== undefined) {
            expect([writes, reads]).toEqual([[], []]);
            return;
          }
          const moments = timeline.moments ?? [];
          expect(moments.filter((m) => m.kind === 'write').map((m) => m.commitIdx)).toEqual(writes);
          expect(moments.filter((m) => m.kind === 'read').map((m) => m.commitIdx)).toEqual(reads);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('a dotted read key is the literal key it may be — never a read inside the key it starts with', () => {
    const log = [
      bundleOf([{ path: 'a', verb: 'set', payload: { 0: 1 } }], 0),
      bundleOf([{ path: 'b', verb: 'set', payload: 1 }], 1),
    ];
    const timeline = keyTimeline(log, 'a', keysReadFromMap({ 's1#1': ['a.0'] }));
    expect(timeline.moments?.filter((m) => m.kind === 'read')).toEqual([]);
  });

  it('forwardSliceForKey: the anchor value’s readers are the commits in its life (closed only by a write that is not inside-only) that read a related key', () => {
    fc.assert(
      fc.property(
        handLogArb,
        fc.array(fc.array(readKeyArb, { maxLength: 3 }), { maxLength: 5 }),
        pathArb,
        (log, readsPerCommit, key) => {
          const map: Record<string, string[]> = {};
          log.forEach((b, c) => (map[b.runtimeStageId] = readsPerCommit[c] ?? []));
          const slice = forwardSliceForKey(log, key, keysReadFromMap(map));
          if (slice.root === undefined || slice.root.commitIdx === undefined) return;
          const folds = log.map((_, i) => stateAt({ commitLog: log }, i).state);
          const writes = log.map((_, c) => c).filter((c) => lastWriterOracle(log, folds, key, c) === c);
          const anchor = slice.root.commitIdx;
          // A life ends at the next write that is not INSIDE-only (one that only wrote paths inside the key
          // changed part of the value; a reader after it still read the rest).
          const insideOnly = (c: number) => {
            let inside = false;
            for (const t of log[c].trace) {
              const r = relation(t.path, key);
              if (r === 'exact' || r === 'around') return false;
              if (r === 'inside') inside = true;
            }
            return inside;
          };
          const next = writes.find((c) => c > anchor && !insideOnly(c));
          const expected = log
            .map((_, c) => c)
            .filter((c) => c > anchor && (next === undefined || c <= next))
            .filter((c) => (map[log[c].runtimeStageId] ?? []).some((r) => relation(r, key) !== undefined));
          expect(anchor).toBe(writes[writes.length - 1]);
          expect(slice.root.reads.map((r) => r.commitIdx)).toEqual(expected);
        },
      ),
      { numRuns: 300 },
    );
  });
});
