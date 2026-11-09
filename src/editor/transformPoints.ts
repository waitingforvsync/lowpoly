import type { Transform } from '../core/document';
import type { ReadonlyVec3, Vec3 } from '../core/math/vec';

/**
 * Object transform applied to points, without Three.js (usable in tests and editor logic).
 * Matches Three.js: scale, then rotate X, Y, Z (Euler order 'XYZ' = R = Rx · Ry · Rz), then translate.
 */

const DEG = Math.PI / 180;

function rotationMatrix(t: Transform): number[] {
  const [x, y, z] = t.rotation.map((d) => d * DEG) as Vec3;
  const a = Math.cos(x), b = Math.sin(x);
  const c = Math.cos(y), d = Math.sin(y);
  const e = Math.cos(z), f = Math.sin(z);
  // Same as THREE.Matrix4.makeRotationFromEuler for order 'XYZ' (row-major 3x3).
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  return [
    c * e, -c * f, d,
    af + be * d, ae - bf * d, -b * c,
    bf - ae * d, be + af * d, a * c,
  ];
}

export function transformPoint(t: Transform, p: ReadonlyVec3): Vec3 {
  const m = rotationMatrix(t);
  const s: Vec3 = [p[0] * t.scale[0], p[1] * t.scale[1], p[2] * t.scale[2]];
  return [
    m[0]! * s[0] + m[1]! * s[1] + m[2]! * s[2] + t.position[0],
    m[3]! * s[0] + m[4]! * s[1] + m[5]! * s[2] + t.position[1],
    m[6]! * s[0] + m[7]! * s[1] + m[8]! * s[2] + t.position[2],
  ];
}

export function inverseTransformPoint(t: Transform, p: ReadonlyVec3): Vec3 {
  const m = rotationMatrix(t);
  const q: Vec3 = [p[0] - t.position[0], p[1] - t.position[1], p[2] - t.position[2]];
  // R is orthonormal, so R^-1 = R^T.
  const r: Vec3 = [
    m[0]! * q[0] + m[3]! * q[1] + m[6]! * q[2],
    m[1]! * q[0] + m[4]! * q[1] + m[7]! * q[2],
    m[2]! * q[0] + m[5]! * q[1] + m[8]! * q[2],
  ];
  const safe = (s: number) => (s === 0 ? 1 : s);
  return [r[0] / safe(t.scale[0]), r[1] / safe(t.scale[1]), r[2] / safe(t.scale[2])];
}
