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
// One private code vocabulary shared by the core and canonical policy boundary.
// `options` belongs to the latter; the core itself takes only validated bounds.
const codes = [
  'options',
  'unsupported',
  'unicode',
  'cycle',
  'unreadable',
  'depth',
  'nodes',
  'fields',
  'string-bytes',
  'sort-work',
  'output-bytes',
] as const;
export type OwnedJsonErrorCode = (typeof codes)[number];
export const isOwnedJsonErrorCode = (input: unknown): input is OwnedJsonErrorCode =>
  typeof input === 'string' && (codes as readonly string[]).includes(input);

/** Read only a known own DATA code; never use instanceof or message/code access on foreign throws. */
export function ownedJsonFailureCode(error: unknown): OwnedJsonErrorCode {
  try {
    const descriptor =
      error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    if (descriptor && Object.hasOwn(descriptor, 'value') && isOwnedJsonErrorCode(descriptor.value))
      return descriptor.value;
  } catch {
    // A thrown object's descriptor trap is not a second disclosure channel.
  }
  return 'unreadable';
}

/** New fixed refusal after admission; no incoming exception identity or message is retained. */
export class OwnedJsonError extends Error {
  readonly code: OwnedJsonErrorCode;
  constructor(code: OwnedJsonErrorCode) {
    const safe = isOwnedJsonErrorCode(code) ? code : 'unreadable';
    super('Owned JSON refused: ' + safe);
    this.code = safe;
    this.name = 'OwnedJsonError';
  }
}
