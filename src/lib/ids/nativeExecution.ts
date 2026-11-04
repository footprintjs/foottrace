import { buildRuntimeStageId, isExecutionKey, parseRuntimeStageId } from './runtimeStageId.js';

/** The codec owns parsing; a round trip refuses historical seeds and noncanonical execution suffixes. */
export function nativeExecution(runtimeStageId: string): ReturnType<typeof parseRuntimeStageId> | undefined {
  if (!isExecutionKey(runtimeStageId)) return undefined;
  const parsed = parseRuntimeStageId(runtimeStageId);
  if (!parsed.stageId || !Number.isSafeInteger(parsed.executionIndex) || parsed.executionIndex < 0) return undefined;
  return buildRuntimeStageId(parsed.stageId, parsed.executionIndex, parsed.subflowPath) === runtimeStageId
    ? parsed
    : undefined;
}
