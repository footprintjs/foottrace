import { ProvBudget } from './budget.js';
import { PROV_CONTEXT } from './context.js';
import type { ProvExport, ProvNode, ProvValue } from './types.js';

/** UTF-8 size for owned, well-formed strings, including JSON escaping already applied by stringify. */
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? (index++, 4) : 3;
  }
  return bytes;
}

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
      this.bytes + bytes > this.budget.limits.maxOutputBytes - 1024
    ) {
      this.budget.addGap({ code: 'truncated', reason: 'export output limit reached' });
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
    // Never return an oversized refusal or silently cut its explanation. A fixed envelope always fits 2048 bytes.
    return {
      document: { '@context': PROV_CONTEXT, '@graph': [] },
      gaps: [{ code: 'truncated', reason: 'export envelope limit reached' }, { code: 'not-collected' }],
      complete: false,
    };
  }
}
