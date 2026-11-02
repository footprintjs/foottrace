/** Shared wire contract; identity grammar and work/string budgets remain with each reader. */
export const READ_ATTEMPT_LIMIT = 32;

/** An own encoded zero is normalized away; positive means a capped, incomplete window. */
export function readAttemptWindow(
  row: unknown,
  attempts: unknown,
  readOwn: (value: unknown, key: string) => unknown,
  refuse: () => Error,
): { readonly omitted?: number; readonly expectedLength?: number } {
  const count = readOwn(row, 'readAttemptsOmitted');
  if (count === undefined) {
    // Missing is legacy; present undefined and inherited fields are malformed, not missing.
    try {
      if ('readAttemptsOmitted' in (row as object)) throw refuse();
    } catch {
      throw refuse();
    }
    return {};
  }
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw refuse();
  if (count === 0) return {};
  let array: boolean;
  try {
    array = Array.isArray(attempts);
  } catch {
    throw refuse();
  }
  if (!array) throw refuse();
  const length = readOwn(attempts, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1 || length > READ_ATTEMPT_LIMIT)
    throw refuse();
  // The bounded copy must read the same admitted length, not a later untrusted value.
  return { omitted: count, expectedLength: length };
}
