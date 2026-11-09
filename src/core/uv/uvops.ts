import type { Face, HalfEdgeMesh } from '../halfedge/mesh';
import { add, length, normalize, type ReadonlyVec3, type Vec2, type Vec3 } from '../math/vec';
import { planarAxes, planarUV } from './project';

/**
 * UV commands for faces: projections and transforms. They edit the face corners' UVs in place.
 * UVs are in world units (1 UV unit = 1 length unit); a material's texture size sets how big its
 * image appears.
 */

export type ProjectionKind =
  /** Each face projected onto its own plane: no stretching, seams between faces. */
  | 'face'
  /** All faces projected onto one plane (their average normal): continuous, stretched on slopes. */
  | 'planar'
  /** Each face projected along the world axis closest to its normal: continuous around boxes. */
  | 'box';

export interface UVParams {
  /** UV units per world unit are divided by this: 2 makes the texture twice as big. */
  scale: number;
  /** Degrees, counter-clockwise. */
  rotation: number;
  offset: Vec2;
}

export const DEFAULT_UV_PARAMS: UVParams = { scale: 1, rotation: 0, offset: [0, 0] };

/** Replace the UVs of `faces` with a projection, then apply scale, rotation and offset. */
export function projectFaceUVs(mesh: HalfEdgeMesh, faces: Iterable<Face>, kind: ProjectionKind, params: UVParams = DEFAULT_UV_PARAMS): void {
  const list = [...faces].filter((f) => mesh.faces.get(f.id) === f);
  const shared = kind === 'planar' ? planarAxes(averageNormal(list)) : null;
  const finish = uvTransform(params, [0, 0]);
  for (const f of list) {
    const axes = shared ?? planarAxes(kind === 'box' ? nearestAxis(f.normal()) : f.normal());
    for (const h of f.halfEdges()) h.uv = finish(planarUV(h.origin.pos, axes));
  }
}

/**
 * Transform the existing UVs of `faces` about the centre of their UVs: scale, rotate, then
 * offset. Lets a texture be fitted without re-projecting.
 */
export function transformFaceUVs(mesh: HalfEdgeMesh, faces: Iterable<Face>, params: UVParams): void {
  const list = [...faces].filter((f) => mesh.faces.get(f.id) === f);
  const corners = list.flatMap((f) => [...f.halfEdges()]);
  if (!corners.length) return;
  const c: Vec2 = [0, 0];
  for (const h of corners) {
    c[0] += h.uv[0] / corners.length;
    c[1] += h.uv[1] / corners.length;
  }
  const t = uvTransform(params, c);
  for (const h of corners) h.uv = t(h.uv);
}

/** uv → centre + R(rotation) · (uv − centre) / scale + offset. */
function uvTransform(p: UVParams, centre: Vec2): (uv: Vec2) => Vec2 {
  const s = p.scale > 0 ? p.scale : 1;
  const a = (p.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return ([u, v]) => {
    const x = (u - centre[0]) / s;
    const y = (v - centre[1]) / s;
    return [round(centre[0] + cos * x - sin * y + p.offset[0]), round(centre[1] + sin * x + cos * y + p.offset[1])];
  };
}

function averageNormal(faces: Face[]): Vec3 {
  const n = faces.reduce<Vec3>((s, f) => add(s, f.normal()), [0, 0, 0]);
  return length(n) < 1e-9 ? [0, 0, 1] : normalize(n);
}

/** The signed world axis closest to `n`. */
export function nearestAxis(n: ReadonlyVec3): Vec3 {
  const ax = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  const i = ax[2]! >= ax[0]! && ax[2]! >= ax[1]! ? 2 : ax[0]! >= ax[1]! ? 0 : 1;
  const out: Vec3 = [0, 0, 0];
  out[i] = Math.sign(n[i]!) || 1;
  return out;
}

function round(x: number): number {
  return Math.round(x * 1e9) / 1e9 + 0;
}
