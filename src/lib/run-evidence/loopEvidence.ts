/** Match stored loop facts to the same re-entry rule the live recorder uses. */
import { executionIndexOf, stageIdOf } from '../ids/runtimeStageId.js';
import { RUN_LOOP_EVIDENCE_VERSION } from './kinds.js';
import { type LocalEdge, type LogFold, refuseLoop } from './logFold.js';
import { LoopBackEdges } from './loopBackEdges.js';

type OwnedEdge = LocalEdge & { readonly fold: LogFold };

interface SeenStage {
  lastIndex: number;
  readonly forwardParents: Set<string>;
}

/**
 * Within one log, a repeat is unexplained until either its own loop note pairs, or it arrives
 * through a previously seen forward edge in a newer matched pass. A note in another branch or
 * one from before this stage last ran cannot explain it. V1 has no evidence of a matched pass.
 */
function unexplainedRepeats(
  edges: readonly OwnedEdge[],
  reentries: ReadonlyMap<string, LoopBackEdges>,
): ReadonlySet<string> {
  const uncertain = new Set<string>();
  const seen = new Map<LogFold, Map<string, SeenStage>>();
  const passAt = new Map<string, number>();
  for (const edge of edges) {
    const { id, parent, resumes, fold } = edge;
    const index = executionIndexOf(id);
    const stage = stageIdOf(id);
    const stages = seen.get(fold) ?? new Map<string, SeenStage>();
    seen.set(fold, stages);
    const previous = stages.get(stage);
    const matched = reentries.has(id);
    const up = resumes ?? parent;
    const pass = matched ? index : up === undefined ? undefined : passAt.get(up);
    if (pass !== undefined) passAt.set(id, pass);
    const held = previous ?? { lastIndex: index, forwardParents: new Set<string>() };

    if (parent !== undefined && resumes === undefined && !matched) {
      const fromStage = stageIdOf(parent);
      const explained =
        previous === undefined ||
        (fold.collects!.v >= RUN_LOOP_EVIDENCE_VERSION &&
          pass !== undefined &&
          pass > previous.lastIndex &&
          previous.forwardParents.has(fromStage));
      if (explained) held.forwardParents.add(fromStage);
      else uncertain.add(id);
    }
    held.lastIndex = index;
    stages.set(stage, held);
  }
  return uncertain;
}

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
  const reentries = new Map<string, LoopBackEdges>();
  for (const edge of hasNotes ? edges : []) {
    const { logRunId } = edge.fold.address;
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
  return { reentries, uncertain: unexplainedRepeats(edges, reentries) };
}
