import { nativeExecution } from '../../ids/nativeExecution.js';
import type { LogAddress } from '../../memory/eventPosition.js';
import { addressOf } from '../recordValidation.js';

/** Use the canonical native execution/address authorities; never split display paths or stage names. */
function nativeAddress(value: LogAddress): LogAddress | undefined {
  try {
    const address = addressOf(value);
    return address.drillPath.every((id) => nativeExecution(id) !== undefined) ? address : undefined;
  } catch {
    return undefined;
  }
}

export function nativeParentOf(address: LogAddress): { address: LogAddress; runtimeStageId: string } | undefined {
  const child = nativeAddress(address);
  if (!child?.drillPath.length) return undefined;
  const runtimeStageId = child.drillPath[child.drillPath.length - 1];
  return Object.freeze({
    address: Object.freeze({ logRunId: child.logRunId, drillPath: Object.freeze(child.drillPath.slice(0, -1)) }),
    runtimeStageId,
  });
}

export function isNativeChild(parent: LogAddress, child: LogAddress, runtimeStageId: string): boolean {
  try {
    const above = nativeAddress(parent),
      below = nativeParentOf(child);
    return (
      above !== undefined &&
      below !== undefined &&
      nativeExecution(runtimeStageId) !== undefined &&
      below.runtimeStageId === runtimeStageId &&
      above.logRunId === below.address.logRunId &&
      above.drillPath.length === below.address.drillPath.length &&
      above.drillPath.every((id, index) => id === below.address.drillPath[index])
    );
  } catch {
    return false;
  }
}
