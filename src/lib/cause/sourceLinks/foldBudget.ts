import type { Touch } from '../../memory/verbs.js';
import { nativeGet } from '../../memory/pathOps.js';
import { pathSegments } from '../../record-paths/codec.js';
import { spend } from '../recordValidation.js';

/** Reserve containers and slots before replay. Scalar contents are only kept by reference. */
export function chargeShape(budget: { left: number }, value: unknown, copies = 1): void {
  const pending = [value];
  while (pending.length) {
    const part = pending.pop();
    if (typeof part !== 'object' || part === null) continue;
    const list = Array.isArray(part) ? part : undefined;
    spend(budget, copies * (1 + (list?.length ?? 0)));
    for (const key in part) {
      if (!Object.hasOwn(part, key)) continue;
      // Indexed slots were reserved above, including holes that a later append can fill.
      if (!list || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= list.length) spend(budget, copies);
      const child = (part as Record<string, unknown>)[key];
      if (typeof child === 'object' && child !== null) pending.push(child);
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
  chargeShape(budget, nativeGet(state, [root]), 3);
  chargeShape(budget, nativeGet(bundle.overwrite, [root]), 3);
  chargeShape(budget, nativeGet(bundle.updates, [root]), 3);
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
