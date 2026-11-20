import type { LogAddress } from '../../memory/eventPosition.js';
import type { GraphContext } from '../types.js';
import type { RecordSourceLink, SourceLinkLocator, SourceLinkPolicy } from './types.js';

export type WriteLocator = Extract<SourceLinkLocator, { at: 'write' }>;
export type ViewLocator = Extract<SourceLinkLocator, { at: 'view' }>;

export function writeLocator(address: LogAddress, write: Omit<WriteLocator, 'address' | 'at'>): WriteLocator {
  return Object.freeze({ at: 'write', address, ...write });
}

/** Build all policy addresses from parsed selectors before touching the replay. */
export function locators(address: LogAddress, link: RecordSourceLink) {
  const { checkedIn: _, ...output } = link.output;
  const consumer = link.consumer.runtimeStageId;
  const view: ViewLocator | undefined =
    link.input === undefined ? undefined : Object.freeze({ at: 'view', address, consumer, ...link.input });
  return {
    output: writeLocator(address, output),
    others: [
      writeLocator(address, link.witness),
      ...(link.served === undefined ? [] : [writeLocator(address, { runtimeStageId: consumer, ...link.served })]),
      ...(view === undefined ? [] : [view]),
    ],
    view,
  };
}

export function allows(policy: SourceLinkPolicy, locator: SourceLinkLocator, context: GraphContext): boolean {
  if (context.signal.aborted) return false;
  try {
    return policy(locator, context) === true;
  } catch {
    return false;
  }
}
