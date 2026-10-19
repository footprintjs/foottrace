import { ProvBudget } from './budget.js';
import { PROV_CONTEXT } from './context.js';
import { utf8Bytes } from './encoding.js';
import type { ProvExport, ProvNode, ProvValue } from './types.js';

const envelopeBytes = utf8Bytes(
  JSON.stringify({
    document: { '@context': PROV_CONTEXT, '@graph': [] },
    gaps: [],
    complete: false,
  }),
);

function linksIn(node: ProvNode): number {
  let links = 0;
  const queue: ProvValue[] = Object.values(node);
  while (queue.length) {
    const value = queue.pop();
    if (Array.isArray(value)) {
      for (const child of value) queue.push(child);
    } else if (value && typeof value === 'object') {
      if (Object.hasOwn(value, '@id')) links++;
      else queue.push(...Object.values(value));
    }
  }
  return links;
}

/** Nodes are already owned data. No raw input, getter or toJSON can reach serialization. */
export class ProvOutput {
  private readonly graph: ProvNode[] = [];
  private bytes = 0;
  private stopped = false;
  constructor(readonly budget: ProvBudget) {}
  get full(): boolean {
    return this.stopped;
  }
  add(node: ProvNode): boolean {
    if (this.stopped) return false;
    const bytes = utf8Bytes(JSON.stringify(node)) + 1;
    if (
      !this.budget.spend('work', bytes) ||
      !this.budget.spend('nodes') ||
      !this.budget.spend('relations', linksIn(node)) ||
      envelopeBytes + this.bytes + bytes + this.budget.gapBytes > this.budget.limits.maxOutputBytes
    ) {
      this.budget.outputLimitReached();
      this.stopped = true;
      return false;
    }
    this.bytes += bytes;
    this.graph.push(node);
    return true;
  }
  finish(): ProvExport {
    const result: ProvExport = {
      document: { '@context': PROV_CONTEXT, '@graph': this.graph },
      gaps: [...this.budget.gaps],
      complete: false,
    };
    if (utf8Bytes(JSON.stringify(result)) <= this.budget.limits.maxOutputBytes) return result;
    // Invariant guard only: reserved gap/count/marker bytes plus the envelope prevent this on admitted input.
    return {
      document: { '@context': PROV_CONTEXT, '@graph': [] },
      gaps: [{ code: 'truncated', reason: 'export envelope limit reached' }, { code: 'not-collected' }],
      complete: false,
    };
  }
}
