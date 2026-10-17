import type { NodeId } from './types.js';
import { nodeIds } from './validation.js';

/** Strategies may only select admitted nodes; impact ranking must preserve the full set. */
export function admitRanking(
  raw: unknown,
  allowed: ReadonlySet<NodeId>,
  options: { readonly exactPermutation: boolean; readonly maximum: number },
): readonly NodeId[] {
  const ids = nodeIds(raw, options.maximum);
  if (
    (options.exactPermutation && ids.length !== allowed.size) ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !allowed.has(id))
  )
    throw new TypeError();
  return ids;
}
