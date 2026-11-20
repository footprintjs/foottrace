import { legacyChannels } from '../../evidence/recordCapture/legacy.js';
import type { LogAddress } from '../../memory/eventPosition.js';
import { field, sameAddress, snapshotAddress, type Budget } from './read.js';

function bound(raw: unknown, address: LogAddress, length: number, budget: Budget): boolean {
  const rawAddress = field(raw, 'logAddress');
  const commits = field(raw, 'commits');
  return (
    field(raw, 'runId') === address.logRunId &&
    rawAddress !== undefined &&
    sameAddress(snapshotAddress(rawAddress, budget), address) &&
    field(commits, 'from') === 0 &&
    field(commits, 'to') === length
  );
}

export function rootCapture(raw: unknown, address: LogAddress, length: number, budget: Budget) {
  if (address.drillPath.length !== 0) return undefined;
  const note = field(raw, 'capture');
  const version = field(note, 'version');
  if (
    (version !== 1 && version !== 2) ||
    field(note, 'scope') !== 'root-log' ||
    field(raw, 'runId') !== address.logRunId ||
    field(note, 'persistence') !== 'memory-only' ||
    !bound(note, address, length, budget)
  )
    return undefined;
  const channels = legacyChannels(note, version);
  return channels && { channels, completed: field(field(note, 'boundary'), 'status') === 'completed' };
}

export function rootSources(raw: unknown, address: LogAddress, length: number, budget: Budget) {
  if (address.drillPath.length !== 0) return undefined;
  const sources = field(raw, 'readSources');
  const owner = field(sources, 'ownership'),
    record = field(sources, 'record');
  const executions = field(owner, 'executions'),
    status = field(sources, 'status');
  if (
    field(sources, 'version') !== 2 ||
    field(owner, 'version') !== 1 ||
    field(sources, 'persistence') !== 'memory-only' ||
    (status !== 'captured' && status !== 'partial') ||
    field(sources, 'runId') !== address.logRunId ||
    !bound(owner, address, length, budget) ||
    field(field(sources, 'commits'), 'from') !== 0 ||
    field(field(sources, 'commits'), 'to') !== length ||
    field(owner, 'status') !== 'captured' ||
    field(owner, 'segment') !== 1 ||
    field(record, 'segment') !== 1 ||
    !Array.isArray(executions) ||
    !sameAddress(snapshotAddress(field(record, 'address'), budget), address)
  )
    return undefined;
  return { record, executions };
}
