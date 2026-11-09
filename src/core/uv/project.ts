import { cross, dot, normalize, type ReadonlyVec3, type Vec2, type Vec3 } from '../math/vec';

const Z: Vec3 = [0, 0, 1];
const Y: Vec3 = [0, 1, 0];

/**
 * UV axes for planar projection onto a face with the given normal, in world units (1 UV unit = 1
 * length unit). Vertical-ish faces use +Z as "up" so textures stand upright. Horizontal faces use
 * +Y. Textures read correctly (not mirrored) when the face is viewed from the front.
 */
export function planarAxes(normal: ReadonlyVec3): { u: Vec3; v: Vec3 } {
  const n = normalize(normal);
  const up = Math.abs(n[2]) > 0.9 ? Y : Z;
  const u = normalize(cross(up, n));
  const v = cross(n, u);
  return { u, v };
}

export function planarUV(p: ReadonlyVec3, axes: { u: Vec3; v: Vec3 }): Vec2 {
  return [round(dot(p, axes.u)), round(dot(p, axes.v))];
}

/** Trim floating-point noise so primitive UVs come out as clean numbers. */
function round(x: number): number {
  return Math.round(x * 1e9) / 1e9 + 0;
}
