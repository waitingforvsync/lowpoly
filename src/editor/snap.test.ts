import { describe, expect, it } from 'vitest';
import { isSnapActive, snapScalar, snapVec3 } from './snap';

describe('snapScalar', () => {
  it('rounds to the nearest step', () => {
    expect(snapScalar(0.12, 0.25)).toBe(0);
    expect(snapScalar(0.13, 0.25)).toBe(0.25);
    expect(snapScalar(1.74, 0.5)).toBe(1.5);
  });

  it('removes floating point noise', () => {
    expect(snapScalar(0.31, 0.1)).toBe(0.3);
  });

  it('never returns negative zero', () => {
    expect(Object.is(snapScalar(-0.01, 1), 0)).toBe(true);
  });

  it('passes values through for a non-positive step', () => {
    expect(snapScalar(1.234, 0)).toBe(1.234);
  });
});

describe('snapVec3', () => {
  it('snaps each component', () => {
    expect(snapVec3([0.26, -0.74, 2.01], 0.5)).toEqual([0.5, -0.5, 2]);
  });
});

describe('isSnapActive', () => {
  it('inverts while the modifier is held', () => {
    expect(isSnapActive(true, false)).toBe(true);
    expect(isSnapActive(true, true)).toBe(false);
    expect(isSnapActive(false, true)).toBe(true);
  });
});
