import type { RecordSink } from '../memory/sink.js';
import { ObservationError } from './types.js';

const required = ['opened', 'commit', 'note', 'closed'] as const;
const methods = [...required, 'flush', 'onFailure'] as const;
const MAX_PROTOTYPES = 16;
type Callback = (...args: unknown[]) => unknown;

/** Trusted callback port, unlike untrusted note data: class data methods retain their instance receiver. */
export function observationSink(input: unknown): RecordSink {
  if (!input || typeof input !== 'object') throw new ObservationError('invalid-options');
  const selected = new Map<(typeof methods)[number], Callback | undefined>();
  const seen = new Set<object>();
  let cursor: object | null = input;
  for (let depth = 0; cursor !== null && selected.size < methods.length; depth++) {
    if (depth >= MAX_PROTOTYPES || seen.has(cursor)) throw new ObservationError('invalid-options');
    seen.add(cursor);
    for (const name of methods) {
      if (selected.has(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
      if (descriptor === undefined) continue;
      if (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'function'))
        throw new ObservationError('invalid-options');
      selected.set(name, descriptor.value as Callback | undefined);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  for (const name of required) if (selected.get(name) === undefined) throw new ObservationError('invalid-options');
  const port: Record<string, Callback> = Object.create(null);
  for (const name of methods) {
    const method = selected.get(name);
    // Capture the admitted data function once; never later read a replacement accessor or mutable .call.
    if (method !== undefined) port[name] = (...args: unknown[]) => Reflect.apply(method, input, args);
  }
  return Object.freeze(port) as unknown as RecordSink;
}
