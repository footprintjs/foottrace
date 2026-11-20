import { queryMemo } from '../queryMemo.js';
import { nodeIdFor } from '../recordIdentity.js';
import type { PreparedRecordScope, ResolvedRecordNode } from '../recordTypes.js';
import { recordRefusalCode, spend } from '../recordValidation.js';
import type { GraphContext, SourceLinkPage } from '../types.js';
import { sourceLinkPage } from './page.js';
import { sourceLinkReplay, type SourceLinkReplay } from './replay.js';
import { resolveLink } from './resolve.js';
import type { SourceLink, SourceLinkGap, SourceLinkPolicy } from './types.js';

const pageLimit = 32;

interface Projection {
  budget: { left: number };
  replay?: SourceLinkReplay;
}

/** Advisory source links have their own quiet budget and cannot introduce graph neighbours. */
export function createSourceLinkProjection(policy: SourceLinkPolicy | undefined, maximumFields: number) {
  // Each graph context belongs to one traversal. Keep derived folds only while that context is live.
  const contexts = new WeakMap<GraphContext, WeakMap<PreparedRecordScope, Projection>>();
  return (node: ResolvedRecordNode, context: GraphContext, direction: 'parents' | 'children'): SourceLinkPage => {
    const { scope, identity, commitIndex } = node;
    const channel = scope.sourceLinks;
    if (!channel || context.signal.aborted || identity.read) return {};
    if (!policy) return sourceLinkPage([], [{ code: 'not-permitted' }]);
    const managed = queryMemo(context) !== undefined;
    let scopes = managed ? contexts.get(context) : undefined;
    if (managed && !scopes) {
      scopes = new WeakMap();
      contexts.set(context, scopes);
    }
    let projection = scopes?.get(scope);
    if (!projection) {
      projection = { budget: { left: maximumFields } };
      scopes?.set(scope, projection);
    }
    const { budget } = projection;
    const state = projection;
    const replay = () =>
      (state.replay ??= sourceLinkReplay(
        {
          log: scope.log,
          base: scope.sourceLinkBase,
          reads: scope.reads,
        },
        budget,
      ));
    const matchingNode = (id: string, index: number | undefined, key: string) =>
      id === identity.runtimeStageId && index === commitIndex && (identity.key === undefined || identity.key === key);
    const links: SourceLink[] = [];
    const gaps: SourceLinkGap[] = channel.gaps.map((code) => ({ code }));
    for (const link of channel.links) {
      const relevant =
        direction === 'parents'
          ? matchingNode(link.output.runtimeStageId, link.output.commitIdx, link.output.key)
          : link.input && (identity.key === undefined || link.input.key === identity.key);
      if (!relevant) continue;
      if (links.length >= pageLimit || gaps.length >= pageLimit) {
        gaps.push({ code: 'truncated' });
        break;
      }
      try {
        spend(budget, 1);
        const result = resolveLink(
          link,
          scope.address,
          context,
          policy,
          (write) => nodeIdFor(scope.address, write),
          replay,
        );
        if (direction === 'parents') {
          gaps.push(...result.gaps);
        } else {
          const origin = result.link?.input.origin?.write;
          if (!origin || !matchingNode(origin.runtimeStageId, origin.commitIdx, origin.key)) continue;
          gaps.push(...result.gaps);
        }
        if (result.link) links.push(result.link);
      } catch (error) {
        gaps.push({ code: recordRefusalCode(error) === 'node-limit' ? 'truncated' : 'invalid-data' });
        break;
      }
    }
    return sourceLinkPage(links, gaps);
  };
}
