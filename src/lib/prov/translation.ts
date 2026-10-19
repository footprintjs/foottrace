import type { GapCode } from '../evidence/codes.js';
import type { ProvRoutineGap } from './gaps.js';
import type { ProvIds } from './ids.js';
import type { AdmittedRow, ProvExportGap, ProvNode } from './types.js';

/** Owned facts supplied by the driver, never the untrusted record or a mutable output sink. */
export interface ProvCommitContext {
  readonly ids: ProvIds;
  readonly activities: ReadonlySet<string>;
  readonly parent?: string;
  hasUntrackedInput(): boolean;
  readonly scopeGaps: readonly GapCode[];
  readGaps(row: AdmittedRow): readonly GapCode[];
  hides(path: string): boolean;
}

/** The driver applies effects in order and acknowledges each node's acceptance. */
export type ProvTranslation =
  | { readonly kind: 'node'; readonly node: ProvNode; readonly activity?: string; readonly entity?: string }
  | { readonly kind: 'gap'; readonly gap: ProvExportGap }
  | { readonly kind: 'routine-gap'; readonly category: ProvRoutineGap };

export const reference = (id: string): ProvNode => ({ '@id': id });
