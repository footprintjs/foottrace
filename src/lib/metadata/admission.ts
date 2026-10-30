import { boundedList, ownData } from '../evidence/admission.js';
import { buildWriterIndex, type WriterIndex } from '../memory/keyPaths.js';
import { pathSegments } from '../memory/paths.js';
import { TraceMetadataError } from './errors.js';
import type {
  TraceMetadata,
  TraceMetadataCommit,
  TraceMetadataEntry,
  TraceMetadataInput,
  TraceMetadataPosition,
  TraceMetadataQuery,
  TraceMetadataScope,
} from './types.js';

const descriptors = { translateTrapErrors: true, requireOwnValue: true };
const refuse = () => new TraceMetadataError();
export const own = (value: unknown, key: string): unknown => ownData(value, key, refuse, descriptors);

/** Decoded inert objects only. Reflection can run Proxy traps; this is not a Proxy sandbox. */
export class Admission {
  private fields = 250000;
  private strings = 2000000;
  segments = 0;
  depth = 0;
  spend(count: number): void {
    this.fields -= count;
    if (this.fields < 0) throw refuse();
  }
  object(value: unknown, allowed: readonly string[]): void {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw refuse();
    const keys = Reflect.ownKeys(value);
    if (keys.length > allowed.length) throw refuse();
    this.spend(keys.length);
    for (const key of keys) {
      if (typeof key !== 'string' || !allowed.includes(key)) throw refuse();
      own(value, key); // Check every descriptor, including optional fields, without invoking it.
    }
  }
  list<T>(value: unknown, maximum: number, read: (item: unknown) => T): readonly T[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw refuse();
    const length = integer(own(value, 'length'), 0, maximum);
    this.spend(length + 1);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) throw refuse();
    for (const key of keys) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) throw refuse();
    }
    return boundedList(value, maximum, read, {
      refuse,
      overflow: 'node-limit',
      freeze: true,
      descriptors,
      expectedLength: length,
      translateArrayErrors: true,
    });
  }
  name(value: unknown, path = false): string {
    if (
      typeof value !== 'string' ||
      (!path && value.length === 0) ||
      value.length > 1024 ||
      (path ? /[\u0000-\u001e\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(value)
    )
      throw refuse();
    this.strings -= value.length;
    if (this.strings < 0) throw refuse();
    if (path) {
      const depth = pathSegments(value).length;
      this.segments += depth;
      this.depth = Math.max(this.depth, depth);
      if (depth > 64 || this.segments > 250000) throw refuse();
    }
    return value;
  }
  scope(value: unknown): TraceMetadataScope {
    this.object(value, ['sourceId', 'runId', 'invocationId', 'invocationPath']);
    const sourceId = this.name(own(value, 'sourceId'));
    const runId = this.name(own(value, 'runId'));
    const invocation = own(value, 'invocationId');
    const invocationId = invocation === null ? null : this.name(invocation);
    const rawPath = own(value, 'invocationPath');
    const invocationPath = rawPath === undefined ? undefined : this.list(rawPath, 128, (item) => this.name(item));
    if (
      invocationPath !== undefined &&
      (invocationPath.reduce((size, item) => size + item.length, 0) > 8192 ||
        (invocationId === null ? invocationPath.length !== 0 : invocationPath.at(-1) !== invocationId))
    )
      throw refuse();
    return Object.freeze({
      sourceId,
      runId,
      invocationId,
      ...(invocationPath === undefined ? {} : { invocationPath }),
    });
  }
  position(value: unknown): TraceMetadataPosition {
    this.object(value, ['commitIndex', 'traceIndex']);
    return Object.freeze({
      commitIndex: integer(own(value, 'commitIndex')),
      traceIndex: integer(own(value, 'traceIndex')),
    });
  }
}
export function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw refuse();
  return value;
}
export function earlier(a: TraceMetadataPosition, b: TraceMetadataPosition): boolean {
  return a.commitIndex < b.commitIndex || (a.commitIndex === b.commitIndex && a.traceIndex < b.traceIndex);
}
export function checkPosition(position: TraceMetadataPosition, commits: readonly TraceMetadataCommit[]): void {
  if (
    position.commitIndex > commits.length ||
    (position.commitIndex === commits.length
      ? position.traceIndex !== 0
      : position.traceIndex > commits[position.commitIndex].trace.length)
  )
    throw refuse();
}
export interface PreparedMetadata extends TraceMetadataInput {
  readonly index: WriterIndex;
  readonly occurrenceCount: number;
  readonly pathSegmentCount: number;
  readonly maximumPathDepth: number;
}
const prepared = new WeakMap<TraceMetadata, PreparedMetadata>();

