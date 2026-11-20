import { bindSourceLinkWrite } from '../../../src/cause.js';
import type { CommitBundle, TraceEntry } from '../../../src/lib/memory/types.js';
import { DELIM } from '../../../src/lib/record-paths/codec.js';
import {
  address,
  bundle,
  exactPolicy,
  linkFor,
  parents,
  scopeFor,
  servedWrite,
  witness,
  type Adapter,
  type Encoding,
} from './recordHarness.js';

export const placements = ['window', 'between', 'witness'] as const;
export const relations = ['above', 'on', 'inside', 'beside'] as const;
export type WindowRecipe = {
  placement: (typeof placements)[number];
  relation: (typeof relations)[number];
  hidden: string;
  verb?: TraceEntry['verb'];
};

function rewrite(
  { relation, hidden, verb = 'set' }: WindowRecipe,
  encoding: Encoding,
  key: string,
  idx: number,
): CommitBundle {
  const profile = { chosen: 'shown', hidden };
  if (verb === 'append') {
    const tail = { other: 'tail' };
    return encoding === 'delta'
      ? bundle(idx, 'parallel', { outer: [tail] }, [{ path: 'outer', verb: 'append' }])
      : bundle(idx, 'parallel', { outer: [{ profile }, tail] });
  }
  if (verb === 'merge') {
    return encoding === 'delta'
      ? bundle(idx, 'parallel', {}, [{ path: 'outer', verb: 'merge' }], { outer: { profile: { hidden } } })
      : bundle(idx, 'parallel', { outer: { profile, other: 'stable' } });
  }
  if (verb === 'delete') {
    return encoding === 'delta'
      ? bundle(idx, 'parallel', { outer: undefined }, [{ path: 'outer', verb: 'delete' }])
      : bundle(idx, 'parallel', { outer: undefined });
  }
  const rows = {
    above: ['outer', { profile, other: 'stable' }],
    on: [key, { profile }],
    inside: [`${key}${DELIM}hidden`, { profile: { hidden } }],
    beside: [`outer${DELIM}other`, { other: 'changed' }],
  } as const;
  const [path, outer] = rows[relation];
  return bundle(idx, 'parallel', { outer }, [{ path, verb: 'set' }]);
}

function materialize(recipe: WindowRecipe, encoding: Encoding, twin: boolean, checkedIn: 'read' | 'written') {
  const { hidden, placement, verb } = recipe;
  const readChecked = checkedIn === 'read';
  const key = verb === 'append' ? ['outer', '0', 'profile'].join(DELIM) : ['outer', 'profile'].join(DELIM);
  const selected = { key, pointer: '/chosen' };
  const input = readChecked ? { key: 'seed' } : selected;
  const output = readChecked ? { ...selected, checkedIn } : { key: 'answer', checkedIn };
  // Only the ungranted sibling differs. In the first twin the ancestor rewrite retains it.
  const profile = { chosen: readChecked ? 'unwritten' : 'shown', hidden: twin ? `${hidden}!` : hidden };
  const initialState = {
    seed: 'seed',
    outer: verb === 'append' ? [{ profile }] : { profile, other: 'stable' },
  };
  const consumerIdx = !readChecked && placement === 'window' ? 1 : 0;
  let consumer = servedWrite(consumerIdx, [{ key: input.key }]);
  if (readChecked) {
    const value = verb === 'append' ? [{ profile: { chosen: 'shown' } }] : { profile: { chosen: 'shown' } };
    consumer = bundle(consumerIdx, 'consumer', { ...consumer.overwrite, outer: value }, [
      ...consumer.trace,
      { path: `${key}${DELIM}chosen`, verb: 'set' },
    ]);
  }
  const parallel = rewrite(recipe, encoding, key, consumerIdx === 1 ? 0 : 1);
  const log: CommitBundle[] =
    consumerIdx === 1
      ? [parallel, { ...consumer, beganAt: 0, sawUntil: 1 }]
      : placement === 'witness'
      ? [consumer]
      : [consumer, parallel];
  const row = witness(input, output);
  const door = { commitIdx: log.length, runtimeStageId: 'door' };
  const location = { ...door, key: 'evidence', element: 0 };
  const checkedWrite = readChecked ? { commitIdx: consumerIdx, runtimeStageId: 'consumer' } : door;
  const link = linkFor(row, checkedWrite, location);
  const checked = bundle(
    door.commitIdx,
    'door',
    readChecked ? { evidence: [row] } : { evidence: [row], answer: 'answer' },
  );
  const doorBundle =
    placement === 'witness'
      ? bundle(
          door.commitIdx,
          'door',
          { ...checked.overwrite, ...parallel.overwrite },
          [...checked.trace, ...parallel.trace],
          parallel.updates,
        )
      : readChecked && placement === 'window'
      ? { ...checked, beganAt: 1, sawUntil: 2 }
      : checked;
  log.push(doorBundle);
  const reads: Readonly<Record<string, readonly string[]>> = readChecked ? { door: [key] } : {};
  const scope = { ...scopeFor(initialState, log, [link]), reads };
  return { scope, link, checkedWrite };
}

export function inputWindowPair(recipe: WindowRecipe, encoding: Encoding, adapter: Adapter) {
  return Promise.all(
    [false, true].map((twin) => {
      const { scope, link } = materialize(recipe, encoding, twin, 'written');
      return parents(adapter, scope, link.output, { sourceLinkPolicy: exactPolicy(address, link) });
    }),
  );
}

export function outputWindowPair(recipe: WindowRecipe, encoding: Encoding) {
  return [false, true].map((twin) => {
    const { scope, link, checkedWrite } = materialize(recipe, encoding, twin, 'read');
    return { binding: bindSourceLinkWrite(scope, link.witness), checkedWrite };
  });
}
