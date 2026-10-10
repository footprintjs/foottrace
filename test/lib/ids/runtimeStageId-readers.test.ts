/**
 * The grammar's one owner (F7) — the readers every parser now calls instead of
 * splitting on `#` / `/` itself — and the one refusal the engine's id doors ask
 * (`reservedIds.ts` since C6: the grammar is the record's and imports nothing).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildRuntimeStageId,
  executionIndexOf,
  isExecutionKey,
  isWithinSubflow,
  joinPath,
  lastSegmentOf,
  parseRuntimeStageId,
  pathSegments,
  splitStageId,
  stageIdOf,
  subflowPathOf,
  subflowSegmentsOf,
} from '../../../src/lib/ids/runtimeStageId.js';

describe('the readers', () => {
  it('read a nested execution key', () => {
    const rid = 'sf-a/sf-b/stage#12';
    expect(isExecutionKey(rid)).toBe(true);
    expect(stageIdOf(rid)).toBe('sf-a/sf-b/stage');
    expect(executionIndexOf(rid)).toBe(12);
    expect(subflowPathOf(rid)).toBe('sf-a/sf-b');
    expect(subflowSegmentsOf(rid)).toEqual(['sf-a', 'sf-b']);
  });

  it('read a top-level execution key and a bare path', () => {
    expect(subflowPathOf('seed#0')).toBeUndefined();
    expect(subflowSegmentsOf('seed#0')).toEqual([]);
    expect(isExecutionKey('sf-a/sf-b')).toBe(false);
    expect(stageIdOf('sf-a/sf-b')).toBe('sf-a/sf-b');
    expect(Number.isNaN(executionIndexOf('sf-a/sf-b'))).toBe(true);
  });

  it('path helpers: segments drop empties, last segment, join, within', () => {
    expect(pathSegments('/a//b/')).toEqual(['a', 'b']);
    expect(lastSegmentOf('a/b/c')).toBe('c');
    expect(lastSegmentOf('solo')).toBe('solo');
    expect(joinPath('a', 'b', 'c')).toBe('a/b/c');
    expect(isWithinSubflow('sf/a/b', 'sf')).toBe(true);
    expect(isWithinSubflow('sf-x/a', 'sf')).toBe(false);
    expect(isWithinSubflow('sf', 'sf')).toBe(false);
  });

  it('property: build → read round-trips for every id the builder admits', () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9~-]{0,6}$/);
    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 3 }),
        fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/),
        fc.nat(),
        (path, id, n) => {
          const subflowPath = path.length > 0 ? joinPath(...path) : undefined;
          const rid = buildRuntimeStageId(id, n, subflowPath);
          expect(isExecutionKey(rid)).toBe(true);
          expect(executionIndexOf(rid)).toBe(n);
          expect(subflowPathOf(rid)).toBe(subflowPath);
          expect(subflowSegmentsOf(rid)).toEqual(path);
          expect(stageIdOf(rid)).toBe(subflowPath ? `${subflowPath}/${id}` : id);
          expect(parseRuntimeStageId(rid)).toEqual({ stageId: id, executionIndex: n, subflowPath });
          expect(splitStageId(stageIdOf(rid)).subflowPath).toBe(subflowPath);
        },
      ),
    );
  });
});
