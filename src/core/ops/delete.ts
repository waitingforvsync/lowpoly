import type { Edge, Face, HalfEdgeMesh, Vertex } from '../halfedge/mesh';

/**
 * Deletion operators (Blender semantics):
 * - deleteFaces removes the faces plus any of their edges and vertices left unused.
 * - deleteEdges removes the edges and the faces bordering them. Vertices left unused go too.
 * - deleteVerts removes the vertices and everything touching them.
 * Other edges of removed faces survive as boundary edges.
 */

function alive(mesh: HalfEdgeMesh, x: Vertex | Edge | Face): boolean {
  if ('out' in x) return mesh.verts.get(x.id) === x;
  if ('outer' in x) return mesh.faces.get(x.id) === x;
  return mesh.findEdge(x.he.origin, x.he.dest) === x;
}

function removeIfIsolated(mesh: HalfEdgeMesh, verts: Iterable<Vertex>): void {
  for (const v of verts) if (alive(mesh, v) && v.out.length === 0) mesh.removeVertex(v);
}

export function deleteFaces(mesh: HalfEdgeMesh, faces: Iterable<Face>): void {
  const edges = new Set<Edge>();
  const verts = new Set<Vertex>();
  for (const f of new Set(faces)) {
    if (!alive(mesh, f)) continue;
    for (const h of f.halfEdges()) {
      edges.add(h.edge);
      verts.add(h.origin);
    }
    mesh.removeFace(f);
  }
  for (const e of edges) if (alive(mesh, e) && e.isWire) mesh.removeEdge(e);
  removeIfIsolated(mesh, verts);
}

export function deleteEdges(mesh: HalfEdgeMesh, edges: Iterable<Edge>): void {
  const list = [...new Set(edges)].filter((e) => alive(mesh, e));
  const verts = new Set<Vertex>(list.flatMap((e) => e.verts));
  for (const e of list) for (const f of e.faces()) if (alive(mesh, f)) mesh.removeFace(f);
  for (const e of list) if (alive(mesh, e)) mesh.removeEdge(e);
  removeIfIsolated(mesh, verts);
}

export function deleteVerts(mesh: HalfEdgeMesh, verts: Iterable<Vertex>): void {
  for (const v of new Set(verts)) {
    if (!alive(mesh, v)) continue;
    for (const h of [...v.out]) {
      if (h.face) mesh.removeFace(h.face);
      if (h.twin.face) mesh.removeFace(h.twin.face);
    }
    for (const h of [...v.out]) mesh.removeEdge(h.edge);
    mesh.removeVertex(v);
  }
}
