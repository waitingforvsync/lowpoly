import type { HalfEdgeMesh } from '../core/halfedge/mesh';
import type { FaceId, MaterialId } from '../core/meshdata';
import { triangulateFace } from '../core/triangulate';

/** Flat-shaded, non-indexed render buffers for one mesh. Plain arrays, so this is testable. */
export interface MeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** Contiguous vertex ranges, one per material. */
  groups: { start: number; count: number; material: MaterialId }[];
  /** Face id of each triangle, for picking. */
  triFaces: Int32Array;
  /** Line segment endpoints for every edge. */
  edges: Float32Array;
}

export function buildMeshBuffers(mesh: HalfEdgeMesh): MeshBuffers {
  const faces = [...mesh.faces.values()].sort((a, b) => a.material - b.material || a.id - b.id);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const triFaces: FaceId[] = [];
  const groups: MeshBuffers['groups'] = [];

  for (const face of faces) {
    const { corners, indices } = triangulateFace(face);
    let n = face.normal();
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) n = [0, 0, 1];

    const start = positions.length / 3;
    for (const i of indices) {
      const h = corners[i]!;
      positions.push(h.origin.pos[0], h.origin.pos[1], h.origin.pos[2]);
      normals.push(n[0], n[1], n[2]);
      uvs.push(h.uv[0], h.uv[1]);
    }
    for (let t = 0; t < indices.length / 3; t++) triFaces.push(face.id);

    const count = indices.length;
    const last = groups.at(-1);
    if (last && last.material === face.material) last.count += count;
    else if (count > 0) groups.push({ start, count, material: face.material });
  }

  const edges: number[] = [];
  for (const e of mesh.edges()) {
    const [a, b] = e.verts;
    edges.push(...a.pos, ...b.pos);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    groups,
    triFaces: new Int32Array(triFaces),
    edges: new Float32Array(edges),
  };
}
