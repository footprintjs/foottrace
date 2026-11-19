import type { Touch } from '../../memory/verbs.js';
import { nativeGet } from '../../memory/pathOps.js';
import { pathSegments } from '../../record-paths/codec.js';
import { spend } from '../recordValidation.js';

/** Charge visited data and a conservative reserve for replay and comparison copies. */
export function chargeValue(budget: { left: number }, value: unknown, copies = 1): void {
  const pending = [value];
  while (pending.length) {
    const part = pending.pop();
    spend(budget, copies * (1 + (typeof part === 'string' ? part.length : 0)));
    if (typeof part !== 'object' || part === null) continue;
    if (Array.isArray(part)) spend(budget, copies * part.length);
    for (const key in part) {
      if (!Object.hasOwn(part, key)) continue;
      spend(budget, copies * (key.length + 1));
      pending.push((part as Record<string, unknown>)[key]);
    }
  }
}

/** Charge the old state and operands before the core fold can copy or retain them. */
export function chargeRow(
  budget: { left: number },
  touch: Touch,
  state: Readonly<Record<string, unknown>>,
  root: string,
): void {
  const { bundle } = touch;
  chargeValue(budget, nativeGet(state, [root]), 3);
  chargeValue(budget, nativeGet(bundle.overwrite, [root]), 3);
  chargeValue(budget, nativeGet(bundle.updates, [root]), 3);
  const segments = pathSegments(touch.path);
  // A sparse write can grow an array by its numeric index or an explicit length.
  // Reserve this before any later operation can materialize it.
  for (let at = 1; at < segments.length; at++) {
    const container = nativeGet(state, segments.slice(0, at));
    if (!Array.isArray(container)) continue;
    const segment = segments[at];
    const index = /^(0|[1-9][0-9]*)$/.test(segment) ? Number(segment) : -1;
    if (index >= container.length && index < 0xffffffff) spend(budget, index + 1 - container.length);
    if (segment !== 'length') continue;
    const length = nativeGet(bundle.overwrite, segments.slice(0, at + 1));
    if (typeof length === 'number' && Number.isInteger(length) && length > container.length)
      spend(budget, length - container.length);
  }
}
