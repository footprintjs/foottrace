import type { LogAddress } from '../memory/eventPosition.js';
import { gaps as admitGaps } from './validation.js';
import type { GraphContext, NodeId } from './types.js';
import { nodeIdFor } from './recordIdentity.js';
import { prepareRecordScope } from './recordScope.js';
import type {
  LoadedRecordScope,
  PreparedRecordScope,
  RecordGraphOptions,
  RecordLoaderResult,
  RecordLoadFailure,
  RecordScope,
  RecordScopeHost,
  RecordScopeLoader,
} from './recordTypes.js';
import { addressKey, addressOf, recordList, recordOwn, projectLoaded, RecordRefusal } from './recordValidation.js';
import type { Gap } from './types.js';

interface ScopeLoadState {
  activeLoads: number;
  cache: Map<string, PreparedRecordScope>;
  extraGaps: WeakMap<PreparedRecordScope, readonly Gap['code'][]>;
}
interface ScopeLoadRequest {
  address: LogAddress;
  context: GraphContext;
  controller: AbortController;
  deadline: number;
  cacheKey: string;
}

/** Admit before caching so a cache hit cannot bypass payload limits or lose scope-owned coverage. */
function admitLoadedScope(
  result: RecordLoaderResult,
  request: ScopeLoadRequest,
  limits: Required<RecordGraphOptions>,
  state: ScopeLoadState,
): LoadedRecordScope {
  if (request.controller.signal.aborted || performance.now() >= request.deadline) {
    request.controller.abort();
    return { failure: request.context.signal.aborted ? 'cancelled' : 'timeout' };
  }
  let prepared: PreparedRecordScope;
  try {
    prepared = prepareRecordScope(
      recordOwn(result, 'scope') as RecordScope,
      request.address,
      limits.maxCommits,
      limits.maxFields,
    );
    const extra = recordList(recordOwn(result, 'gaps') ?? [], 32);
    // Coverage belongs to this admitted object, so cached scopes retain the same gap ordering and ownership.
    state.extraGaps.set(
      prepared,
      admitGaps(extra.map((code) => ({ code, evidence: [] }))).map((gap) => gap.code),
    );
  } catch (error) {
    throw error instanceof RecordRefusal ? error : new RecordRefusal();
  }
  if (performance.now() >= request.deadline) {
    request.controller.abort();
    return { failure: 'timeout' };
  }
  if (state.cache.size >= limits.maxScopes && !state.cache.has(request.cacheKey)) return { failure: 'node-limit' };
  state.cache.set(request.cacheKey, prepared);
  return prepared;
}

/** Host failures become fixed gaps while unfinished host work continues to occupy its bounded slot. */
function startScopeWork(
  hostLoad: RecordScopeHost,
  request: ScopeLoadRequest,
  limits: Required<RecordGraphOptions>,
  state: ScopeLoadState,
): Promise<LoadedRecordScope> {
  const work = projectLoaded<RecordLoaderResult, LoadedRecordScope>(
    () => {
      if (request.controller.signal.aborted)
        throw new RecordRefusal(request.context.signal.aborted ? 'cancelled' : 'timeout');
      return hostLoad(request.address, { signal: request.controller.signal });
    },
    (result) => admitLoadedScope(result, request, limits, state),
  ).catch((error): RecordLoadFailure => {
    if (request.context.signal.aborted) return { failure: 'cancelled' };
    if (performance.now() >= request.deadline) {
      request.controller.abort();
      return { failure: 'timeout' };
    }
    return { failure: error instanceof RecordRefusal ? error.code : 'unavailable' };
  });
  // A timed-out host operation retains its slot until it settles; repeated timeouts cannot grow an unbounded I/O pool.
  void work.then(
    () => {
      state.activeLoads--;
    },
    () => {
      state.activeLoads--;
    },
  );
  return work;
}

/** Bound caller waiting independently of host cooperation without sharing cancellation between requests. */
export function createRecordScopeLoader(
  hostLoad: RecordScopeHost,
  limits: Required<RecordGraphOptions>,
): RecordScopeLoader {
  const state: ScopeLoadState = { activeLoads: 0, cache: new Map(), extraGaps: new WeakMap() };
  return {
    async loadScope(address, context) {
      if (context.signal.aborted) return { failure: 'cancelled' };
      const cacheKey = addressKey(address);
      const cached = state.cache.get(cacheKey);
      if (cached) return cached;
      if (state.cache.size + state.activeLoads >= limits.maxScopes) return { failure: 'node-limit' };
      state.activeLoads++;
      const deadline = performance.now() + limits.loadTimeoutMs;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finish: ((value: RecordLoadFailure) => void) | undefined;
      const interrupted = new Promise<RecordLoadFailure>((resolve) => {
        finish = resolve;
      });
      const cancel = () => {
        controller.abort();
        finish?.({ failure: 'cancelled' });
      };
      context.signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        finish?.({ failure: 'timeout' });
      }, limits.loadTimeoutMs);
      try {
        const work = startScopeWork(hostLoad, { address, context, controller, deadline, cacheKey }, limits, state);
        return await Promise.race([work, interrupted]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        context.signal.removeEventListener('abort', cancel);
      }
    },
    extraGapCodes: (scope) => state.extraGaps.get(scope),
  };
}

/** Discovery must distinguish an unavailable scope from a successfully loaded empty record. */
export async function openRecordScope(
  addressInput: LogAddress,
  context: GraphContext,
  loader: RecordScopeLoader,
): Promise<readonly NodeId[]> {
  let address: LogAddress;
  try {
    address = addressOf(addressInput);
  } catch {
    throw new RecordRefusal();
  }
  const scope = await loader.loadScope(address, context);
  if ('failure' in scope) throw new RecordRefusal(scope.failure);
  // Empty unfinished evidence has no node on which to report its gap; discovery must reject instead.
  if (
    !scope.log.length &&
    (!scope.complete ||
      scope.control === undefined ||
      scope.marks === undefined ||
      (loader.extraGapCodes(scope)?.length ?? 0) > 0)
  )
    throw new RecordRefusal('not-collected');
  return scope.log.map((bundle, commitIndex) =>
    nodeIdFor(address, { runtimeStageId: bundle.runtimeStageId, commitIdx: commitIndex }),
  );
}
