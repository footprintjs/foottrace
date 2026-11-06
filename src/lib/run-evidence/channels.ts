/**
 * channels.ts — each kind of fact as a channel: its rows, and how far to trust its absence, from what happened to the logs
 * that hold it.
 */

import type { GapCode } from '../evidence/codes.js';
import type { LogAddress } from '../memory/eventPosition.js';
import { type Admission, isExecutionId } from './fields.js';
import { type Channel, type LogFold, mountOf } from './logFold.js';
import type { EvidenceChannel, StoredMarks, StoredReads, StoredRunningSubflow } from './rows.js';

const NOT_COLLECTED_ROWS: readonly [] = Object.freeze([]) as readonly [];

function notCollected<T>(why: string): EvidenceChannel<T> {
  return Object.freeze({ status: 'not-collected', rows: NOT_COLLECTED_ROWS, why });
}

/** One channel, from what its logs hold and what happened to them. */
export function channelOf<T>(
  rows: readonly T[],
  name: Channel | 'running',
  folds: readonly LogFold[],
  extra: readonly GapCode[] = [],
): EvidenceChannel<T> {
  if (folds.length === 0) return notCollected('no-log');
  const whyOf = (fold: LogFold): string | undefined =>
    fold.why ?? (name === 'reads' && fold.collects?.reads === 'off' ? 'reads-off' : undefined);
  const held = folds.filter((fold) => whyOf(fold) === undefined);
  if (held.length === 0) return notCollected(whyOf(folds[0])!);
  const gaps = new Set<GapCode>(extra);
  if (held.length < folds.length) gaps.add('not-collected');
  for (const fold of held) {
    for (const code of fold.gaps) gaps.add(code);
    if (name !== 'running') for (const code of fold.taint.get(name) ?? []) gaps.add(code);
    if (fold.missing.size > 0 && (name === 'reads' || name === 'attention' || name === 'stages')) {
      gaps.add('not-collected');
    }
  }
  const frozen = Object.freeze([...rows]);
  return gaps.size === 0
    ? Object.freeze({ status: 'collected', rows: frozen })
    : Object.freeze({ status: 'partial', rows: frozen, gaps: Object.freeze([...gaps]) });
}

export function readsChannel(folds: readonly LogFold[]): EvidenceChannel<StoredReads> {
  const rows: StoredReads[] = [];
  const extra = new Set<GapCode>();
  for (const fold of folds) {
    if (fold.collects?.reads !== 'keys') continue;
    for (const [id, { about }] of fold.abouts) {
      const untracked = fold.untracked.get(id);
      if (untracked !== undefined) extra.add('untracked-input');
      if (about.readsOmitted) extra.add('truncated');
      rows.push(
        Object.freeze({
          id,
          address: fold.address,
          keys: about.reads ?? Object.freeze([]),
          ...(about.readsOmitted ? { omitted: about.readsOmitted } : {}),
          ...(untracked === undefined ? {} : { untracked: Object.freeze([...untracked]) }),
        }),
      );
    }
  }
  return channelOf(rows, 'reads', folds, [...extra]);
}

export function attentionChannel(folds: readonly LogFold[]): EvidenceChannel<StoredMarks> {
  const rows: StoredMarks[] = [];
  for (const fold of folds) {
    for (const [id, { about }] of fold.abouts) {
      if (about.attention !== undefined) {
        rows.push(Object.freeze({ id, address: fold.address, marks: about.attention }));
      }
    }
  }
  return channelOf(rows, 'attention', folds);
}

/** The mount logs still open at the end of the file, and of those the innermost. */
export function runningChannel(folds: readonly LogFold[], a: Admission): EvidenceChannel<StoredRunningSubflow> {
  const held = folds.filter((fold) => fold.why === undefined);
  const open = held.filter((fold) => !fold.log.complete && fold.address.drillPath.length > 0);
  const keyOf = ({ logRunId, drillPath }: LogAddress): string => JSON.stringify([logRunId, ...drillPath]);
  const outer = new Set<string>();
  for (const { address } of open) {
    const { logRunId, drillPath } = address;
    for (let depth = 1; depth < drillPath.length; depth++) {
      outer.add(keyOf({ logRunId, drillPath: drillPath.slice(0, depth) }));
    }
  }
  const rows: StoredRunningSubflow[] = [];
  for (const { address } of open) {
    const id = mountOf(address)!;
    if (!outer.has(keyOf(address)) && isExecutionId(id, a)) rows.push(Object.freeze({ id, address }));
  }
  return channelOf(rows, 'running', folds);
}
