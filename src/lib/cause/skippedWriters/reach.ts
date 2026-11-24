import type { NormalizedSkippedStage, SkippedPathGap, SkippedWork, SkippedWriter } from './types.js';

interface PendingEdges {
  readonly edges: readonly string[];
  next: number;
}

/** Walk one skipped entry without crossing the supplied control boundary. */
export function walkSkippedPath(
  stages: ReadonlyMap<string, NormalizedSkippedStage>,
  entry: string,
  stop: ReadonlySet<string>,
  observed: ReadonlySet<string>,
  declaredMatches: (path: string) => boolean,
  budget: SkippedWork,
): { readonly writers: readonly SkippedWriter[]; readonly gaps: readonly SkippedPathGap[] } {
  const writers: SkippedWriter[] = [];
  const gaps = new Set<SkippedPathGap>();
  const visited = new Set<string>();
  const pending: PendingEdges[] = [];
  const spend = (): boolean => {
    if (budget.left < 1) {
      gaps.add('limit');
      return false;
    }
    budget.left--;
    return true;
  };

  let next: string | undefined = entry;
  walk: while (next !== undefined || pending.length) {
    if (next === undefined) {
      const frame = pending[pending.length - 1];
      if (frame.next === frame.edges.length) {
        pending.pop();
        continue;
      }
      if (!spend()) break;
      next = frame.edges[frame.next++];
      continue;
    }

    const id = next;
    next = undefined;
    if (visited.has(id)) continue;
    if (!spend()) break;
    const stage = stages.get(id);
    if (stage?.id !== id) return { writers: [], gaps: [...gaps, 'graph-ambiguous'] };
    visited.add(id);
    if (stop.has(id) || stage.role === 'loop-reference') continue;
    if (stage.role === 'mount') {
      gaps.add('scope-boundary');
      continue;
    }

    if (stage.role === 'stage') {
      let basis: SkippedWriter['basis'] | undefined;
      if (stage.writes === undefined) {
        if (observed.has(stage.stageId)) basis = 'observed';
        else gaps.add('writers-unknown');
      } else {
        for (const path of stage.writes) {
          if (!spend()) break walk;
          if (declaredMatches(path)) {
            basis = 'declared';
            break;
          }
        }
      }
      if (basis !== undefined) writers.push({ placementId: id, stageId: stage.stageId, basis });
    }
    if (stage.edges.length) pending.push({ edges: stage.edges, next: 0 });
  }

  return { writers, gaps: [...gaps] };
}
