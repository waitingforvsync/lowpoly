import type { Vec2 } from '../math/vec';
import { type Face, type HalfEdgeMesh, MeshError, type Vertex } from '../halfedge/mesh';
import { isFacePlanar, isPlanar } from '../planarity';
import { triangulatePolygon } from '../triangulate';

/**
 * Fold bent faces back into planar pieces (SketchUp-style), after an edit moved some vertices.
 *
 * For each non-planar face:
 * 1. If its unmoved corners (≥ 3) are still coplanar, each run of moved corners is cut off by a
 *    chord between the unmoved corners either side. Moving one corner of a quad therefore folds
 *    along the diagonal between that corner's neighbours, and the unmoved part stays in its plane.
 * 2. Otherwise, if its moved corners (≥ 3) are coplanar, the runs of unmoved corners are cut off.
 * 3. Otherwise the face is triangulated and neighbouring triangles are merged back together
 *    wherever the result stays planar.
 * Pieces that are still bent after 1 or 2 go through 3. Fold edges are created hard.
 * Faces with holes cannot be folded; a bent face with holes throws.
 */

interface C {
  v: Vertex;
  uv: Vec2;
}

export interface PlanarizeResult {
  /** Faces that were split. */
  folded: number;
}

export function planarizeAround(mesh: HalfEdgeMesh, moved: Iterable<Vertex>): PlanarizeResult {
  const movedSet = new Set(moved);
  const faces = new Set<Face>();
  for (const v of movedSet) {
    if (mesh.verts.get(v.id) !== v) continue;
    for (const h of v.out) if (h.face) faces.add(h.face);
  }
  return planarizeFaces(mesh, faces, movedSet);
}

export function planarizeFaces(mesh: HalfEdgeMesh, faces: Iterable<Face>, moved: ReadonlySet<Vertex>): PlanarizeResult {
  let folded = 0;
  for (const f of [...faces]) {
    if (mesh.faces.get(f.id) !== f || isFacePlanar(f)) continue;
    if (f.holes.length) throw new MeshError(`Face ${f.id} has holes and cannot be folded flat`);
    const corners: C[] = Array.from(f.outer.halfEdges(), (h) => ({ v: h.origin, uv: [h.uv[0], h.uv[1]] }));
    const pieces =
      cutRuns(corners, (c) => !moved.has(c.v)) ??
      cutRuns(corners, (c) => moved.has(c.v)) ??
      triangulateAndMerge(corners);
    replaceFace(mesh, f, pieces);
    folded++;
  }
  return { folded };
}

const positions = (cs: C[]) => cs.map((c) => c.v.pos);

/**
 * Keep the corners matching `keep` as one face, cutting off each run of other corners with a
 * chord between its flanking kept corners. Returns null if this doesn't apply.
 */
function cutRuns(corners: C[], keep: (c: C) => boolean): C[][] | null {
  const n = corners.length;
  const kept = corners.filter(keep);
  if (kept.length < 3 || kept.length === n || !isPlanar(positions(kept))) return null;

  const pieces: C[][] = [kept];
  // Start just after a kept corner, so each run is contiguous in the scan.
  const start = corners.findIndex(keep);
  let run: C[] = [];
  let before = corners[start]!;
  for (let i = 1; i <= n; i++) {
    const c = corners[(start + i) % n]!;
    if (keep(c)) {
      if (run.length) pieces.push([before, ...run, c]);
      run = [];
      before = c;
    } else {
      run.push(c);
    }
  }
  return pieces.flatMap((p) => (isPlanar(positions(p)) ? [p] : triangulateAndMerge(p)));
}

/** Triangulate, then greedily merge adjacent pieces while the union stays planar. */
function triangulateAndMerge(corners: C[]): C[][] {
  const idx = triangulatePolygon([positions(corners)]);
  let polys: number[][] = [];
  for (let i = 0; i < idx.length; i += 3) polys.push([idx[i]!, idx[i + 1]!, idx[i + 2]!]);

  for (let merged = true; merged; ) {
    merged = false;
    outer: for (let a = 0; a < polys.length; a++) {
      for (let b = a + 1; b < polys.length; b++) {
        const u = union(polys[a]!, polys[b]!);
        if (u && isPlanar(u.map((i) => corners[i]!.v.pos))) {
          polys = polys.filter((_, k) => k !== a && k !== b);
          polys.push(u);
          merged = true;
          break outer;
        }
      }
    }
  }
  return polys.map((p) => p.map((i) => corners[i]!));
}

/**
 * Union of two polygons (index loops with the same winding) that share exactly one edge.
 * Returns null if they share no edge, more than one, or the result would repeat a vertex.
 */
function union(p: number[], q: number[]): number[] | null {
  const shared: [number, number][] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % p.length]!;
    const j = q.indexOf(b);
    if (j >= 0 && q[(j + 1) % q.length] === a) shared.push([i, j]);
  }
  if (shared.length !== 1) return null;
  const [i, j] = shared[0]!;
  // p from its edge's end (b) round to its start (a), then q's corners strictly between a and b.
  const fromP: number[] = [];
  for (let k = 1; k <= p.length; k++) fromP.push(p[(i + k) % p.length]!);
  const fromQ: number[] = [];
  for (let k = 2; k < q.length; k++) fromQ.push(q[(j + k) % q.length]!);
  const out = [...fromP, ...fromQ];
  return new Set(out).size === out.length ? out : null;
}

/** Replace a face by planar pieces. The first piece keeps the face's id. New edges are hard. */
function replaceFace(mesh: HalfEdgeMesh, f: Face, pieces: C[][]): void {
  // Each piece needs its half-edges free (or currently used by f, which is about to go).
  for (const loop of pieces) {
    loop.forEach((c, i) => {
      const h = mesh.findHalfEdge(c.v, loop[(i + 1) % loop.length]!.v);
      if (h?.face && h.face !== f) throw new MeshError(`Cannot fold face ${f.id}: a fold edge would be non-manifold`);
    });
  }
  const { id, material } = f;
  mesh.removeFace(f);
  pieces.forEach((loop, i) => mesh.addFace([loop], material, i === 0 ? id : undefined));
}
