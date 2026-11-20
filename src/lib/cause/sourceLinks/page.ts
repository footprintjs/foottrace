import type { Adjacency, SourceLinkPage } from '../types.js';
import type { SourceLink, SourceLinkGap } from './types.js';

/** Pages assembled by a record adapter that checked the whole locator policy. */
const projected = new WeakMap<object, SourceLinkPage>();

export function withSourceLinkPage(base: Adjacency, page: SourceLinkPage): Adjacency {
  if (!page.sourceLinks?.length && !page.sourceLinkGaps?.length) return base;
  const result = Object.freeze({ ...base, ...page });
  projected.set(result, page);
  return result;
}

/** Copy only authorized record pages across the generic graph boundary. */
export function sourceLinkPageOf(raw: object): SourceLinkPage | undefined {
  return projected.get(raw);
}

export function sourceLinkPage(links: readonly SourceLink[], gaps: readonly SourceLinkGap[]): SourceLinkPage {
  const distinct = new Map<string, SourceLinkGap>();
  for (const gap of gaps) distinct.set(JSON.stringify(gap), Object.freeze(gap));
  return Object.freeze({
    ...(links.length === 0 ? {} : { sourceLinks: Object.freeze([...links]) }),
    ...(distinct.size === 0 ? {} : { sourceLinkGaps: Object.freeze([...distinct.values()]) }),
  });
}
