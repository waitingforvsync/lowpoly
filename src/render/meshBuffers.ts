import type { Face, HalfEdge, HalfEdgeMesh } from '../core/halfedge/mesh';
import { cross, dot, length, normalize, sub, type Vec3 } from '../core/math/vec';
import type { FaceId, MaterialId } from '../core/meshdata';
import { triangulateFace } from '../core/triangulate';

/** Non-indexed render buffers for one mesh. Plain arrays, so this is testable. */
export interface MeshBuffers {
  positions: Float32Array;
  /** Per-corner normals: the face normal, smoothed across soft edges. */
  normals: Float32Array;
  uvs: Float32Array;
  /** Contiguous vertex ranges, one per material. */
  groups: { start: number; count: number; material: MaterialId }[];
  /** Face id of each triangle, for picking. */
  triFaces: Int32Array;
  /** Line segment endpoints for hard edges. */
  edges: Float32Array;
  /** Line segment endpoints for soft edges (drawn dimmer). */
  softEdges: Float32Array;
}

export function buildMeshBuffers(mesh: HalfEdgeMesh): MeshBuffers {
  const faces = [...mesh.faces.values()].sort((a, b) => a.material - b.material || a.id - b.id);
  const faceNormals = new Map<Face, Vec3>();
  for (const f of faces) {
    const n = f.normal();
    faceNormals.set(f, n[0] === 0 && n[1] === 0 && n[2] === 0 ? [0, 0, 1] : n);
  }
  let anySoft = false;
  for (const e of mesh.edges()) if (!e.hard) anySoft = true;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const triFaces: FaceId[] = [];
  const groups: MeshBuffers['groups'] = [];

  for (const face of faces) {
    const { corners, indices } = triangulateFace(face);
    const flat = faceNormals.get(face)!;
    const cornerNormals = anySoft ? corners.map((h) => cornerNormal(h, faceNormals)) : null;

    const start = positions.length / 3;
    for (const i of indices) {
      const h = corners[i]!;
      const n = cornerNormals ? cornerNormals[i]! : flat;
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

  const hard: number[] = [];
  const soft: number[] = [];
  for (const e of mesh.edges()) {
    const [a, b] = e.verts;
    (e.hard ? hard : soft).push(...a.pos, ...b.pos);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    groups,
    triFaces: new Int32Array(triFaces),
    edges: new Float32Array(hard),
    softEdges: new Float32Array(soft),
  };
}

/** Interior angle at a face corner. */
function cornerAngle(h: HalfEdge): number {
  const p = h.origin.pos;
  const a = normalize(sub(h.prev!.origin.pos, p));
  const b = normalize(sub(h.dest.pos, p));
  return Math.atan2(length(cross(a, b)), dot(a, b));
}

/**
 * The normal at a face corner: the angle-weighted average of the normals of all faces around the
 * vertex that are reachable from this corner's face by crossing soft edges only.
 */
export function cornerNormal(h: HalfEdge, faceNormals: Map<Face, Vec3>): Vec3 {
  const corners: HalfEdge[] = [h];
  const seen = new Set<Face>([h.face!]);
  // Rotate one way: across the incoming edge (prev → v) to the neighbour's corner at v.
  for (let x = h; !x.prev!.edge.hard; ) {
    const next = x.prev!.twin;
    if (!next.face || seen.has(next.face)) break;
    seen.add(next.face);
    corners.push(next);
    x = next;
  }
  // And the other way: across the outgoing edge (v → next).
  for (let x = h; !x.edge.hard; ) {
    const next = x.twin.next;
    if (!next || !x.twin.face || seen.has(x.twin.face)) break;
    seen.add(x.twin.face);
    corners.push(next);
    x = next;
  }
  if (corners.length === 1) return faceNormals.get(h.face!)!;

  const sum: Vec3 = [0, 0, 0];
  for (const c of corners) {
    const n = faceNormals.get(c.face!)!;
    const w = cornerAngle(c);
    sum[0] += n[0] * w;
    sum[1] += n[1] * w;
    sum[2] += n[2] * w;
  }
  return normalize(sum);
}
