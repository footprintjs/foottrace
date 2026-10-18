import type { ExplainOptions, Gap, NodeId, WalkLimits } from './types.js';
import { gap, graphName, graphOwn, plain } from './validation.js';

type Direction = 'backward' | 'impact';
type DirectionLimits = Omit<Required<WalkLimits>, 'timeoutMs'>;
/** A frozen handle to one allowance; its functions retain their accounting owner when extracted. */
export interface BudgetView {
  readonly maxDepth: number;
  readonly admit: (id: NodeId) => Gap | undefined;
  readonly takeEdge: (id: NodeId) => Gap | undefined;
  readonly takeCall: (id?: NodeId) => Gap | undefined;
}
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
  readonly total: BudgetView;
  private readonly nodes = new Set<NodeId>();
  private edges = 0;
  private calls = 0;
  private readonly directions: Record<Direction, BudgetView>;

  constructor(options: ExplainOptions) {
    try {
      plain(options);
      const limits = { ...defaults };
      for (const key of Object.keys(defaults) as (keyof WalkLimits)[]) {
        const value = graphOwn(options, key);
        if (value !== undefined) limits[key] = limit(value, key, ceilings[key]);
      }
      this.limits = Object.freeze(limits);
      const backward = allowance(graphOwn(options, 'backward'), this.limits),
        impact = allowance(graphOwn(options, 'impact'), this.limits);
      this.total = this.view();
      this.directions = {
        backward: this.view(backward),
        impact: this.view(impact),
      };
    } catch {
      throw new TypeError('CAUSE_CONFIGURATION_INVALID');
    }
  }

  direction(direction: Direction): BudgetView {
    // Reusing a view never replenishes work or changes another view's accounting owner.
    return this.directions[direction];
  }

  private view(local?: Allowance): BudgetView {
    return Object.freeze({
      maxDepth: local?.limits.maxDepth ?? this.limits.maxDepth,
      admit: (id: NodeId) => this.admit(local, id),
      takeEdge: (id: NodeId) => this.takeEdge(local, id),
      takeCall: (id?: NodeId) => this.takeCall(local, id),
    });
  }

  private admit(local: Allowance | undefined, id: NodeId): Gap | undefined {
    graphName(id);
    if (local && !local.nodes.has(id) && local.nodes.size >= local.limits.maxNodes) return gap('node-limit', id);
    if (!this.nodes.has(id) && this.nodes.size >= this.limits.maxNodes) return gap('node-limit', id);
    // Neither counter changes until both checks accept; cached identities still cost a local slot.
    this.nodes.add(id);
    local?.nodes.add(id);
    return undefined;
  }

  private takeEdge(local: Allowance | undefined, id: NodeId): Gap | undefined {
    if (local && local.edges >= local.limits.maxEdges) return gap('edge-limit', id);
    if (this.edges >= this.limits.maxEdges) return gap('edge-limit', id);
    this.edges++;
    if (local) local.edges++;
    return undefined;
  }

  private takeCall(local: Allowance | undefined, id?: NodeId): Gap | undefined {
    if (local && local.calls >= local.limits.maxCalls) return gap('call-limit', id);
    if (this.calls >= this.limits.maxCalls) return gap('call-limit', id);
    this.calls++;
    if (local) local.calls++;
    return undefined;
  }
}
