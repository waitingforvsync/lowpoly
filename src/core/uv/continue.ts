import { dot, length, newellNormal, normalize, planeBasis, scale, sub, type ReadonlyVec2, type ReadonlyVec3, type Vec2 } from '../math/vec';
import { planarAxes, planarUV } from './project';

/**
 * UVs for geometry created by modelling ops (texture lock). New faces either continue the
 * mapping of the face they grew from, or fall back to a world-space planar projection.
 */

const EPS = 1e-9;

/** World-space planar projection for a polygon (1 UV unit = 1 length unit). */
export function projectUVs(points: readonly ReadonlyVec3[]): Vec2[] {
  const n = newellNormal(points);
  const axes = planarAxes(length(n) < EPS ? [0, 0, 1] : n);
  return points.map((p) => planarUV(p, axes));
}

/**
 * The affine map from a planar face's surface to its UVs, fitted to its corners. Evaluating it
 * at a new point in the face's plane continues the face's texture exactly. Returns null when the
 * corners' UVs are degenerate (e.g. all equal), so there's no mapping to continue.
 */
export function faceUVMap(
  points: readonly ReadonlyVec3[],
  uvs: readonly ReadonlyVec2[],
): ((p: ReadonlyVec3) => Vec2) | null {
  const n = newellNormal(points);
  if (length(n) < EPS || points.length < 3) return null;
  const { u, v } = planeBasis(normalize(n));
  // Least-squares fit uv = A·(x, y) + c, with (x, y) the point in the plane basis.
  const xs = points.map((p) => [dot(p, u), dot(p, v)] as const);
  const mx = xs.reduce((s, q) => s + q[0], 0) / xs.length;
  const my = xs.reduce((s, q) => s + q[1], 0) / xs.length;
  const mu = uvs.reduce((s, q) => s + q[0], 0) / uvs.length;
  const mv = uvs.reduce((s, q) => s + q[1], 0) / uvs.length;
  let sxx = 0, sxy = 0, syy = 0, sxu = 0, syu = 0, sxv = 0, syv = 0;
  xs.forEach((q, i) => {
    const x = q[0] - mx;
    const y = q[1] - my;
    const du = uvs[i]![0] - mu;
    const dv = uvs[i]![1] - mv;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sxu += x * du;
    syu += y * du;
    sxv += x * dv;
    syv += y * dv;
  });
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < EPS) return null;
  const a = (syy * sxu - sxy * syu) / det;
  const b = (sxx * syu - sxy * sxu) / det;
  const c = (syy * sxv - sxy * syv) / det;
  const d = (sxx * syv - sxy * sxv) / det;
  // A UV-degenerate face (every corner at the same UV) has no mapping worth continuing.
  if (Math.abs(a * d - b * c) < EPS) return null;
  return (p) => {
    const x = dot(p, u) - mx;
    const y = dot(p, v) - my;
    return [round(mu + a * x + b * y), round(mv + c * x + d * y)];
  };
}

/**
 * UVs for new points in a face's plane: continue its texture (`faceUVMap`), or, when its UVs are
 * degenerate, fall back to a world-space planar projection.
 */
export function faceUVFunction(
  points: readonly ReadonlyVec3[],
  uvs: readonly ReadonlyVec2[],
): (p: ReadonlyVec3) => Vec2 {
  const map = faceUVMap(points, uvs);
  if (map) return map;
  const n = newellNormal(points);
  const axes = planarAxes(length(n) < EPS ? [0, 0, 1] : n);
  return (p) => planarUV(p, axes);
}

/**
 * UVs for a side wall [a, b, b + offset, a + offset] grown from the edge a→b. The UVs at a and b
 * are kept, so the wall's texture joins the face it shares that edge with; the offset direction
 * maps to UV space at the same texel density, turned 90° so the wall's texture isn't mirrored.
 * Returns the UVs of the two new corners [b', a'], or null when the edge's UVs are degenerate.
 */
export function wallUVs(
  a: ReadonlyVec3,
  b: ReadonlyVec3,
  uvA: ReadonlyVec2,
  uvB: ReadonlyVec2,
  offset: ReadonlyVec3,
): [Vec2, Vec2] | null {
  const e = sub(b, a);
  const len = length(e);
  const duv: Vec2 = [uvB[0] - uvA[0], uvB[1] - uvA[1]];
  const luv = Math.hypot(duv[0], duv[1]);
  if (len < EPS || luv < EPS) return null;
  const k = luv / len;
  const ehat = scale(e, 1 / len);
  const along = dot(offset, ehat);
  const across = length(sub(offset, scale(ehat, along)));
  const uhat: Vec2 = [duv[0] / luv, duv[1] / luv];
  const perp: Vec2 = [-uhat[1], uhat[0]];
  const t: Vec2 = [k * (along * uhat[0] + across * perp[0]), k * (along * uhat[1] + across * perp[1])];
  return [
    [round(uvB[0] + t[0]), round(uvB[1] + t[1])],
    [round(uvA[0] + t[0]), round(uvA[1] + t[1])],
  ];
}

function round(x: number): number {
  return Math.round(x * 1e9) / 1e9 + 0;
}
