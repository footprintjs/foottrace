import { relation } from '../memory/keyPaths.js';
import { dataField, dataPaths, ProvBudget, refusalCode } from './budget.js';
import type { ProvPrivacy } from './types.js';

export interface PrivacyInspection {
  readonly privacy: ProvPrivacy;
  readonly redactions: ReadonlyMap<number, string[]>;
}

/** Inspect the entire selected scope before mapping; unknown tails suppress every path.
 * Finalize all hides() queries before output: a refused query can conservatively switch to hide-all.
 */
export function inspectPrivacy(rawLog: readonly unknown[], truncated: boolean, budget: ProvBudget): PrivacyInspection {
  let hidden = truncated;
  const redactions = new Map<number, string[]>(),
    union = new Set<string>();
  for (let index = 0; index < rawLog.length; index++) {
    try {
      const raw = dataField(rawLog[index], 'redactedPaths', budget);
      const paths = raw === undefined ? [] : dataPaths(raw, budget, 'fields');
      redactions.set(index, paths);
      for (const path of paths) union.add(path);
    } catch (error) {
      hidden = true;
      budget.addGap({ code: refusalCode(error), commitIdx: index, reason: 'privacy evidence unavailable' });
      if (budget.exhausted('work') || budget.exhausted('fields') || budget.exhausted('stringBytes')) break;
    }
  }
  if (hidden)
    budget.addGap({ code: 'not-collected', reason: 'path disclosure withheld because privacy coverage is incomplete' });
  if (union.size) budget.addGap({ code: 'redacted', reason: 'redacted path families withheld' });
  const paths = Object.freeze([...union]);
  const privacy: ProvPrivacy = Object.freeze({
    get hideAllPaths() {
      return hidden;
    },
    redactedPaths: paths,
    hides(path: string) {
      if (hidden) return true;
      for (const redacted of paths) {
        if (!budget.spend('work')) {
          hidden = true;
          return true;
        }
        if (relation(redacted, path) !== undefined) return true;
      }
      return false;
    },
  });
  return { privacy, redactions };
}
