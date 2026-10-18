import type { ExplainOptions, Gap, NodeId, WalkLimits } from './types.js';
import { gap, graphName, graphOwn, plain } from './validation.js';

type Direction = 'backward' | 'impact';
type DirectionLimits = Omit<Required<WalkLimits>, 'timeoutMs'>;
interface Allowance {
  readonly limits: DirectionLimits;
  readonly nodes: Set<NodeId>;
  edges: number;
  calls: number;
}
const defaults = { maxNodes: 100, maxDepth: 20, maxEdges: 1000, maxCalls: 1000, timeoutMs: 1000 };
const ceilings = { maxNodes: 10000, maxDepth: 1000, maxEdges: 100000, maxCalls: 100000, timeoutMs: 30000 };
const directionKeys = ['maxNodes', 'maxDepth', 'maxEdges', 'maxCalls'] as const;

function limit(value: unknown, key: keyof WalkLimits, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < (key === 'maxDepth' ? 0 : 1) ||
    value > maximum
  )
    throw new TypeError();
  return value;
}

/** Validate both directions before dispatch; nested objects accept only own data fields. */
function allowance(raw: unknown, outer: Required<WalkLimits>): Allowance | undefined {
  if (raw === undefined) return undefined;
  plain(raw);
  const keys = Reflect.ownKeys(raw as object);
  if (keys.some((key) => typeof key !== 'string' || !directionKeys.includes(key as keyof DirectionLimits)))
    throw new TypeError();
  const limits = {
    maxNodes: outer.maxNodes,
    maxDepth: outer.maxDepth,
    maxEdges: outer.maxEdges,
    maxCalls: outer.maxCalls,
  };
  for (const key of directionKeys) {
    const value = graphOwn(raw, key);
    if (value !== undefined) limits[key] = limit(value, key, outer[key]);
  }
  return { limits: Object.freeze(limits), nodes: new Set(), edges: 0, calls: 0 };
}

/** One hard work ceiling per query; optional direction allowances can only restrict it. */
export class QueryBudget {
  readonly limits: Required<WalkLimits>;
  private readonly nodes = new Set<NodeId>();
  private edges = 0;
  private calls = 0;
  private readonly directions: Record<Direction, Allowance | undefined>;
  private current?: Allowance;

  constructor(options: ExplainOptions) {
    try {
      plain(options);
      const limits = { ...defaults };
      for (const key of Object.keys(defaults) as (keyof WalkLimits)[]) {
        const value = graphOwn(options, key);
        if (value !== undefined) limits[key] = limit(value, key, ceilings[key]);
      }
      this.limits = Object.freeze(limits);
      this.directions = {
        backward: allowance(graphOwn(options, 'backward'), this.limits),
        impact: allowance(graphOwn(options, 'impact'), this.limits),
      };
    } catch {
      throw new TypeError('CAUSE_CONFIGURATION_INVALID');
    }
  }

  enterDirection(direction: Direction): void {
    // Re-entering never replenishes work, and the query signal/memo remain Session-owned.
    this.current = this.directions[direction];
  }

  get maxDepth(): number {
    return this.current?.limits.maxDepth ?? this.limits.maxDepth;
  }

  admit(id: NodeId): Gap | undefined {
    graphName(id);
    const local = this.current;
    if (local && !local.nodes.has(id) && local.nodes.size >= local.limits.maxNodes) return gap('node-limit', id);
    if (!this.nodes.has(id) && this.nodes.size >= this.limits.maxNodes) return gap('node-limit', id);
    // Neither counter changes until both checks accept; cached identities still cost a local slot.
    this.nodes.add(id);
    local?.nodes.add(id);
    return undefined;
  }

  takeEdge(id: NodeId): Gap | undefined {
    const local = this.current;
    if (local && local.edges >= local.limits.maxEdges) return gap('edge-limit', id);
    if (this.edges >= this.limits.maxEdges) return gap('edge-limit', id);
    this.edges++;
    if (local) local.edges++;
    return undefined;
  }

  takeCall(id?: NodeId): Gap | undefined {
    const local = this.current;
    if (local && local.calls >= local.limits.maxCalls) return gap('call-limit', id);
    if (this.calls >= this.limits.maxCalls) return gap('call-limit', id);
    this.calls++;
    if (local) local.calls++;
    return undefined;
  }
}