/** Validate the whole source atomically. No payload/verb/read/position is invented. */
export function readTraceMetadata(input: unknown): TraceMetadata {
  try {
    const a = new Admission();
    a.object(input, ['scope', 'commits', 'addressBasis', 'originalCommitIndices', 'readsAvailable', 'startKeys']);
    const scope = a.scope(own(input, 'scope'));
    const addressBasis = own(input, 'addressBasis');
    if (addressBasis !== 'source-local' && addressBasis !== 'projection-local') throw refuse();
    const readsAvailable = own(input, 'readsAvailable');
    if (readsAvailable !== undefined && typeof readsAvailable !== 'boolean') throw refuse();
    let occurrenceCount = 0;
    const commits = a.list(own(input, 'commits'), 10000, (raw): TraceMetadataCommit => {
      a.object(raw, ['stage', 'stageId', 'runtimeStageId', 'phase', 'trace']);
      const stage = a.name(own(raw, 'stage')),
        stageId = a.name(own(raw, 'stageId')),
        runtimeStageId = a.name(own(raw, 'runtimeStageId'));
      const phase = own(raw, 'phase');
      if (phase !== undefined && phase !== 'exit' && phase !== 'repeat') throw refuse();
      const trace = a.list(own(raw, 'trace'), 128, (entry): TraceMetadataEntry => {
        if (++occurrenceCount > 100000) throw refuse();
        a.object(entry, ['path', 'verb', 'reads']);
        const path = a.name(own(entry, 'path'), true),
          verb = own(entry, 'verb');
        if (verb !== undefined && verb !== 'set' && verb !== 'merge' && verb !== 'append' && verb !== 'delete')
          throw refuse();
        const rawReads = own(entry, 'reads');
        let reads: TraceMetadataEntry['reads'];
        if (rawReads !== undefined) {
          a.object(rawReads, ['keys', 'before', 'kind']);
          const keys = a.list(own(rawReads, 'keys'), 128, (key) => a.name(key, true));
          const before = a.position(own(rawReads, 'before')),
            kind = own(rawReads, 'kind');
          if (kind !== 'per-write' && kind !== 'stage') throw refuse();
          reads = Object.freeze({ keys, before, kind });
        }
        return Object.freeze({
          path,
          ...(verb === undefined ? {} : { verb }),
          ...(reads === undefined ? {} : { reads }),
        });
      });
      return Object.freeze({ stage, stageId, runtimeStageId, trace, ...(phase === undefined ? {} : { phase }) });
    });
    for (let commitIndex = 0; commitIndex < commits.length; commitIndex++) {
      for (let traceIndex = 0; traceIndex < commits[commitIndex].trace.length; traceIndex++) {
        const before = commits[commitIndex].trace[traceIndex].reads?.before;
        if (before) {
          checkPosition(before, commits);
          if (earlier({ commitIndex, traceIndex }, before)) throw refuse();
        }
      }
    }
    const rawMapping = own(input, 'originalCommitIndices');
    const originalCommitIndices =
      rawMapping === undefined ? undefined : a.list(rawMapping, 10000, (index) => integer(index));
    if (originalCommitIndices !== undefined) {
      if (originalCommitIndices.length !== commits.length) throw refuse();
      for (let i = 1; i < originalCommitIndices.length; i++)
        if (originalCommitIndices[i] <= originalCommitIndices[i - 1]) throw refuse();
    }
    const rawStart = own(input, 'startKeys');
    const startKeys = rawStart === undefined ? undefined : a.list(rawStart, 10000, (key) => a.name(key, true));
    const data: PreparedMetadata = Object.freeze({
      scope,
      addressBasis,
      commits,
      ...(readsAvailable === undefined ? {} : { readsAvailable }),
      ...(originalCommitIndices === undefined ? {} : { originalCommitIndices }),
      ...(startKeys === undefined ? {} : { startKeys }),
      index: buildWriterIndex(commits),
      occurrenceCount,
      pathSegmentCount: a.segments,
      maximumPathDepth: a.depth,
    });
    const handle = Object.freeze({ kind: 'trace-metadata' as const }) as TraceMetadata;
    prepared.set(handle, data);
    return handle;
  } catch (error) {
    if (error instanceof TraceMetadataError) throw error;
    throw refuse();
  }
}
export function metadataOf(handle: TraceMetadata): PreparedMetadata {
  const source = prepared.get(handle);
  if (!source) throw new TraceMetadataError('invalid-handle');
  return source;
}
export interface AdmittedQuery extends TraceMetadataQuery {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxWork: number;
}
export function queryOf(raw: unknown, source: PreparedMetadata): AdmittedQuery {
  try {
    const a = new Admission();
    a.object(raw, ['scope', 'key', 'before', 'maxDepth', 'maxNodes', 'maxEdges', 'maxWork']);
    const scope = a.scope(own(raw, 'scope'));
    if (JSON.stringify(scope) !== JSON.stringify(source.scope)) throw new TraceMetadataError('scope-mismatch');
    const key = a.name(own(raw, 'key'), true),
      before = a.position(own(raw, 'before'));
    checkPosition(before, source.commits);
    const limit = (name: string, defaultValue: number, min: number, max: number): number => {
      const value = own(raw, name);
      return value === undefined ? defaultValue : integer(value, min, max);
    };
    return Object.freeze({
      scope,
      key,
      before,
      maxDepth: limit('maxDepth', 20, 0, 1000),
      maxNodes: limit('maxNodes', 100, 1, 10000),
      maxEdges: limit('maxEdges', 1000, 1, 100000),
      maxWork: limit('maxWork', 100000, 1, 1000000),
    });
  } catch (error) {
    if (error instanceof TraceMetadataError) throw error;
    throw refuse();
  }
}
