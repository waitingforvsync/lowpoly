import earcut from 'earcut';
import { dot, newellNormal, normalize, planeBasis, type ReadonlyVec3, type Vec3 } from './math/vec';
import type { Face, HalfEdge } from './halfedge/mesh';

/**
 * Triangulate a polygon with holes. `loops[0]` is the outer boundary, `loops[1..]` holes.
 * The polygon is projected onto the best-fit plane of its outer loop (Newell normal), so
 * mildly non-planar faces triangulate sensibly.
 *
 * Returns triangle vertex indices into the loops flattened in order. Every triangle winds
 * counter-clockwise about the outer loop's normal.
 */
export function triangulatePolygon(loops: readonly (readonly ReadonlyVec3[])[]): number[] {
  const outer = loops[0];
  if (!outer || outer.length < 3) return [];

  let n: Vec3 = normalize(newellNormal(outer));
  if (n[0] === 0 && n[1] === 0 && n[2] === 0) n = [0, 0, 1];
  const { u, v } = planeBasis(n);

  const coords: number[] = [];
  const holeIndices: number[] = [];
  let count = 0;
  loops.forEach((loop, i) => {
    if (i > 0) holeIndices.push(count);
    for (const p of loop) {
      coords.push(dot(p, u), dot(p, v));
      count++;
    }
  });

  let tris = earcut(coords, holeIndices.length ? holeIndices : null, 2);

  // Degenerate outer loop (e.g. collinear points): earcut gives up. Fall back to a fan so the
  // face still exists for picking and export.
  if (tris.length === 0 && loops.length === 1) {
    tris = [];
    for (let i = 1; i < outer.length - 1; i++) tris.push(0, i, i + 1);
    return tris;
  }

  // Make every triangle CCW in the plane (u × v = n, so CCW in 2D means CCW about n).
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!;
    const b = tris[t + 1]!;
    const c = tris[t + 2]!;
    const ax = coords[a * 2]!;
    const ay = coords[a * 2 + 1]!;
    const cross =
      (coords[b * 2]! - ax) * (coords[c * 2 + 1]! - ay) - (coords[b * 2 + 1]! - ay) * (coords[c * 2]! - ax);
    if (cross < 0) {
      tris[t + 1] = c;
      tris[t + 2] = b;
    }
  }
  return tris;
}

export interface FaceTriangulation {
  /** Face corners, flattened over the outer loop then holes. Each carries position and UV. */
  corners: HalfEdge[];
  /** Triangle indices into `corners`. */
  indices: number[];
}

export function triangulateFace(face: Face): FaceTriangulation {
  const loops = face.loops.map((loop) => Array.from(loop.halfEdges()));
  const indices = triangulatePolygon(loops.map((hes) => hes.map((h) => h.origin.pos)));
  return { corners: loops.flat(), indices };
}
