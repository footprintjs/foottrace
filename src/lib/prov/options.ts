import { ownData } from '../evidence/admission.js';
import type { ProvExportOptions, ProvLimits } from './types.js';

export class ProvExportRefusal extends TypeError {
  readonly code = 'PROV_EXPORT_OPTIONS';
  constructor() {
    super('prov: invalid export options');
  }
}
const refuse = (): ProvExportRefusal => new ProvExportRefusal();
const policy = { translateTrapErrors: true, requireOwnValue: true };
const rules = {
  maxCommits: [4096, 4096],
  maxRows: [16384, 65536],
  maxReads: [16384, 65536],
  maxFields: [50000, 1000000],
  maxNodes: [32768, 65536],
  maxRelations: [32768, 65536],
  maxStringBytes: [1048576, 4194304],
  maxOutputBytes: [1048576, 16777216],
  maxDepth: [128, 512],
  maxWork: [250000, 2000000],
} as const;

/** Trusted options are data too: no accessor evaluation or silently ignored future surfaces. */
export function provOptions(options: ProvExportOptions): ProvLimits {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw refuse();
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== null && prototype !== Object.prototype) throw refuse();
    const keys = Reflect.ownKeys(options);
    if (
      keys.length > 12 ||
      keys.some((key) => typeof key !== 'string' || (key !== 'base' && key !== 'values' && !Object.hasOwn(rules, key)))
    )
      throw refuse();
    const base = ownData(options, 'base', refuse, policy);
    if (
      typeof base !== 'string' ||
      base.length > 4096 ||
      !base.length ||
      /[\u0000-\u0020\u007f-\u009f?#<>\"{}|^`\\]/.test(base) ||
      /%(?![A-Fa-f0-9]{2})/.test(base) ||
      !wellFormed(base)
    )
      throw refuse();
    if (/^https:\/\//i.test(base)) {
      const url = new URL(base);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || base.includes('\\'))
        throw refuse();
    } else if (!/^urn:[a-z0-9][a-z0-9-]{0,31}:/i.test(base)) throw refuse();
    const values = ownData(options, 'values', refuse, policy);
    if (values !== undefined && values !== 'none') throw refuse();
    const result = { base, values: 'none' } as { -readonly [K in keyof ProvLimits]: ProvLimits[K] };
    for (const key of Object.keys(rules) as (keyof typeof rules)[]) {
      const configured = ownData(options, key, refuse, policy);
      const value = configured === undefined ? rules[key][0] : configured;
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < (key === 'maxOutputBytes' ? 2048 : 1) ||
        value > rules[key][1]
      )
        throw refuse();
      result[key] = value;
    }
    return Object.freeze(result);
  } catch {
    throw refuse();
  }
}

/** Reject ill-formed identities without replacing distinct surrogate spellings. */
export function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
