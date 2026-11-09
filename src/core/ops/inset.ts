import { toMeshData } from '../halfedge/convert';
import { type HalfEdgeMesh, MeshError } from '../halfedge/mesh';
import {
  add,
  cross,
  dot,
  normalize,
  planeBasis,
  pointInPolygon2D,
  type ReadonlyVec3,
  scale,
  signedArea2D,
  sub,
  type Vec2,
  type Vec3,
} from '../math/vec';
import type { Corner, FaceData, FaceId, VertId } from '../meshdata';
import { planarAxes, planarUV } from '../uv/project';
import { faceUVMap } from '../uv/continue';
import { rebuild } from './extrude';

/**
 * Inset faces individually by `amount` (in the face's plane).
 *
 * - `ring` (default): the face shrinks and a ring of quads joins it to its old outline. Hole
 *   outlines are inset too (they grow), with their own ring.
 * - `hole` (SketchUp's Offset): the face shrinks, and the old face becomes a frame around it,
 *   with the shrunken face filling the frame's hole. No ring edges. Existing holes stay in the
 *   inner face.
 *
 * The inset face keeps its id. New corners continue the face's UV mapping, since they lie in
 * its plane.
 */

export type InsetMode = 'ring' | 'hole';

export interface InsetResult {
  mesh: HalfEdgeMesh;
  /** The inset (inner) faces. */
  faces: FaceId[];
}

export function insetFaces(mesh: HalfEdgeMesh, faceIds: Iterable<FaceId>, amount: number, mode: InsetMode = 'ring'): InsetResult {
  const ids = [...new Set(faceIds)];
  if (!ids.length) throw new MeshError('No faces to inset');
  if (!(amount > 0)) throw new MeshError('Inset amount must be positive');

  const data = toMeshData(mesh);
  const byId = new Map(data.faces.map((f) => [f.id, f]));

  for (const id of ids) {
    const face = mesh.face(id);
    const fd = byId.get(id)!;
    const n = face.normal();
    const pts = fd.loops.map((l) => l.map((c) => mesh.vertex(c.v).pos));
    const map =
      faceUVMap(pts.flat(), fd.loops.flat().map((c) => c.uv)) ??
      ((axes) => (p: ReadonlyVec3) => planarUV(p, axes))(planarAxes(n));

    const { u, v } = planeBasis(n);
    const to2 = (p: ReadonlyVec3): Vec2 => [dot(p, u), dot(p, v)];
    const outer2 = pts[0]!.map(to2);
    const holes2 = pts.slice(1).map((l) => l.map(to2));
    const insideFace = (p: Vec3) => pointInPolygon2D(to2(p), outer2) && holes2.every((h) => !pointInPolygon2D(to2(p), h));

    const insetLoops = mode === 'hole' ? [0] : fd.loops.map((_, i) => i);
    const newLoops: Corner[][] = fd.loops.map((l) => l.map((c) => ({ ...c })));
    const rings: FaceData[] = [];

    for (const li of insetLoops) {
      const loop = fd.loops[li]!;
      const moved = offsetLoop(pts[li]!, n, amount);
      for (const p of moved) {
        if (!insideFace(p)) throw new MeshError(`Inset amount is too large for face ${id}`);
      }
      // Too large an inset turns edges around (or collapses them), even when every corner
      // still lands inside the face.
      const src = pts[li]!;
      const flipped = moved.some((p, i) => {
        const j = (i + 1) % moved.length;
        return dot(sub(moved[j]!, p), sub(src[j]!, src[i]!)) <= 1e-12;
      });
      if (flipped || Math.abs(signedArea2D(moved.map(to2))) < 1e-12) {
        throw new MeshError(`Inset amount is too large for face ${id}`);
      }
      const newIds: VertId[] = moved.map((p) => {
        const vid = data.nextVertId++;
        data.verts.push({ id: vid, p });
        return vid;
      });
      newLoops[li] = newIds.map((vid, i) => ({ v: vid, uv: map(moved[i]!) }));

      if (mode === 'ring') {
        loop.forEach((c, i) => {
          const j = (i + 1) % loop.length;
          rings.push({
            id: data.nextFaceId++,
            material: fd.material,
            loops: [
              [
                c,
                loop[j]!,
                { v: newIds[j]!, uv: map(moved[j]!) },
                { v: newIds[i]!, uv: map(moved[i]!) },
              ],
            ],
          });
        });
      }
    }

    if (mode === 'hole') {
      // The old outline becomes a frame whose hole is the new outline, reversed.
      rings.push({ id: data.nextFaceId++, material: fd.material, loops: [fd.loops[0]!, [...newLoops[0]!].reverse()] });
    }
    fd.loops = newLoops;
    data.faces.push(...rings);
  }

  return { mesh: rebuild(data), faces: ids };
}

/**
 * Offset a planar loop into the face by `d`. The face always lies to the left of its loops'
 * direction (seen from the normal), for outer loops and holes alike, so n × edge points inward.
 * Corners move along the miter so every edge ends up exactly `d` from where it was.
 */
export function offsetLoop(pts: readonly ReadonlyVec3[], n: ReadonlyVec3, d: number): Vec3[] {
  const count = pts.length;
  return pts.map((p, i) => {
    const prev = pts[(i + count - 1) % count]!;
    const next = pts[(i + 1) % count]!;
    const n0 = normalize(cross(n, normalize(sub(p, prev))));
    const n1 = normalize(cross(n, normalize(sub(next, p))));
    const denom = 1 + dot(n0, n1);
    const m = denom < 1e-6 ? n0 : scale(add(n0, n1), 1 / denom);
    const q = add(p, scale(m, d));
    return [round(q[0]), round(q[1]), round(q[2])];
  });
}

function round(x: number): number {
  return Math.round(x * 1e9) / 1e9 + 0;
}
