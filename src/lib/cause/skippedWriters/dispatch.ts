import type { StoredDecision } from '../../run-evidence/rows.js';
import { walkSkippedPath } from './reach.js';
import type {
  NormalizedChoice,
  NormalizedControl,
  NormalizedSkippedStage,
  SkippedPathGap,
  SkippedWork,
  SkippedWriter,
} from './types.js';

interface SkippedBranch {
  readonly entry: string;
  readonly writers: readonly SkippedWriter[];
}

function charge(budget: SkippedWork): boolean {
  if (budget.left < 1) return false;
  budget.left--;
  return true;
}

/** The committed decision's chosen names identify direct, unique placements on the bound graph. */
function selected(
  decision: StoredDecision,
  control: NormalizedControl,
  budget: SkippedWork,
): ReadonlySet<string> | SkippedPathGap {
  const multiple = typeof decision.chosen !== 'string';
  if (
    (control.kind === 'selector') !== multiple ||
    (multiple && (decision.fellBack || decision.total !== control.choices.length))
  ) {
    return 'graph-ambiguous';
  }
  const choices = new Map<string, NormalizedChoice | undefined>();
  let fallback: NormalizedChoice | undefined;
  const entries = new Set<string>();
  for (const choice of control.choices) {
    if (!charge(budget)) return 'limit';
    if (entries.has(choice.entry)) return 'graph-ambiguous';
    entries.add(choice.entry);
    choices.set(choice.name, choices.has(choice.name) ? undefined : choice);
    if (choice.fallback) {
      if (fallback !== undefined) return 'graph-ambiguous';
      fallback = choice;
    }
  }
  const names = typeof decision.chosen === 'string' ? [decision.chosen] : decision.chosen;
  const taken = new Set<string>();
  for (const name of names) {
    if (!charge(budget)) return 'limit';
    const choice = choices.get(name);
    if (!choice || taken.has(choice.entry) || (decision.fellBack && choice !== fallback)) return 'graph-ambiguous';
    taken.add(choice.entry);
  }
  return taken;
}

export function skippedBranches(
  decision: StoredDecision,
  control: NormalizedControl,
  stages: ReadonlyMap<string, NormalizedSkippedStage>,
  observed: ReadonlySet<string>,
  declaredMatches: (path: string) => boolean,
  loop: { readonly recorded: boolean; readonly sawReturn: (targetStageId: string) => boolean },
  budget: SkippedWork,
): { readonly branches: readonly SkippedBranch[]; readonly gaps: readonly (SkippedPathGap | 'loop-evidence')[] } {
  const taken = selected(decision, control, budget);
  if (typeof taken === 'string') return { branches: [], gaps: [taken] };

  const branches: SkippedBranch[] = [];
  const gaps = new Set<SkippedPathGap | 'loop-evidence'>();
  const boundary = new Set([control.placementId]);
  if (control.continuation !== null) boundary.add(control.continuation);
  for (const choice of control.choices) {
    if (!charge(budget)) {
      gaps.add('limit');
      break;
    }
    if (taken.has(choice.entry)) continue;
    const skippedLoop = choice.loopBack;
    const body = skippedLoop && stages.get(skippedLoop.body);
    if (skippedLoop && (!loop.recorded || !taken.has(skippedLoop.exit) || (body && loop.sawReturn(body.stageId)))) {
      gaps.add('loop-evidence');
      continue;
    }
    const stop = skippedLoop ? new Set([...boundary, skippedLoop.owner]) : boundary;
    // A loop-return choice can be executable before its reference. Credit that choice and one re-entered body.
    const entries =
      skippedLoop && skippedLoop.body !== choice.entry ? [choice.entry, skippedLoop.body] : [choice.entry];
    const writers = new Map<string, SkippedWriter>();
    let ambiguous = false;
    for (const entry of entries) {
      const path = walkSkippedPath(stages, entry, stop, observed, declaredMatches, budget);
      for (const gap of path.gaps) gaps.add(gap);
      if (path.gaps.includes('graph-ambiguous')) {
        ambiguous = true;
        break;
      }
      for (const writer of path.writers) writers.set(writer.placementId, writer);
      if (gaps.has('limit')) break;
    }
    if (!ambiguous && writers.size) branches.push({ entry: choice.entry, writers: [...writers.values()] });
    if (gaps.has('limit')) break;
  }
  return { branches, gaps: [...gaps] };
}
