import { splitEdge, splitFace } from '../halfedge/euler';
import { type Edge, edgeKey, type Face, type HalfEdge, type HalfEdgeMesh, MeshError, type Vertex } from '../halfedge/mesh';
import { lerp3, type Vec3 } from '../math/vec';

/**
 * Loop cut: cut across a strip of quads. Starting from an edge, the ring continues through each
 * quad to the edge opposite, in both directions, until it reaches a face that isn't a quad (or a
 * boundary), or comes back round to the start (a closed ring, e.g. around a cylinder).
 */

export interface EdgeRing {
  /**
   * The ring's edges in order, each as the pair of vertices it runs between. Cut parameters are
   * measured from `from`, so the same t on every edge gives a cut straight across each quad.
   */
  edges: { from: Vertex; to: Vertex }[];
  /** faces[i] lies between edges[i] and edges[i + 1] (wrapping round when closed). */
  faces: Face[];
  closed: boolean;
}

const isQuad = (f: Face | null): f is Face => !!f && f.holes.length === 0 && [...f.outer.halfEdges()].length === 4;

/** Walk across quads from `h`; each step's half-edge keeps "t from its origin" consistent. */
function walk(h: HalfEdge, start: Edge, seen: Set<Face>): { items: HalfEdge[]; faces: Face[]; closed: boolean } {
  const items: HalfEdge[] = [];
  const faces: Face[] = [];
  for (;;) {
    const f = h.face;
    if (!isQuad(f) || seen.has(f)) return { items, faces, closed: false };
    seen.add(f);
    faces.push(f);
    // The opposite side runs the other way round the quad, so t from h.origin is t from its
    // destination, which is the origin of its twin.
    const next = h.next!.next!.twin;
    if (next.edge === start) return { items, faces, closed: true };
    items.push(next);
    h = next;
  }
}

export function edgeRing(edge: Edge): EdgeRing {
  const seen = new Set<Face>();
  const start = { from: edge.he.origin, to: edge.he.dest };
  const fwd = walk(edge.he, edge, seen);
  const fwdEdges = fwd.items.map((h) => ({ from: h.origin, to: h.dest }));
  if (fwd.closed) return { edges: [start, ...fwdEdges], faces: fwd.faces, closed: true };
  // Walking the other way starts from the twin, where t is measured from the far end.
  const back = walk(edge.he.twin, edge, seen);
  const backEdges = back.items.map((h) => ({ from: h.dest, to: h.origin })).reverse();
  return { edges: [...backEdges, start, ...fwdEdges], faces: [...back.faces.reverse(), ...fwd.faces], closed: false };
}

/** Evenly spaced cut parameters for `cuts` cuts. */
export function evenCuts(cuts: number): number[] {
  if (!Number.isInteger(cuts) || cuts < 1) throw new MeshError('Number of cuts must be a positive integer');
  return Array.from({ length: cuts }, (_, i) => (i + 1) / (cuts + 1));
}

/** For previews: the cut lines across each quad, as pairs of points in the mesh's space. */
export function loopCutSegments(ring: EdgeRing, ts: readonly number[]): [Vec3, Vec3][] {
  const n = ring.edges.length;
  const out: [Vec3, Vec3][] = [];
  ring.faces.forEach((_, i) => {
    const a = ring.edges[i]!;
    const b = ring.edges[(i + 1) % n]!;
    for (const t of ts) out.push([lerp3(a.from.pos, a.to.pos, t), lerp3(b.from.pos, b.to.pos, t)]);
  });
  return out;
}

/**
 * Cut the ring through `edge` at each parameter in `ts` (sorted, strictly between 0 and 1).
 * Edits the mesh in place; returns the keys of the new edges running across the quads.
 */
export function loopCut(mesh: HalfEdgeMesh, edge: Edge, ts: readonly number[]): string[] {
  const ring = edgeRing(edge);
  if (!ring.faces.length) throw new MeshError('There are no quads on either side of this edge to cut across');
  const sorted = [...ts].sort((a, b) => a - b);
  if (!sorted.length || sorted[0]! <= 0 || sorted[sorted.length - 1]! >= 1) throw new MeshError('Cuts must lie inside the edge');

  // New vertices along each ring edge, in order from its `from` end.
  const cutVerts = ring.edges.map(({ from, to }) => {
    const vs: Vertex[] = [];
    let start = from;
    let done = 0;
    for (const t of sorted) {
      const rest = mesh.findEdge(start, to);
      if (!rest) throw new MeshError('Edge ring changed while cutting');
      const local = (t - done) / (1 - done);
      const v = splitEdge(mesh, rest, rest.he.origin === start ? local : 1 - local);
      vs.push(v);
      start = v;
      done = t;
    }
    return vs;
  });

  const n = ring.edges.length;
  const created: string[] = [];
  ring.faces.forEach((_, i) => {
    const a = cutVerts[i]!;
    const b = cutVerts[(i + 1) % n]!;
    a.forEach((va, k) => {
      const vb = b[k]!;
      connectInFace(mesh, va, vb);
      created.push(edgeKey(va.id, vb.id));
    });
  });
  return created;
}

/** Split the face whose outer loop holds both vertices along a new edge between them. */
function connectInFace(mesh: HalfEdgeMesh, a: Vertex, b: Vertex): void {
  for (const h of a.out) {
    const f = h.face;
    if (f && f.outer.verts().includes(b)) {
      splitFace(mesh, f, a, b);
      return;
    }
  }
  throw new MeshError('Cut vertices do not share a face');
}
