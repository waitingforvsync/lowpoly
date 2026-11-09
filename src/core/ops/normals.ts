import { toMeshData } from '../halfedge/convert';
import type { Face, HalfEdgeMesh } from '../halfedge/mesh';
import { add, cross, dot, scale, sub, type Vec3 } from '../math/vec';
import type { FaceId } from '../meshdata';
import { triangulateFace } from '../triangulate';
import { rebuild, reverseLoop } from './extrude';

/**
 * Face orientation. Neighbouring faces always wind consistently (the half-edge structure can't
 * represent anything else), so orientation is a property of a whole shell: a set of faces
 * connected through shared edges. Flipping one face alone is impossible; these ops flip shells.
 */

/** Shells (edge-connected face sets) of the mesh. */
export function shells(mesh: HalfEdgeMesh): Face[][] {
  const seen = new Set<Face>();
  const out: Face[][] = [];
  for (const start of mesh.faces.values()) {
    if (seen.has(start)) continue;
    const shell: Face[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const f = stack.pop()!;
      shell.push(f);
      for (const h of f.halfEdges()) {
        const n = h.twin.face;
        if (n && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    out.push(shell);
  }
  return out;
}

/** The shells containing any of the given faces (all shells when `faceIds` is omitted). */
function shellsOf(mesh: HalfEdgeMesh, faceIds?: Iterable<FaceId>): Face[][] {
  const all = shells(mesh);
  if (!faceIds) return all;
  const want = new Set(faceIds);
  return all.filter((s) => s.some((f) => want.has(f.id)));
}

/**
 * Signed volume of a shell measured from its own centre. Positive when the faces point outward
 * on the whole; for an open shell it says whether the faces mostly point away from the centre.
 */
export function shellOrientation(shell: Face[]): number {
  const pts = shell.flatMap((f) => f.outer.positions());
  const c = scale(pts.reduce<Vec3>((s, p) => add(s, p), [0, 0, 0]), 1 / Math.max(1, pts.length));
  let vol = 0;
  for (const f of shell) {
    const { corners, indices } = triangulateFace(f);
    for (let i = 0; i < indices.length; i += 3) {
      const a = sub(corners[indices[i]!]!.origin.pos, c);
      const b = sub(corners[indices[i + 1]!]!.origin.pos, c);
      const d = sub(corners[indices[i + 2]!]!.origin.pos, c);
      vol += dot(a, cross(b, d)) / 6;
    }
  }
  return vol;
}

/** Reverse every face of the given shells. Returns the new mesh. */
function flip(mesh: HalfEdgeMesh, shellsToFlip: Face[][]): HalfEdgeMesh {
  const ids = new Set(shellsToFlip.flat().map((f) => f.id));
  const data = toMeshData(mesh);
  for (const f of data.faces) if (ids.has(f.id)) f.loops = f.loops.map(reverseLoop);
  return rebuild(data);
}

/** Flip the shells containing the given faces (every shell when omitted). */
export function flipNormals(mesh: HalfEdgeMesh, faceIds?: Iterable<FaceId>): { mesh: HalfEdgeMesh; flipped: number } {
  const s = shellsOf(mesh, faceIds);
  return { mesh: s.length ? flip(mesh, s) : mesh, flipped: s.length };
}

/** Turn the shells containing the given faces (every shell when omitted) to face outward. */
export function recalculateNormals(mesh: HalfEdgeMesh, faceIds?: Iterable<FaceId>): { mesh: HalfEdgeMesh; flipped: number } {
  const inward = shellsOf(mesh, faceIds).filter((s) => shellOrientation(s) < 0);
  return { mesh: inward.length ? flip(mesh, inward) : mesh, flipped: inward.length };
}
