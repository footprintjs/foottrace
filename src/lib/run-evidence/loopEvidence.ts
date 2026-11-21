/** Match stored loop facts to the same re-entry rule the live recorder uses. */
import { stageIdOf } from '../ids/runtimeStageId.js';
import { RUN_LOOP_EVIDENCE_VERSION } from './kinds.js';
import { type LocalEdge, type LogFold, refuseLoop } from './logFold.js';
import { LoopBackEdges } from './loopBackEdges.js';

type OwnedEdge = LocalEdge & { readonly fold: LogFold };

export function matchLoops(
  edges: readonly OwnedEdge[],
  byId: ReadonlyMap<string, OwnedEdge>,
  folds: readonly LogFold[],
): { readonly reentries: ReadonlyMap<string, LoopBackEdges>; readonly uncertain: ReadonlySet<string> } {
  const hasNotes = folds.some(({ loops }) => loops.length > 0);
  const firstChild = new Map<string, OwnedEdge>();
  const parents = new Map<string, string>();
  for (const edge of hasNotes ? edges : []) {
    if (edge.parent === undefined) continue;
    parents.set(edge.id, edge.parent);
    if (!firstChild.has(edge.parent)) firstChild.set(edge.parent, edge);
  }

  const pending = new Map<string, { readonly fold: LogFold; readonly index: number }>();
  for (const fold of folds) {
    for (const {
      note: { id, target },
      index,
    } of fold.loops) {
      const child = firstChild.get(id);
      if (
        byId.get(id)?.fold !== fold ||
        child === undefined ||
        child.resumes !== undefined ||
        child.fold.address.logRunId !== fold.address.logRunId ||
        child.fold.collects!.v < RUN_LOOP_EVIDENCE_VERSION ||
        stageIdOf(child.id) !== target ||
        pending.has(child.id)
      ) {
        refuseLoop(fold, index);
      } else {
        pending.set(child.id, { fold, index });
      }
    }
  }

  const rules = new Map<string, LoopBackEdges>();
  const seen = new Map<LogFold, Set<string>>();
  const reentries = new Map<string, LoopBackEdges>();
  const uncertain = new Set<string>();
  for (const edge of edges) {
    const { logRunId } = edge.fold.address;
    const version = edge.fold.collects!.v;
    if (version < RUN_LOOP_EVIDENCE_VERSION) {
      const stages = seen.get(edge.fold) ?? new Set<string>();
      seen.set(edge.fold, stages);
      const stage = stageIdOf(edge.id);
      if (edge.parent !== undefined && edge.resumes === undefined && stages.has(stage)) uncertain.add(edge.id);
      stages.add(stage);
    }

    if (!hasNotes) continue;

    // A live recorder starts fresh for a new leg. A note can only name a re-entry within its own leg.
    const rule = rules.get(logRunId) ?? new LoopBackEdges();
    rules.set(logRunId, rule);
    const hop = pending.get(edge.id);
    if (hop !== undefined) rule.noteLoop(edge.parent!);
    rule.noteStage(edge.id, edge.parent, parents);
    if (hop === undefined) continue;
    if (rule.has(edge.id)) reentries.set(edge.id, rule);
    else refuseLoop(hop.fold, hop.index);
  }
  return { reentries, uncertain };
}
