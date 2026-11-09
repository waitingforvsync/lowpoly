import { cross, length, normalize, sub } from '../math/vec';
import type { Vec2 } from '../math/vec';
import { joinFaces } from '../halfedge/euler';
import { isPlanar } from '../planarity';
import { type Edge, type Face, type HalfEdge, type HalfEdgeMesh, MeshError, type Vertex } from '../halfedge/mesh';

/**
 * Dissolve operators remove elements while keeping the surface closed, by merging the faces
 * around them.
 */

/**
 * Remove a vertex, merging the faces around it into one. Works for interior vertices (a closed
 * fan), boundary vertices (an open fan), and vertices on wire edges only. Returns the merged
 * face, or null when no face remains.
 */
export function dissolveVertex(mesh: HalfEdgeMesh, v: Vertex): Face | null {
  if (mesh.verts.get(v.id) !== v) throw new MeshError(`Vertex ${v.id} does not belong to this mesh`);

  const withFace = v.out.filter((h) => h.face);
  const viaTwin = v.out.filter((h) => !h.face && h.twin.face);

  if (withFace.length === 0 && viaTwin.length === 0) {
    // Only wire edges (or nothing): two wire edges join into one, otherwise just delete.
    const others = v.out.map((h) => h.dest);
    for (const h of [...v.out]) mesh.removeEdge(h.edge);
    mesh.removeVertex(v);
    if (others.length === 2 && !mesh.findEdge(others[0]!, others[1]!)) mesh.addEdge(others[0]!, others[1]!);
    return null;
  }

  if (v.out.length === 2) return unsplitEdge(mesh, v);

  for (const h of v.out) {
    for (const x of [h, h.twin]) {
      if (x.loop && x.loop !== x.loop.face.outer) throw new MeshError('Cannot dissolve a vertex on a hole');
    }
    if (h.edge.isWire) throw new MeshError('Cannot dissolve a vertex with both wire edges and faces');
  }

  // Order the faces around v. next(h) = h.prev.twin is the next outgoing half-edge around v.
  // For an open fan, start where the previous side is open (h.twin has no face).
  const start = withFace.find((h) => !h.twin.face) ?? withFace[0]!;
  const fan: HalfEdge[] = [];
  let h: HalfEdge | null = start;
  while (h && h.face && !fan.includes(h)) {
    fan.push(h);
    h = h.prev!.twin;
  }
  const closed = h === start;
  if (fan.length !== withFace.length) throw new MeshError('Vertex is not a single fan (non-manifold vertex)');

  type C = { v: Vertex; uv: Vec2 };
  const merged: C[] = [];
  fan.forEach((corner, i) => {
    const seg: C[] = [];
    for (let x = corner.next!; x !== corner; x = x.next!) seg.push({ v: x.origin, uv: [x.uv[0], x.uv[1]] });
    merged.push(...(i === 0 ? seg : seg.slice(1)));
  });
  if (closed) merged.pop();
  if (merged.length < 3) throw new MeshError('Dissolving this vertex would leave a degenerate face');
  if (new Set(merged.map((c) => c.v)).size !== merged.length) {
    throw new MeshError('Dissolving this vertex would repeat a vertex in the merged face');
  }
  if (!isPlanar(merged.map((c) => c.v.pos))) {
    throw new MeshError('The faces around this vertex are not coplanar');
  }
  // An open fan closes with an edge from its last vertex back to its first. If that edge already
  // exists, the half-edge the merged face needs must be free (or belong to a face being merged).
  const fanFaces = new Set(fan.map((c) => c.face!));
  if (!closed) {
    const closing = mesh.findHalfEdge(merged.at(-1)!.v, merged[0]!.v);
    if (closing?.face && !fanFaces.has(closing.face)) {
      throw new MeshError('Dissolving this vertex would create a non-manifold edge');
    }
  }

  const first = fan[0]!.face!;
  const id = first.id;
  const material = first.material;
  for (const c of fan) mesh.removeFace(c.face!);
  for (const x of [...v.out]) mesh.removeEdge(x.edge);
  mesh.removeVertex(v);
  // An open fan with one face may close onto an existing wire edge; addFace reuses it.
  return mesh.addFace([merged], material, id);
}

