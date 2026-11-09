import type { FaceData, MeshData } from '../meshdata';
import { HalfEdgeMesh, MeshError } from './mesh';

/**
 * Build a half-edge mesh from serialized data. Throws MeshError if the data is not a valid
 * manifold mesh. Ids and the starting corner of every loop are preserved, so
 * `toMeshData(fromMeshData(d))` reproduces `d` exactly when `d` is in canonical order.
 */
export function fromMeshData(data: MeshData): HalfEdgeMesh {
  const mesh = new HalfEdgeMesh();
  for (const v of data.verts) mesh.addVertex(v.p, v.id);

  for (const f of data.faces) {
    try {
      mesh.addFace(
        f.loops.map((loop) => loop.map((c) => ({ v: mesh.vertex(c.v), uv: c.uv }))),
        f.material,
        f.id,
      );
    } catch (e) {
      throw new MeshError(`Invalid face ${f.id}: ${(e as Error).message}`);
    }
  }

  for (const [a, b] of data.wireEdges) {
    try {
      mesh.addEdge(mesh.vertex(a), mesh.vertex(b));
    } catch (e) {
      throw new MeshError(`Invalid wire edge ${a}-${b}: ${(e as Error).message}`);
    }
  }

  mesh.nextVertId = Math.max(mesh.nextVertId, data.nextVertId);
  mesh.nextFaceId = Math.max(mesh.nextFaceId, data.nextFaceId);
  return mesh;
}

/** Serialize a half-edge mesh. Output is canonical: verts and faces by id, wire edges sorted. */
export function toMeshData(mesh: HalfEdgeMesh): MeshData {
  const verts = [...mesh.verts.values()]
    .sort((a, b) => a.id - b.id)
    .map((v) => ({ id: v.id, p: [v.pos[0], v.pos[1], v.pos[2]] as [number, number, number] }));

  const faces: FaceData[] = [...mesh.faces.values()]
    .sort((a, b) => a.id - b.id)
    .map((f) => ({
      id: f.id,
      material: f.material,
      loops: f.loops.map((loop) =>
        Array.from(loop.halfEdges(), (h) => ({ v: h.origin.id, uv: [h.uv[0], h.uv[1]] as [number, number] })),
      ),
    }));

  const wireEdges: [number, number][] = [];
  for (const e of mesh.edges()) {
    if (!e.isWire) continue;
    const a = e.he.origin.id;
    const b = e.he.dest.id;
    wireEdges.push(a < b ? [a, b] : [b, a]);
  }
  wireEdges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  return { verts, faces, wireEdges, nextVertId: mesh.nextVertId, nextFaceId: mesh.nextFaceId };
}

/** Deep copy via the serialized form. */
export function cloneMesh(mesh: HalfEdgeMesh): HalfEdgeMesh {
  return fromMeshData(toMeshData(mesh));
}
