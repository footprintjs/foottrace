import type { LogAddress } from '../memory/eventPosition.js';
import type { GraphContext, NodeId } from './types.js';
import type {
  RecordIdentity,
  RecordLoadFailure,
  RecordNode,
  RecordScopeLoader,
  ResolvedRecordNode,
} from './recordTypes.js';
import { readKeysForStage } from './recordScope.js';
import { addressOf, name, own, RecordRefusal } from './recordValidation.js';

/** Parse only the bounded identity encoding; payload fields never become graph addresses. */
export function readNodeIdentity(nodeId: string): RecordIdentity {
  if (typeof nodeId !== 'string' || nodeId.length > 2048 || !nodeId.startsWith('record:')) throw new RecordRefusal();
  let fields: unknown;
  try {
    fields = JSON.parse(nodeId.slice(7));
  } catch {
    throw new RecordRefusal();
  }
  const address = addressOf(own(fields, 'address')),
    runtimeStageId = name(own(fields, 'runtimeStageId')),
    commitIndex = own(fields, 'commitIdx'),
    key = own(fields, 'key'),
    read = own(fields, 'read');
  if (commitIndex !== undefined && (!Number.isSafeInteger(commitIndex) || (commitIndex as number) < 0))
    throw new RecordRefusal();
  if ((read !== undefined && read !== true) || (read === true && key === undefined)) throw new RecordRefusal();
  return {
    address,
    runtimeStageId,
    ...(commitIndex === undefined ? {} : { commitIdx: commitIndex as number }),
    ...(key === undefined ? {} : { key: name(key, true) }),
    ...(read === true ? { read: true as const } : {}),
  };
}

/** Stable field order preserves existing address/execution/key IDs across storage and memory readers. */
export function nodeIdFor(addressInput: LogAddress, node: RecordNode, read?: true): NodeId {
  try {
    const address = addressOf(addressInput),
      runtimeStageId = name(own(node, 'runtimeStageId')),
      commitIndex = own(node, 'commitIdx'),
      key = own(node, 'key');
    if (commitIndex !== undefined && (!Number.isSafeInteger(commitIndex) || (commitIndex as number) < 0))
      throw new RecordRefusal();
    const nodeId =
      'record:' +
      JSON.stringify({
        address,
        runtimeStageId,
        ...(commitIndex === undefined ? {} : { commitIdx: commitIndex }),
        ...(key === undefined ? {} : { key: name(key, true) }),
        ...(read ? { read: true } : {}),
      });
    return nodeId.length <= 2048 ? nodeId : 'record:invalid';
  } catch {
    return 'record:invalid';
  }
}

/** An admitted ID must also match captured evidence before it can introduce a dependency. */
export async function resolveRecordNode(
  nodeId: NodeId,
  context: GraphContext,
  loader: RecordScopeLoader,
): Promise<ResolvedRecordNode | RecordLoadFailure> {
  try {
    const identity = readNodeIdentity(nodeId),
      scope = await loader.loadScope(identity.address, context);
    if ('failure' in scope) return scope;
    const commitIndex =
      identity.commitIdx ?? scope.log.findIndex((bundle) => bundle.runtimeStageId === identity.runtimeStageId);
    if (
      commitIndex < 0 ||
      commitIndex >= scope.log.length ||
      scope.log[commitIndex].runtimeStageId !== identity.runtimeStageId
    )
      throw new RecordRefusal();
    // A qualified read is a captured fact, never a caller-supplied request to invent a dependency.
    if (
      identity.read &&
      (identity.key === undefined || !readKeysForStage(scope, identity.runtimeStageId).includes(identity.key))
    )
      throw new RecordRefusal();
    return { scope, identity, commitIndex };
  } catch (error) {
    return { failure: error instanceof RecordRefusal ? error.code : 'invalid-data' };
  }
}