/**
 * Remove a vertex with exactly two edges (a-v-b), joining them into one edge a-b. Each adjacent
 * face just loses its corner at v; the faces stay separate.
 */
function unsplitEdge(mesh: HalfEdgeMesh, v: Vertex): Face | null {
  const [a, b] = v.out.map((h) => h.dest) as [Vertex, Vertex];
  if (mesh.findEdge(a, b)) throw new MeshError('Dissolving this vertex would duplicate an edge');

  const faces = [...new Set(v.out.flatMap((h) => [h.face, h.twin.face]).filter((f): f is Face => f !== null))];
  const plans = faces.map((f) => ({
    id: f.id,
    material: f.material,
    loops: f.loops.map((loop) =>
      Array.from(loop.halfEdges())
        .filter((h) => h.origin !== v)
        .map((h) => ({ v: h.origin, uv: [h.uv[0], h.uv[1]] as Vec2 })),
    ),
  }));
  if (plans.some((p) => p.loops.some((l) => l.length < 3))) {
    throw new MeshError('Dissolving this vertex would leave a face with fewer than 3 corners');
  }
  // The joined edge is soft only if both edges it replaces were soft.
  const hard = v.out.some((h) => h.edge.hard);

  for (const f of faces) mesh.removeFace(f);
  for (const h of [...v.out]) mesh.removeEdge(h.edge);
  mesh.removeVertex(v);
  if (plans.length === 0) {
    mesh.addEdge(a, b).hard = hard;
    return null;
  }
  const result = plans.map((p) => mesh.addFace(p.loops, p.material, p.id))[0]!;
  mesh.findEdge(a, b)!.hard = hard;
  return result;
}

function isStraightThrough(v: Vertex): boolean {
  if (v.out.length !== 2) return false;
  const [a, b] = v.out.map((h) => h.dest.pos);
  const d1 = normalize(sub(a!, v.pos));
  const d2 = normalize(sub(b!, v.pos));
  return length(cross(d1, d2)) < 1e-6 && d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2] < 0;
}

export interface DissolveResult {
  dissolved: number;
  failed: number;
}

/**
 * Dissolve edges by merging the two faces on either side. Edges without two faces are skipped.
 * Endpoints left in the middle of a straight run are dissolved too.
 */
export function dissolveEdges(mesh: HalfEdgeMesh, edges: Iterable<Edge>): DissolveResult {
  let dissolved = 0;
  let failed = 0;
  const ends = new Set<Vertex>();
  for (const e of new Set(edges)) {
    const [a, b] = e.verts;
    if (mesh.findEdge(a, b) !== e) continue; // already gone
    try {
      joinFaces(mesh, e);
      dissolved++;
      ends.add(a);
      ends.add(b);
    } catch {
      failed++;
    }
  }
  for (const v of ends) {
    if (mesh.verts.get(v.id) === v && isStraightThrough(v)) {
      try {
        dissolveVertex(mesh, v);
      } catch {
        /* keep the vertex */
      }
    }
  }
  return { dissolved, failed };
}

/** Merge each group of adjacent selected faces into one face by dissolving the edges between them. */
export function dissolveFaces(mesh: HalfEdgeMesh, faces: Iterable<Face>): DissolveResult {
  const ids = new Set([...faces].map((f) => f.id));
  const tried = new Set<string>();
  let dissolved = 0;
  let failed = 0;
  for (let progress = true; progress; ) {
    progress = false;
    for (const id of ids) {
      const f = mesh.faces.get(id);
      if (!f) continue;
      for (const h of f.outer.halfEdges()) {
        const other = h.twin.face;
        if (!other || other === f || !ids.has(other.id)) continue;
        const key = `${Math.min(f.id, other.id)}:${Math.max(f.id, other.id)}:${h.origin.id}`;
        if (tried.has(key)) continue;
        tried.add(key);
        try {
          const merged = joinFaces(mesh, h.edge);
          ids.delete(merged.id === f.id ? other.id : f.id);
          dissolved++;
          progress = true;
        } catch {
          failed++;
        }
        break; // f's loop changed (or the join failed); rescan
      }
      if (progress) break;
    }
  }
  return { dissolved, failed };
}
