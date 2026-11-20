import { boundedList, ownData } from '../evidence/admission.js';
import type { GapCode, NodeId, RootSelection } from './types.js';
import { AdmissionError, graphName, nodeIds, plain } from './validation.js';

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

const refuseRootRanking = (code?: GapCode): AdmissionError => new AdmissionError(code);
const rootDescriptors = { translateTrapErrors: true, requireOwnValue: true };
const rootListPolicy = {
  refuse: refuseRootRanking,
  overflow: 'node-limit',
  freeze: true,
  descriptors: rootDescriptors,
  translateArrayErrors: true,
} as const;

function closedKeys(value: unknown, required: readonly string[], optional?: string): readonly PropertyKey[] {
  plain(value);
  const keys = Reflect.ownKeys(value as object);
  const hasOptionalKey = optional !== undefined && keys.length === required.length + 1 && keys.includes(optional);
  if ((keys.length !== required.length && !hasOptionalKey) || !required.every((key) => keys.includes(key))) {
    throw new AdmissionError();
  }
  return keys;
}

/** Admit the host decision as one frozen value. A failed selection or withholding admits neither. */
export function admitRootRanking(
  raw: unknown,
  eligible: ReadonlySet<NodeId>,
  walked: ReadonlySet<NodeId>,
  maximum: number,
): RootSelection {
  if (Array.isArray(raw)) {
    return Object.freeze({ select: admitRanking(raw, eligible, { exactPermutation: false, maximum }) });
  }

  const keys = closedKeys(raw, ['select'], 'withheld');
  const seen = new Set<NodeId>();
  const admitNode = (value: unknown, allowed: ReadonlySet<NodeId>): NodeId => {
    const id = graphName(value);
    if (!allowed.has(id) || seen.has(id)) throw new AdmissionError();
    seen.add(id);
    return id;
  };
  const select = boundedList(
    ownData(raw, 'select', refuseRootRanking, rootDescriptors),
    maximum,
    (value) => admitNode(value, eligible),
    rootListPolicy,
  );
  if (!keys.includes('withheld')) return Object.freeze({ select });

  const withheldSlot = Object.getOwnPropertyDescriptor(raw as object, 'withheld');
  if (!withheldSlot || !Object.hasOwn(withheldSlot, 'value')) throw new AdmissionError();
  const withheldValue: unknown = withheldSlot.value;
  if (withheldValue === undefined) return Object.freeze({ select });

  const withheld = boundedList(
    withheldValue,
    maximum,
    (item) => {
      closedKeys(item, ['nodeId', 'reason']);
      const nodeId = admitNode(ownData(item, 'nodeId', refuseRootRanking, rootDescriptors), walked);
      const reason = graphName(ownData(item, 'reason', refuseRootRanking, rootDescriptors), 64);
      return Object.freeze({ nodeId, reason });
    },
    rootListPolicy,
  );
  return Object.freeze(withheld.length ? { select, withheld } : { select });
}
