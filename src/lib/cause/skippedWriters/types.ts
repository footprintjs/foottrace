/** One placement in the bound graph. Several placements can refer to the same static stage. */
export interface NormalizedSkippedStage {
  readonly id: string;
  readonly stageId: string;
  readonly role: 'stage' | 'mount' | 'loop-reference' | 'join';
  readonly edges: readonly string[];
  /** When supplied, the declaration covers every key this stage can write. */
  readonly writes?: readonly string[];
}

export interface SkippedWriter {
  readonly placementId: string;
  readonly stageId: string;
  readonly basis: 'declared' | 'observed';
}

export type SkippedPathGap = 'graph-ambiguous' | 'writers-unknown' | 'scope-boundary' | 'limit';

export interface SkippedWork {
  left: number;
}

export interface NormalizedChoice {
  readonly entry: string;
  readonly name: string;
  readonly fallback?: true;
  readonly loopBack?: {
    readonly body: string;
    /** The actual dispatch must positively select this direct exit. */
    readonly exit: string;
    readonly owner: string;
  };
}

export interface NormalizedControl {
  readonly placementId: string;
  readonly kind: 'decider' | 'selector';
  readonly choices: readonly NormalizedChoice[];
  /** Null means a proved end without a shared continuation. */
  readonly continuation: string | null;
}

/** Version-1 projected chart supplied by the capture producer. */
export interface SkippedChartProjection {
  readonly stages: readonly NormalizedSkippedStage[];
  readonly controls: readonly NormalizedControl[];
}
