import type { LogAddress } from '../../memory/eventPosition.js';
import type { GapCode, GraphContext, NodeId } from '../types.js';

export interface SourceLinkSelection {
  readonly key: string;
  readonly element?: number;
  readonly pointer?: string;
}

export interface SourceLinkOutput extends SourceLinkSelection {
  readonly checkedIn: 'read' | 'written';
  readonly span?: readonly [number, number];
}

export interface SourceLinkRow {
  readonly kind: 'source-link';
  readonly version: 1;
  readonly linkBasis: 'reference' | 'citation' | 'match';
  readonly namedBy?: 'model' | 'person' | 'provider';
  readonly check: 'redeemed' | 'value-found' | 'field-matched' | 'no-match' | 'not-checked';
  readonly bounded?: true;
  readonly leafWithheld?: true;
  readonly consumer: string;
  readonly output: SourceLinkOutput;
  readonly input?: SourceLinkSelection;
}

export interface ServedRow {
  readonly kind: 'served';
  readonly version: 1;
  readonly consumer: string;
  readonly served: readonly {
    readonly key: string;
    readonly elements?: readonly (readonly [number, number])[];
  }[];
  readonly bounded?: true;
}

export interface SourceLinkWrite {
  readonly runtimeStageId: string;
  readonly commitIdx: number;
}
export interface SourceLinkRowLocation extends SourceLinkWrite {
  readonly key: string;
  readonly element: number;
}

export interface RecordSourceLink extends Omit<SourceLinkRow, 'kind' | 'version' | 'consumer' | 'output'> {
  readonly consumer: { readonly runtimeStageId: string };
  readonly output: SourceLinkOutput & SourceLinkWrite;
  readonly served?: Pick<SourceLinkSelection, 'key'>;
  readonly witness: SourceLinkRowLocation;
}

export interface RecordSourceLinks {
  readonly version: 1;
  readonly status: 'captured' | 'partial';
  readonly links: readonly RecordSourceLink[];
  readonly limitations: readonly ('privacy-active' | 'budget-exhausted' | 'check-not-armed')[];
}

export type SourceLinkLocator =
  | (SourceLinkSelection & {
      readonly at: 'write';
      readonly address: LogAddress;
      readonly runtimeStageId: string;
      readonly commitIdx?: number;
      readonly span?: readonly [number, number];
    })
  | (SourceLinkSelection & {
      readonly at: 'view';
      readonly address: LogAddress;
      readonly consumer: string;
    });

/** Decides whether a complete locator can be resolved or returned for this query. */
export type SourceLinkPolicy = (locator: SourceLinkLocator, context: GraphContext) => boolean;

export interface SourceLinkGap {
  readonly code: GapCode;
  readonly reason?: string;
  readonly output?: {
    readonly nodeId: NodeId;
    readonly selection: SourceLinkSelection & Pick<SourceLinkOutput, 'span'>;
  };
}

export interface SourceLink {
  readonly attribution: 'source-link';
  readonly standing: 'witnessed' | 'declared';
  readonly linkBasis: SourceLinkRow['linkBasis'];
  readonly namedBy?: SourceLinkRow['namedBy'];
  readonly check: SourceLinkRow['check'];
  readonly output: NonNullable<SourceLinkGap['output']>;
  readonly input: {
    readonly view: Extract<SourceLinkLocator, { at: 'view' }>;
    readonly origin?: { readonly nodeId: NodeId; readonly write: Extract<SourceLinkLocator, { at: 'write' }> };
  };
}
