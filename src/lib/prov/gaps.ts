import { utf8Bytes } from './encoding.js';
import type { ProvExportGap } from './types.js';

/** Only these known limitations aggregate; exceptional evidence keeps its native location. */
const routine = {
  'scope-coverage': { code: 'not-collected', reason: 'scope capture coverage is incomplete' },
  'read-coverage': { code: 'not-collected', reason: 'read capture coverage is incomplete' },
  'read-attribution': { code: 'conservative', reason: 'read attribution is stage-level' },
  'untracked-commit': { code: 'untracked-input', reason: 'commits contain untracked inputs' },
  'redacted-commit': { code: 'redacted', reason: 'commits contain redacted paths' },
  'redacted-write': { code: 'redacted', reason: 'write paths withheld' },
  'redacted-read': { code: 'redacted', reason: 'read paths withheld' },
  'read-version': { code: 'ambiguous', reason: 'intra-stage read version was not captured' },
  'read-basis': { code: 'ambiguous', reason: 'read basis is not a single recorded binding' },
  'intermediate-write': { code: 'ambiguous', reason: 'intermediate write value was not retained' },
  'patch-value': { code: 'not-checked', reason: 'final value reconstruction is outside stage one' },
} as const;
export type ProvRoutineGap = keyof typeof routine;
const outputLimit = Object.freeze({ code: 'truncated', reason: 'export output limit reached' } as const);
const overflow = { code: 'truncated', reason: 'additional export gaps withheld' } as const;
const entryBytes = (gap: ProvExportGap): number => utf8Bytes(JSON.stringify(gap)) + 1;
// Include commas and maximum count width before any graph node or report is admitted.
const markerBytes = entryBytes(outputLimit) + entryBytes({ ...overflow, count: Number.MAX_SAFE_INTEGER });

/** Independent bounded gap allowance: future reports can never displace already admitted graph nodes. */
export class ProvGaps {
  readonly reservedBytes: number;
  private readonly held: ProvExportGap[] = [];
  private readonly positions = new Map<string, number>();
  private usedBytes = 0;
  private withheld = 0;
  private outputStopped = false;
  constructor(maxOutputBytes: number) {
    this.reservedBytes = Math.min(32768, Math.floor(maxOutputBytes / 4));
  }
  get gaps(): readonly ProvExportGap[] {
    return [
      ...this.held,
      ...(this.withheld ? [Object.freeze({ ...overflow, count: this.withheld })] : []),
      ...(this.outputStopped ? [outputLimit] : []),
    ];
  }
  markOutputLimit(): void {
    this.outputStopped = true;
  }
  add(gap: ProvExportGap): void {
    const key = JSON.stringify([gap.code, gap.commitIdx, gap.rowIdx, gap.reason]);
    if (!this.positions.has(key)) this.retain(key, gap, entryBytes(gap));
  }
  summarize(kind: ProvRoutineGap): void {
    const key = 'routine:' + kind,
      position = this.positions.get(key);
    if (position !== undefined) {
      const previous = this.held[position];
      this.held[position] = Object.freeze({ ...previous, count: previous.count! + 1 });
      return;
    }
    const gap = { ...routine[kind], count: 1 };
    this.retain(key, gap, entryBytes({ ...gap, count: Number.MAX_SAFE_INTEGER }));
  }
  private retain(key: string, gap: ProvExportGap, bytes: number): void {
    // Two slots and their bytes always remain for overflow and output truncation.
    if (this.held.length >= 254 || this.usedBytes + bytes + markerBytes > this.reservedBytes) {
      this.withheld++;
      return;
    }
    this.positions.set(key, this.held.length);
    this.usedBytes += bytes;
    this.held.push(Object.freeze({ ...gap }));
  }
}
