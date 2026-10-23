import type { ReadSourceCapture } from './capture.js';

// Neither a public property nor a matching run ID can transfer native ownership.
const bindings = new WeakMap<object, ReadSourceCapture>();
const segments = new WeakMap<object, number>();
export const captureFor = (target: object | undefined): ReadSourceCapture | undefined =>
  target === undefined ? undefined : bindings.get(target);
export function bindCapture(target: object, capture: ReadSourceCapture): void {
  if (bindings.get(target) && !bindings.get(target)!.retired) throw new TypeError('read sources: already bound');
  bindings.set(target, capture);
  // A retired binding remains readable as retired evidence until replaced. No old book
  // detaches a newer one; WeakMap ownership never keeps its heap/log key alive.
}
export function nextSourceSegment(target: object): number {
  const previous = segments.get(target) ?? 0;
  if (previous === Number.MAX_SAFE_INTEGER) throw new RangeError('read sources: segment limit');
  segments.set(target, previous + 1);
  return previous + 1;
}
