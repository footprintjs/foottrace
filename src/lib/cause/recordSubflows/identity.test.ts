import { describe, expect, it } from 'vitest';
import { isNativeChild, nativeParentOf } from './identity.js';

const root = { logRunId: 'run-a', drillPath: [] as string[] };
describe('native subflow identity authority', () => {
  it('removes exactly one actual execution segment and never splits a nested display path', () => {
    const child = { logRunId: 'run-a', drillPath: ['outer#1', 'outer/inner#8'] };
    const containing = nativeParentOf(child)!;
    expect(containing).toEqual({
      address: { logRunId: 'run-a', drillPath: ['outer#1'] },
      runtimeStageId: 'outer/inner#8',
    });
    expect(isNativeChild(containing.address, child, 'outer/inner#8')).toBe(true);
    expect(Object.isFrozen(containing.address.drillPath)).toBe(true);
    child.drillPath[0] = 'changed#2';
    expect(containing.address.drillPath).toEqual(['outer#1']);
  });
  it('does not invent a containing execution for a root log', () => {
    expect(nativeParentOf(root)).toBeUndefined();
  });
  it.each(['mount', 'mount#01', 'mount#-1', 'mount#1junk', 'mount#9007199254740992'])(
    'refuses the nonnative execution %s',
    (id) => {
      const child = { logRunId: 'run-a', drillPath: [id] };
      expect(nativeParentOf(child)).toBeUndefined();
      expect(isNativeChild(root, child, id)).toBe(false);
    },
  );
  it('binds the whole run, visit and parent address', () => {
    const child = { logRunId: 'run-a', drillPath: ['mount#1'] };
    expect(isNativeChild(root, child, 'mount#1')).toBe(true);
    expect(isNativeChild({ ...root, logRunId: 'run-b' }, child, 'mount#1')).toBe(false);
    expect(isNativeChild(root, child, 'mount#2')).toBe(false);
    expect(isNativeChild({ ...root, drillPath: ['ancestor#0'] }, child, 'mount#1')).toBe(false);
  });
  it('contains descriptor refusal without invoking an address getter', () => {
    let calls = 0;
    const address = {
      get logRunId(): string {
        calls++;
        throw Error('private');
      },
      drillPath: ['mount#1'],
    };
    expect(nativeParentOf(address)).toBeUndefined();
    expect(isNativeChild(root, address, 'mount#1')).toBe(false);
    expect(calls).toBe(0);
  });
});
