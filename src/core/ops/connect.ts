import { splitEdge, splitFace } from '../halfedge/euler';
import { type Edge, edgeKey, type HalfEdgeMesh, MeshError, type Vertex } from '../halfedge/mesh';

/**
 * Connect vertices: split faces along new edges between selected vertices that share a face.
 * Within each face, consecutive selected corners (in loop order) are joined, skipping corners
 * that are already adjacent. Edits the mesh in place; returns the new edges' keys.
 */
export function connectVertices(mesh: HalfEdgeMesh, verts: Iterable<Vertex>): string[] {
  const sel = new Set(verts);
  const created: string[] = [];
  // Every split changes the faces, so rescan until nothing more connects.
  for (let progress = true; progress; ) {
    progress = false;
    scan: for (const face of [...mesh.faces.values()]) {
      const corners = face.outer.verts();
      const picked = corners.map((v, i) => [v, i] as const).filter(([v]) => sel.has(v));
      if (picked.length < 2) continue;
      for (let k = 0; k < picked.length; k++) {
        const [va, i] = picked[k]!;
        const [vb, j] = picked[(k + 1) % picked.length]!;
        const n = corners.length;
        if (va === vb || (i + 1) % n === j || (j + 1) % n === i || mesh.findEdge(va, vb)) continue;
        try {
          splitFace(mesh, face, va, vb);
        } catch {
          continue; // e.g. the new edge would cross a hole
        }
        created.push(edgeKey(va.id, vb.id));
        progress = true;
        break scan;
      }
    }
  }
  if (!created.length) throw new MeshError('No two selected vertices share a face without already being joined');
  return created;
}

/**
 * Split each edge into `cuts + 1` equal pieces. Edits the mesh in place; returns the keys of
 * all the pieces (so the selection can follow the split edges).
 */
export function subdivideEdges(mesh: HalfEdgeMesh, edges: Iterable<Edge>, cuts = 1): string[] {
  if (!Number.isInteger(cuts) || cuts < 1) throw new MeshError('Number of cuts must be a positive integer');
  const pieces: string[] = [];
  for (const e of [...edges]) {
    const [a, b] = e.verts;
    if (mesh.findEdge(a, b) !== e) continue;
    let rest = e;
    let from = a;
    for (let i = 0; i < cuts; i++) {
      // Cut off 1/(cuts - i + 1) of what's left, measured from `from`.
      const t = 1 / (cuts - i + 1);
      const v = splitEdge(mesh, rest, rest.he.origin === from ? t : 1 - t);
      pieces.push(edgeKey(from.id, v.id));
      rest = mesh.findEdge(v, b)!;
      from = v;
    }
    pieces.push(edgeKey(from.id, b.id));
  }
  return pieces;
}
