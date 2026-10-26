import { buildRuntimeStageId, isExecutionKey, parseRuntimeStageId } from '../ids/runtimeStageId.js';
import { pathSegments } from '../memory/paths.js';
import type { LogAddress } from '../memory/eventPosition.js';

/** The codec owns parsing; a round trip refuses historical seeds and noncanonical execution suffixes. */
export function nativeExecution(runtimeStageId: string): ReturnType<typeof parseRuntimeStageId> | undefined {
  if (!isExecutionKey(runtimeStageId)) return undefined;
  const parsed = parseRuntimeStageId(runtimeStageId);
  if (!parsed.stageId || !Number.isSafeInteger(parsed.executionIndex) || parsed.executionIndex < 0) return undefined;
  return buildRuntimeStageId(parsed.stageId, parsed.executionIndex, parsed.subflowPath) === runtimeStageId
    ? parsed
    : undefined;
}

/** Length-prefixed encoded components preserve empty segments and literal delimiter-looking text. */
export function iriPart(value: string): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase(),
  );
  return encoded.length + ':' + encoded;
}

export class ProvIds {
  readonly prefix: string;
  constructor(base: string, address?: LogAddress) {
    const boundary = base.endsWith('/') || base.endsWith(':') ? '' : '/';
    this.prefix =
      base +
      boundary +
      (address ? 'scope/' + [address.logRunId, ...address.drillPath].map(iriPart).join('/') + '/' : 'scope/');
  }
  record(): string {
    return this.prefix + 'record';
  }
  activity(runtimeStageId: string): string {
    return this.prefix + 'activity/' + iriPart(runtimeStageId);
  }
  commit(commitIdx: number): string {
    return this.prefix + 'commit/' + commitIdx;
  }
  write(commitIdx: number, rowIdx: number, path?: string): string {
    return (
      this.prefix +
      (path === undefined ? 'hidden/' : 'write/') +
      commitIdx +
      '/' +
      rowIdx +
      (path === undefined ? '' : '/' + pathSegments(path).map(iriPart).join('/'))
    );
  }
  initial(path: string): string {
    return this.prefix + 'initial/' + pathSegments(path).map(iriPart).join('/');
  }
  read(runtimeStageId: string, ordinal: number): string {
    return this.prefix + 'read/' + iriPart(runtimeStageId) + '/' + ordinal;
  }
  candidate(commitIdx: number, rowIdx: number, ordinal: number): string {
    return this.prefix + 'candidate/' + commitIdx + '/' + rowIdx + '/' + ordinal;
  }
  control(runtimeStageId: string): string {
    return this.prefix + 'control/' + iriPart(runtimeStageId);
  }
  attention(runtimeStageId: string, ordinal: number): string {
    return this.prefix + 'attention/' + iriPart(runtimeStageId) + '/' + ordinal;
  }
}
