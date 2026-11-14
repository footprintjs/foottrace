/** Private strict JSON domain; public capabilities own their separate policies and errors. */
export type OwnedJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly OwnedJsonValue[]
  | { readonly [key: string]: OwnedJsonValue };

/** Concrete, validated bounds supplied by an internal capability adapter, never raw caller options. */
export interface OwnedJsonBounds {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxFields: number;
  readonly maxStringBytes: number;
  readonly maxSortWork: number;
  readonly maxBytes: number;
}
export interface OwnedJsonSnapshot {
  readonly value: OwnedJsonValue;
  readonly text: string;
  readonly bytes: number;
}
export type OwnedJsonErrorCode =
  | 'unsupported'
  | 'unicode'
  | 'cycle'
  | 'unreadable'
  | 'depth'
  | 'nodes'
  | 'fields'
  | 'string-bytes'
  | 'sort-work'
  | 'output-bytes';

/** Internal fixed refusal; boundary adapters translate it without forwarding trap exception text. */
export class OwnedJsonError extends Error {
  constructor(readonly code: OwnedJsonErrorCode) {
    super('Owned JSON refused: ' + code);
    this.name = 'OwnedJsonError';
  }
}
