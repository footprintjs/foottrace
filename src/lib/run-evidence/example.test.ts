/** The runnable example says what it prints. The package's own name resolves through the built doors, so this needs a build. */
import { expect, it, vi } from 'vitest';

it('examples/post-execution/time-travel/09-run-evidence.ts prints what its comments say', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await import('../../../examples/post-execution/time-travel/09-run-evidence');
  expect(log.mock.calls).toEqual([
    [{ status: 'collected', decider: 'route#1', label: 'Middle band', gaps: [] }],
    ['collected', 'Enough evidence'],
    [{ status: 'not-collected', rows: [], why: 'no-log' }],
  ]);
  log.mockRestore();
});
