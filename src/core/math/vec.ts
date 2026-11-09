/** Minimal tuple-based vector maths for the core (no Three.js dependency). */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type ReadonlyVec2 = readonly [number, number];
export type ReadonlyVec3 = readonly [number, number, number];

export const add = (a: ReadonlyVec3, b: ReadonlyVec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: ReadonlyVec3, b: ReadonlyVec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: ReadonlyVec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: ReadonlyVec3, b: ReadonlyVec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: ReadonlyVec3, b: ReadonlyVec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: ReadonlyVec3): number => Math.hypot(a[0], a[1], a[2]);

export function normalize(a: ReadonlyVec3): Vec3 {
  const len = length(a);
  return len > 0 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0];
}

export const lerp3 = (a: ReadonlyVec3, b: ReadonlyVec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export const lerp2 = (a: ReadonlyVec2, b: ReadonlyVec2, t: number): Vec2 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/**
 * Newell's method: the area-weighted normal of a (possibly non-planar) polygon, with length equal to
 * twice its area. CCW winding (right-hand rule) gives a normal pointing toward the viewer.
 */
export function newellNormal(points: readonly ReadonlyVec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

/** An orthonormal basis (u, v) spanning the plane with the given unit normal, such that u × v = n. */
export function planeBasis(n: ReadonlyVec3): { u: Vec3; v: Vec3 } {
  // Pick the world axis least aligned with n to build u from.
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  const helper: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const u = normalize(cross(helper, n));
  const v = cross(n, u);
  return { u, v };
}

/** Signed area of a 2D polygon (positive when counter-clockwise). */
export function signedArea2D(points: readonly ReadonlyVec2[]): number {
  let a = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % n]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Even-odd point-in-polygon test in 2D. */
export function pointInPolygon2D(p: ReadonlyVec2, poly: readonly ReadonlyVec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}
