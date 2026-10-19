import type { Attention } from '../cause/types.js';
import type { GapCode } from '../evidence/codes.js';
import type { ControlDependency } from '../memory/backtrack.js';
import type { LogAddress } from '../memory/eventPosition.js';
import type { CommitBundle, TraceEntry } from '../memory/types.js';

export interface ProvExportOptions {
  readonly base: string;
  readonly values?: 'none';
  readonly maxCommits?: number;
  readonly maxRows?: number;
  readonly maxReads?: number;
  readonly maxFields?: number;
  readonly maxNodes?: number;
  readonly maxRelations?: number;
  readonly maxStringBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxDepth?: number;
  readonly maxWork?: number;
}
export type ProvLimits = Required<ProvExportOptions>;
export type ProvValue = string | number | boolean | null | ProvNode | readonly ProvValue[];
export interface ProvNode {
  readonly [key: string]: ProvValue;
}
export interface ProvExportGap {
  readonly code: GapCode;
  readonly commitIdx?: number;
  readonly rowIdx?: number;
  readonly reason?: string;
}
export interface ProvDocument {
  readonly '@context': ProvNode;
  readonly '@graph': readonly ProvNode[];
}
export interface ProvExport {
  readonly document: ProvDocument;
  readonly gaps: readonly ProvExportGap[];
  readonly complete: boolean;
}
export interface AdmittedRow extends TraceEntry {
  readonly commitIdx: number;
  readonly rowIdx: number;
}
export interface AdmittedCommit {
  readonly commitIdx: number;
  readonly bundle: CommitBundle;
  readonly rows: readonly AdmittedRow[];
}
export interface ProvPrivacy {
  readonly hideAllPaths: boolean;
  readonly redactedPaths: readonly string[];
  hides(path: string): boolean;
}
export interface AdmittedProvRecord {
  readonly commits: readonly AdmittedCommit[];
  readonly log: CommitBundle[];
  readonly reads?: Map<string, string[]>;
  readonly control?: Map<string, ControlDependency>;
  readonly attention?: Map<string, readonly Attention[]>;
  readonly address?: LogAddress;
  readonly privacy: ProvPrivacy;
  readonly gaps: readonly ProvExportGap[];
  readonly complete: false;
}
