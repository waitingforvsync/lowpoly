import { describe, expect, it } from 'vitest';
import { cross, dot, length, newellNormal, normalize, planeBasis, pointInPolygon2D, signedArea2D, type Vec3 } from './vec';

describe('newellNormal', () => {
  it('points along +Z for a CCW square seen from above, with length 2 × area', () => {
    const n = newellNormal([
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ]);
    expect(n).toEqual([0, 0, 8]);
  });

  it('flips with winding', () => {
    const n = newellNormal([
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
    ]);
    expect(n[2]).toBeLessThan(0);
  });
});

describe('planeBasis', () => {
  const normals: Vec3[] = [
    [0, 0, 1],
    [0, 0, -1],
    [1, 0, 0],
    [0, 1, 0],
    normalize([1, 2, 3]),
    normalize([-0.3, 0.1, -0.9]),
  ];
  it.each(normals)('is orthonormal and right-handed for %j', (...n) => {
    const { u, v } = planeBasis(n as Vec3);
    expect(length(u)).toBeCloseTo(1);
    expect(length(v)).toBeCloseTo(1);
    expect(dot(u, v)).toBeCloseTo(0);
    expect(dot(u, n as Vec3)).toBeCloseTo(0);
    const w = cross(u, v);
    expect(w[0]).toBeCloseTo(n[0]!);
    expect(w[1]).toBeCloseTo(n[1]!);
    expect(w[2]).toBeCloseTo(n[2]!);
  });
});

describe('2D helpers', () => {
  const square: [number, number][] = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];
  it('computes signed area', () => {
    expect(signedArea2D(square)).toBe(4);
    expect(signedArea2D([...square].reverse())).toBe(-4);
  });
  it('tests point containment', () => {
    expect(pointInPolygon2D([1, 1], square)).toBe(true);
    expect(pointInPolygon2D([3, 1], square)).toBe(false);
  });
});
