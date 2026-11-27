import { readerLimits } from '../evidence/readerLimits.js';
import { recordOwn } from '../evidence/recordData.js';

/** An explicit field limit on either public record reader. */
export function configuredFieldLimit(options: { readonly maxFields?: number }): number | undefined {
  try {
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const value = recordOwn(options, 'maxFields');
    return value == null ? undefined : boundedOption(value, readerLimits.causeTextWork.maximum);
  } catch {
    throw new TypeError('cause: invalid record configuration');
  }
}

/** Refuse an invalid limit before loading a scope or allocating its preparation budget. */
export function boundedOption(configuredValue: unknown, maximum: number): number {
  if (
    typeof configuredValue !== 'number' ||
    !Number.isSafeInteger(configuredValue) ||
    configuredValue < 1 ||
    configuredValue > maximum
  )
    throw new TypeError('cause: invalid record configuration');
  return configuredValue;
}
