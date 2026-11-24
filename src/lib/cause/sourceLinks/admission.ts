import { readerLimits } from '../../evidence/readerLimits.js';
import { recordList, recordName, recordOwn, RecordRefusal, recordRefusalCode, spend } from '../recordValidation.js';
import type { GapCode } from '../types.js';
import { checkOf } from './rows.js';
import { count, keyOf, outputSelection, selection } from './selectors.js';
import type { RecordSourceLink, RecordSourceLinks, SourceLinkRowLocation } from './types.js';

export const maximumSourceLinks = readerLimits.sourceLinkInventory.maximum;

export interface SourceLinkInventory {
  readonly links: readonly RecordSourceLink[];
  readonly gaps: readonly GapCode[];
}

export function rowLocation(value: unknown): SourceLinkRowLocation {
  return {
    runtimeStageId: recordName(recordOwn(value, 'runtimeStageId')),
    commitIdx: count(recordOwn(value, 'commitIdx')),
    key: keyOf(recordOwn(value, 'key')),
    element: count(recordOwn(value, 'element')),
  };
}

function linkOf(value: unknown, budget: { left: number }): RecordSourceLink {
  spend(budget, 22);
  const consumer = recordOwn(value, 'consumer');
  const output = recordOwn(value, 'output');
  const input = recordOwn(value, 'input');
  const served = recordOwn(value, 'served');
  // A leaf grant cannot be silently widened to the whole served write.
  if (
    served !== undefined &&
    ['element', 'pointer', 'span'].some((selector) => recordOwn(served, selector) !== undefined)
  )
    throw new RecordRefusal();
  const outputPlace = outputSelection(output);
  const inputPlace = input === undefined ? undefined : selection(input);
  const witness = rowLocation(recordOwn(value, 'witness'));
  spend(
    budget,
    outputPlace.key.length +
      (outputPlace.pointer?.length ?? 0) +
      witness.key.length +
      (inputPlace === undefined ? 0 : inputPlace.key.length + (inputPlace.pointer?.length ?? 0)),
  );
  return {
    ...checkOf(value),
    consumer: { runtimeStageId: recordName(recordOwn(consumer, 'runtimeStageId')) },
    output: {
      ...outputPlace,
      runtimeStageId: recordName(recordOwn(output, 'runtimeStageId')),
      commitIdx: count(recordOwn(output, 'commitIdx')),
    },
    ...(inputPlace === undefined ? {} : { input: inputPlace }),
    ...(served === undefined ? {} : { served: { key: keyOf(recordOwn(served, 'key')) } }),
    witness,
  };
}

const limitationGaps: Record<RecordSourceLinks['limitations'][number], GapCode> = {
  'privacy-active': 'redacted',
  'budget-exhausted': 'truncated',
  'check-not-armed': 'not-collected',
};

/** Admit the optional wire data without consulting state or exposing raw values. */
export function admitSourceLinks(raw: unknown, budget: { left: number }): SourceLinkInventory {
  const limitations = new Set<GapCode>();
  try {
    spend(budget, 1);
    const status = recordOwn(raw, 'status');
    if (recordOwn(raw, 'version') !== 1 || (status !== 'captured' && status !== 'partial')) throw new RecordRefusal();
    for (const value of recordList(recordOwn(raw, 'limitations'), 3)) {
      if (typeof value !== 'string' || !Object.hasOwn(limitationGaps, value)) throw new RecordRefusal();
      limitations.add(limitationGaps[value as keyof typeof limitationGaps]);
    }
    const rawLinks = recordList(recordOwn(raw, 'links'), maximumSourceLinks);
    const links: RecordSourceLink[] = [];
    for (const value of rawLinks) {
      try {
        links.push(linkOf(value, budget));
      } catch (error) {
        if (recordRefusalCode(error) === 'node-limit') throw error;
        limitations.add('invalid-data');
      }
    }
    if (status === 'partial' && limitations.size === 0) limitations.add('not-collected');
    return { links, gaps: [...limitations] };
  } catch (error) {
    const code = recordRefusalCode(error) ?? 'invalid-data';
    return { links: [], gaps: [code === 'node-limit' && budget.left < 0 ? 'truncated' : code] };
  }
}
