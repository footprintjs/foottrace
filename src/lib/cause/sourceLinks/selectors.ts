import { isDeniedSegment } from '../../memory/pathOps.js';
import { pathSegments } from '../../record-paths/codec.js';
import { recordList, recordName, recordOwn, RecordRefusal } from '../recordValidation.js';
import type { SourceLinkOutput, SourceLinkSelection } from './types.js';

export function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new RecordRefusal();
  return value;
}

export function keyOf(value: unknown): string {
  const key = recordName(value, true);
  if (pathSegments(key).some((segment) => !segment || isDeniedSegment(segment))) throw new RecordRefusal();
  return key;
}

export function pointerParts(pointer: string): string[] {
  if (pointer === '') return [];
  if (pointer.length > 512 || !pointer.startsWith('/')) throw new RecordRefusal();
  const parts = pointer.slice(1).split('/');
  if (parts.length > 32 || parts.some((part) => /~(?![01])/u.test(part))) throw new RecordRefusal();
  return parts.map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function range(value: unknown): readonly [number, number] {
  const parts = recordList(value, 2, 2);
  const start = count(parts[0]);
  const end = count(parts[1]);
  if (start >= end) throw new RecordRefusal();
  return Object.freeze([start, end]);
}

export function selection(value: unknown): SourceLinkSelection {
  const key = keyOf(recordOwn(value, 'key'));
  const element = recordOwn(value, 'element');
  const pointer = recordOwn(value, 'pointer');
  if (pointer !== undefined) {
    if (typeof pointer !== 'string') throw new RecordRefusal();
    pointerParts(pointer);
  }
  return {
    key,
    ...(element === undefined ? {} : { element: count(element) }),
    ...(pointer === undefined ? {} : { pointer }),
  };
}

export function outputSelection(value: unknown): SourceLinkOutput {
  const checkedIn = recordOwn(value, 'checkedIn');
  const span = recordOwn(value, 'span');
  if (checkedIn !== 'read' && checkedIn !== 'written') throw new RecordRefusal();
  return {
    ...selection(value),
    checkedIn,
    ...(span === undefined ? {} : { span: range(span) }),
  };
}
