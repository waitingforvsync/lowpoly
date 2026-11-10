import type { Edge, Face, HalfEdge, Vertex } from '../halfedge/mesh';

/**
 * Selection helpers on mesh elements (the editor maps these to and from selection keys).
 * Grow and shrink follow Blender: growing adds everything that shares a vertex with the selection;
 * shrinking removes what touches anything unselected.
 */

const neighbours = (v: Vertex): Vertex[] => v.out.map((h) => h.dest);

const facesAround = (v: Vertex): Face[] => {
  const out: Face[] = [];
  for (const h of v.out) if (h.face && !out.includes(h.face)) out.push(h.face);
  return out;
};

const faceVerts = (f: Face): Vertex[] => f.loops.flatMap((l) => l.verts());

export function growVertices(sel: ReadonlySet<Vertex>): Set<Vertex> {
  const out = new Set(sel);
  for (const v of sel) for (const n of neighbours(v)) out.add(n);
  return out;
}

export function shrinkVertices(sel: ReadonlySet<Vertex>): Set<Vertex> {
  return new Set([...sel].filter((v) => neighbours(v).every((n) => sel.has(n))));
}

export function growEdges(sel: ReadonlySet<Edge>): Set<Edge> {
  const out = new Set(sel);
  for (const e of sel) for (const v of e.verts) for (const h of v.out) out.add(h.edge);
  return out;
}

export function shrinkEdges(sel: ReadonlySet<Edge>): Set<Edge> {
  return new Set([...sel].filter((e) => e.verts.every((v) => v.out.every((h) => sel.has(h.edge)))));
}

export function growFaces(sel: ReadonlySet<Face>): Set<Face> {
  const out = new Set(sel);
  for (const f of sel) for (const v of faceVerts(f)) for (const g of facesAround(v)) out.add(g);
  return out;
}

export function shrinkFaces(sel: ReadonlySet<Face>): Set<Face> {
  return new Set([...sel].filter((f) => faceVerts(f).every((v) => facesAround(v).every((g) => sel.has(g)))));
}

/** Every vertex connected to the seeds by edges. */
export function linkedVertices(seeds: Iterable<Vertex>): Set<Vertex> {
  const out = new Set<Vertex>();
  const stack = [...seeds];
  while (stack.length) {
    const v = stack.pop()!;
    if (out.has(v)) continue;
    out.add(v);
    for (const n of neighbours(v)) if (!out.has(n)) stack.push(n);
  }
  return out;
}

/**
 * Turn an outgoing half-edge one step round its vertex. `a` crosses the face the half-edge
 * belongs to, `b` crosses its twin's face; either can be blocked by an open boundary.
 */
const turnA = (o: HalfEdge): HalfEdge | null => (o.prev ? o.prev.twin : null);
const turnB = (o: HalfEdge): HalfEdge | null => (o.twin.next ? o.twin.next : null);

/** The edge leaving `h`'s destination straight ahead (two steps round a 4-valent vertex). */
function straightOn(h: HalfEdge): HalfEdge | null {
  const v = h.dest;
  if (v.out.length !== 4) return null;
  const back = h.twin; // leaves v, pointing back the way we came
  const viaA = turnA(back);
  const a2 = viaA && turnA(viaA);
  if (a2) return a2;
  const viaB = turnB(back);
  return (viaB && turnB(viaB)) ?? null;
}

/**
 * The edge loop through an edge: from each end, carry straight on through vertices with four
 * edges (as on a quad grid), stopping at other vertices, or when the loop closes.
 */
export function edgeLoop(edge: Edge): Edge[] {
  const out: Edge[] = [edge];
  const seen = new Set<Edge>([edge]);
  for (const start of [edge.he, edge.he.twin]) {
    let h: HalfEdge | null = start;
    for (;;) {
      h = straightOn(h);
      if (!h || seen.has(h.edge)) break;
      seen.add(h.edge);
      out.push(h.edge);
    }
  }
  return out;
}
