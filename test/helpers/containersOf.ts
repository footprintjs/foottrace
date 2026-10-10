/** Every container reachable from `v` (own enumerable keys, Map/Set members). */
export function containersOf(v: unknown, into = new Set<object>()): Set<object> {
  const stack = [v];
  while (stack.length > 0) {
    const x = stack.pop();
    if (x === null || typeof x !== 'object' || into.has(x)) continue;
    into.add(x);
    if (x instanceof Map) for (const [a, b] of x) stack.push(a, b);
    else if (x instanceof Set) for (const a of x) stack.push(a);
    else for (const key of Object.keys(x)) stack.push((x as Record<string, unknown>)[key]);
  }
  return into;
}
