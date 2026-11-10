/** The runnable examples say what they print. The package's own name resolves through the built doors, so this needs a build. */
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

let log: MockInstance<typeof console.log>;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => log.mockRestore());

it('examples/post-execution/time-travel/06-bring-your-own-record.ts prints what its comments say', async () => {
  await import('../../examples/post-execution/time-travel/06-bring-your-own-record');
  expect(log.mock.calls).toEqual([
    ['=== The fold at every stop (base + bundles up to it) ===\n'],
    ['  start           through #-1  {"count":0,"items":[],"profile":{"name":"a"}}  basis=initial+log'],
    ['  commit seed#0    through #0  {"count":1,"items":[],"profile":{"name":"a"}}  basis=initial+log'],
    ['  commit grow#1    through #1  {"count":1,"items":[10],"profile":{"name":"a"}}  basis=initial+log'],
    ['  commit enrich#2  through #2  {"count":1,"items":[10],"profile":{"name":"a","age":3}}  basis=initial+log'],
    ['  commit forget#3  through #3  {"items":[10],"profile":{"name":"a","age":3}}  basis=initial+log'],
    ['  end             through #3  {"items":[10],"profile":{"name":"a","age":3}}  basis=initial+log'],
    ['\n=== A tag axis, from the bundles alone — no execution tree ===\n'],
    ['  stops: start → commit@1 → commit@3 → end'],
    ['\n=== A bundle the reader cannot read is a GAP, with its reason — the rest still folds ===\n'],
    ['  skipped: [{"index":1,"reason":"trace[0].verb is \\"upsert\\", not set | merge | append | delete"}]'],
    ['  state:   {"items":[],"profile":{"name":"a","age":3}}'],
  ]);
});

it('examples/post-execution/time-travel/07-a-stored-record.ts prints what its comments say', async () => {
  await import('../../examples/post-execution/time-travel/07-a-stored-record');
  expect(log.mock.calls).toEqual([
    ['=== What the store says before any fold ===\n'],
    ['  complete: false   outcome: (none — it never closed)'],
    ['  opened with: {"chart":"checkout"}'],
    ['  note attempt: {"id":"charge#1@1","outcome":"timeout","durationMs":40000}'],
    ['  note attempt: {"id":"charge#1@2","outcome":"failed","durationMs":812}'],
    ['\n=== The fold over what landed ===\n'],
    ['  stops: start → price#0 → charge#1 → end'],
    ['  state: {"quote":42,"charged":false}'],
    ['\n=== A commit the store lost is a gap at its own index ===\n'],
    ['  gaps: [{"index":0,"reason":"no readable commit entry for this index"}]'],
    [
      '  fold: {"state":{"quote":null,"charged":false},"basis":"initial+log","redacted":false,"redactedPaths":[],' +
        '"throughCommitIdx":1,"skipped":[{"index":0,"reason":"no readable commit entry for this index"}]}',
    ],
  ]);
});

it('examples/post-execution/time-travel/08-evidence-requirements.ts prints what its comments say', async () => {
  await import('../../examples/post-execution/time-travel/08-evidence-requirements');
  expect(log.mock.calls).toEqual([['not-collected', ['claim:workload-attribution:1']]]);
});

it('examples/post-execution/prov/01-export-prov.ts prints what its comments say', async () => {
  await import('../../examples/post-execution/prov/01-export-prov');
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith('Export bytes:', expect.any(Number)));
  expect(log.mock.calls).toEqual([
    ['Activities:', 2],
    ['Commit metadata:', 3],
    ['Write occurrences:', 4],
    ['Candidate dependencies:', 1],
    ['Complete:', false],
    ['Gaps:', ['redacted', 'not-collected', 'not-collected', 'redacted', 'redacted', 'ambiguous']],
    ['Export bytes:', expect.any(Number)],
  ]);
});

it('examples/post-execution/metadata/01-trace-metadata.ts prints what its comments say', async () => {
  await import('../../examples/post-execution/metadata/01-trace-metadata');
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith('Complete:', false));
  expect(log.mock.calls).toEqual([
    ['Edges:', 1],
    ['State effect:', 'unknown'],
    ['Complete:', false],
  ]);
});

it('examples/cause-record.ts answers the same from the in-memory and the stored record', async () => {
  const { causeRecordExample } = await import('../../examples/cause-record');
  const { local, stored } = await causeRecordExample();
  const node = (runtimeStageId: string, commitIdx: number, key: string) =>
    `record:${JSON.stringify({ address: { logRunId: 'example-run', drillPath: [] }, runtimeStageId, commitIdx, key })}`;
  expect(local.rootCause).toBe(node('price#0', 0, 'price'));
  expect(local.path).toEqual([node('total#1', 1, 'total'), node('price#0', 0, 'price')]);
  expect(local.confidence).toBe('complete');
  expect(local.gaps).toEqual([]);
  expect(stored).toEqual(local);
  expect(log).not.toHaveBeenCalled();
});
