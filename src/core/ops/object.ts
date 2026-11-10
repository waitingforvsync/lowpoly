import { toMeshData } from '../halfedge/convert';
import { type HalfEdgeMesh, MeshError } from '../halfedge/mesh';
import type { ReadonlyVec3, Vec3 } from '../math/vec';
import type { FaceId, MeshData, VertId } from '../meshdata';
import { reverseLoop } from './extrude';

/**
 * Whole-mesh operations behind the object commands (Join, Separate, Apply Transform, Set
 * Origin, Mirror). They work on MeshData and return new data; the caller rebuilds the mesh.
 */

/** A 3×4 affine map, row-major: [a b c tx, d e f ty, g h i tz]. */
export type Affine = readonly number[];

export const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

const round = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

export function applyAffine(m: Affine, p: ReadonlyVec3): Vec3 {
  return [
    m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!,
    m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!,
    m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!,
  ];
}

export function affineDeterminant(m: Affine): number {
  return (
    m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!)
  );
}

/**
 * Move every vertex through `m`. A map that mirrors (negative determinant) would turn faces
 * inside out, so their loops are reversed to keep them facing the same way relative to the
 * surface. UVs are kept.
 */
export function transformMeshData(d: MeshData, m: Affine): MeshData {
  const det = affineDeterminant(m);
  if (Math.abs(det) < 1e-12) throw new MeshError('The transform flattens the mesh');
  return {
    ...d,
    verts: d.verts.map((v) => ({ id: v.id, p: applyAffine(m, v.p).map(round) as Vec3 })),
    faces: d.faces.map((f) => ({ ...f, loops: det < 0 ? f.loops.map(reverseLoop) : f.loops })),
  };
}

export function translateMeshData(d: MeshData, t: ReadonlyVec3): MeshData {
  return transformMeshData(d, [1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2]]);
}

/** Both meshes in one, `b`'s ids shifted past `a`'s. Nothing is welded. */
export function mergeMeshData(a: MeshData, b: MeshData): MeshData {
  const dv = a.nextVertId;
  const df = a.nextFaceId;
  const mv = (id: VertId) => id + dv;
  return {
    verts: [...a.verts, ...b.verts.map((v) => ({ id: mv(v.id), p: v.p }))],
    faces: [...a.faces, ...b.faces.map((f) => ({ ...f, id: f.id + df, loops: f.loops.map((l) => l.map((c) => ({ v: mv(c.v), uv: c.uv }))) }))],
    wireEdges: [...a.wireEdges, ...b.wireEdges.map(([x, y]) => [mv(x), mv(y)] as [VertId, VertId])],
    softEdges: [...a.softEdges, ...b.softEdges.map(([x, y]) => [mv(x), mv(y)] as [VertId, VertId])],
    nextVertId: dv + b.nextVertId,
    nextFaceId: df + b.nextFaceId,
  };
}

/** A new mesh of just these faces (and their vertices), with fresh compact ids. */
export function extractFaces(mesh: HalfEdgeMesh, faceIds: Iterable<FaceId>): MeshData {
  const keep = new Set(faceIds);
  const d = toMeshData(mesh);
  const faces = d.faces.filter((f) => keep.has(f.id));
  const vmap = new Map<VertId, VertId>();
  for (const f of faces) for (const l of f.loops) for (const c of l) if (!vmap.has(c.v)) vmap.set(c.v, vmap.size);
  // Soft edges that still exist in the part (both ends kept and joined by a kept face's side).
  const sorted = (x: VertId, y: VertId) => (x < y ? `${x},${y}` : `${y},${x}`);
  const sides = new Set<string>();
  for (const f of faces) for (const l of f.loops) l.forEach((c, i) => sides.add(sorted(vmap.get(c.v)!, vmap.get(l[(i + 1) % l.length]!.v)!)));
  const softEdges = d.softEdges
    .filter(([x, y]) => vmap.has(x) && vmap.has(y))
    .map(([x, y]) => [vmap.get(x)!, vmap.get(y)!].sort((p, q) => p - q) as [VertId, VertId])
    .filter(([x, y]) => sides.has(sorted(x, y)));
  const pos = new Map(d.verts.map((v) => [v.id, v.p]));
  return {
    verts: [...vmap].map(([old, id]) => ({ id, p: pos.get(old)! })),
    faces: faces.map((f, i) => ({ id: i, material: f.material, loops: f.loops.map((l) => l.map((c) => ({ v: vmap.get(c.v)!, uv: c.uv }))) })),
    wireEdges: [],
    softEdges,
    nextVertId: vmap.size,
    nextFaceId: faces.length,
  };
}

/** Axis-aligned bounds of the mesh's vertices (null if it has none). */
export function meshBounds(d: MeshData): { min: Vec3; max: Vec3 } | null {
  if (!d.verts.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of d.verts) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, v.p[k]!);
      max[k] = Math.max(max[k]!, v.p[k]!);
    }
  }
  return { min, max };
}
