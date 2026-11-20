import { recordList, recordName, recordOwn, RecordRefusal } from '../recordValidation.js';
import { keyOf, outputSelection, range, selection } from './selectors.js';
import type { ServedRow, SourceLinkRow } from './types.js';

export function optionalTrue(value: unknown): true | undefined {
  if (value !== undefined && value !== true) throw new RecordRefusal();
  return value;
}

export function checkOf(
  value: unknown,
): Pick<SourceLinkRow, 'linkBasis' | 'check' | 'namedBy' | 'bounded' | 'leafWithheld'> {
  const linkBasis = recordOwn(value, 'linkBasis');
  const check = recordOwn(value, 'check');
  const namedBy = recordOwn(value, 'namedBy');
  const bounded = optionalTrue(recordOwn(value, 'bounded'));
  const leafWithheld = optionalTrue(recordOwn(value, 'leafWithheld'));
  const named = namedBy === 'model' || namedBy === 'person' || namedBy === 'provider';
  const flags = {
    ...(bounded === undefined ? {} : { bounded }),
    ...(leafWithheld === undefined ? {} : { leafWithheld }),
  };
  if (linkBasis === 'reference' && check === 'redeemed' && namedBy === undefined) return { linkBasis, check, ...flags };
  if (linkBasis === 'match' && (check === 'value-found' || check === 'not-checked') && namedBy === undefined)
    return { linkBasis, check, ...flags };
  if (
    linkBasis === 'citation' &&
    named &&
    (check === 'value-found' || check === 'field-matched' || check === 'no-match' || check === 'not-checked')
  )
    return { linkBasis, check, namedBy, ...flags };
  throw new RecordRefusal();
}

/** Read a committed source-link check without executing accessors or retaining its input object. */
export function readSourceLinkRow(value: unknown): SourceLinkRow | undefined {
  try {
    if (recordOwn(value, 'kind') !== 'source-link' || recordOwn(value, 'version') !== 1) return undefined;
    const input = recordOwn(value, 'input');
    return Object.freeze({
      kind: 'source-link',
      version: 1,
      ...checkOf(value),
      consumer: recordName(recordOwn(value, 'consumer')),
      output: Object.freeze(outputSelection(recordOwn(value, 'output'))),
      ...(input === undefined ? {} : { input: Object.freeze(selection(input)) }),
    });
  } catch {
    return undefined;
  }
}

/** Read the bounded, canonical positions a consumer recorded for its request. */
export function readServedRow(value: unknown): ServedRow | undefined {
  try {
    if (recordOwn(value, 'kind') !== 'served' || recordOwn(value, 'version') !== 1) return undefined;
    const bounded = optionalTrue(recordOwn(value, 'bounded'));
    const keys = new Set<string>();
    const served = recordList(recordOwn(value, 'served'), 16).map((entry) => {
      const key = keyOf(recordOwn(entry, 'key'));
      if (keys.has(key)) throw new RecordRefusal();
      keys.add(key);
      const raw = recordOwn(entry, 'elements');
      if (raw === undefined) return Object.freeze({ key });
      const elements = recordList(raw, 64).map(range);
      if (elements.some(([start], index) => index > 0 && start < elements[index - 1][1])) throw new RecordRefusal();
      return Object.freeze({ key, elements: Object.freeze(elements) });
    });
    return Object.freeze({
      kind: 'served',
      version: 1,
      consumer: recordName(recordOwn(value, 'consumer')),
      served: Object.freeze(served),
      ...(bounded === undefined ? {} : { bounded }),
    });
  } catch {
    return undefined;
  }
}
