import { relation } from '../../memory/keyPaths.js';
import { nativeGet } from '../../memory/pathOps.js';
import type { CommitBundle } from '../../memory/types.js';
import { recordsTail } from '../../memory/verbs.js';
import { pathSegments } from '../../record-paths/codec.js';
import type { Transition } from './historyValue.js';

/**
 * Once a value is served, a write across its selection invalidates the link.
 * The only exception is an explicit tail append that preserves an existing
 * list position. Equality can name an older writer and still fail to prove
 * that the old occurrence survived a whole-value replacement.
 */
export function invalidatesServedInput(
  bundle: CommitBundle,
  path: string,
  key: string,
  element: number | undefined,
  transition: Transition,
): boolean {
  return bundle.trace.some((row) => {
    if (relation(row.path, path) === undefined) return false;
    if (element === undefined || row.path !== key || !recordsTail(row.verb)) return true;
    return (
      element >= (transition.before.list?.length ?? 0) || !Array.isArray(nativeGet(bundle.overwrite, pathSegments(key)))
    );
  });
}
