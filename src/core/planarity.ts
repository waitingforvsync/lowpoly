import { dot, newellNormal, normalize, type ReadonlyVec3, sub, type Vec3 } from './math/vec';
import type { Face } from './halfedge/mesh';

/**
 * Faces are strictly planar. A polygon counts as planar when every vertex lies within a small
 * tolerance of its best-fit plane (Newell normal through the centroid). The tolerance scales with
 * the polygon's size, so it is meaningful for both small details and large faces.
 */

const RELATIVE_TOLERANCE = 1e-5;

export function planeOf(points: readonly ReadonlyVec3[]): { normal: Vec3; origin: Vec3 } {
  const origin: Vec3 = [0, 0, 0];
  for (const p of points) {
    origin[0] += p[0] / points.length;
    origin[1] += p[1] / points.length;
    origin[2] += p[2] / points.length;
  }
  return { normal: normalize(newellNormal(points)), origin };
}

/** Largest distance of any point from the polygon's best-fit plane. */
export function planarDeviation(points: readonly ReadonlyVec3[]): number {
  if (points.length <= 3) return 0;
  const { normal, origin } = planeOf(points);
  if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) return 0; // degenerate: no plane to leave
  let max = 0;
  for (const p of points) max = Math.max(max, Math.abs(dot(sub(p, origin), normal)));
  return max;
}

export function planarTolerance(points: readonly ReadonlyVec3[]): number {
  let lo: Vec3 = [Infinity, Infinity, Infinity];
  let hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
  }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return RELATIVE_TOLERANCE * Math.max(1, diag);
}

export function isPlanar(points: readonly ReadonlyVec3[]): boolean {
  return planarDeviation(points) <= planarTolerance(points);
}

/** All loops of the face (outer and holes) lie in one plane. */
export function isFacePlanar(face: Face): boolean {
  return isPlanar(face.loops.flatMap((l) => l.positions()));
}
