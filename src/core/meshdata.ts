import type { Vec2, Vec3 } from './math/vec';

/**
 * Serializable mesh representation. Used for save files, undo snapshots and export.
 * Editing operations work on the half-edge form (see `halfedge/`), converted losslessly.
 *
 * - Vertex and face ids are stable across conversion, save/load and undo.
 * - Edges are implicit (derived from face loops), except wire edges that border no face.
 * - Each face corner carries its own UV, so UV seams are implicit.
 * - `loops[0]` is the outer boundary, counter-clockwise about the face normal.
 *   `loops[1..]` are holes, clockwise about the face normal.
 * - Every face is planar (see core/planarity.ts).
 * - Edges are hard unless listed in `softEdges`.
 */

export type VertId = number;
export type FaceId = number;
export type MaterialId = number;

export interface VertData {
  id: VertId;
  p: Vec3;
}

export interface Corner {
  v: VertId;
  uv: Vec2;
}

export interface FaceData {
  id: FaceId;
  loops: Corner[][];
  material: MaterialId;
}

export interface MeshData {
  verts: VertData[];
  faces: FaceData[];
  wireEdges: [VertId, VertId][];
  /** Edges with smoothed shading, as sorted vertex pairs. All other edges are hard. */
  softEdges: [VertId, VertId][];
  nextVertId: VertId;
  nextFaceId: FaceId;
}

export function emptyMeshData(): MeshData {
  return { verts: [], faces: [], wireEdges: [], softEdges: [], nextVertId: 0, nextFaceId: 0 };
}

/** Deep copy. MeshData is plain JSON-compatible data. */
export function cloneMeshData(m: MeshData): MeshData {
  return {
    verts: m.verts.map((v) => ({ id: v.id, p: [v.p[0], v.p[1], v.p[2]] })),
    faces: m.faces.map((f) => ({
      id: f.id,
      material: f.material,
      loops: f.loops.map((loop) => loop.map((c) => ({ v: c.v, uv: [c.uv[0], c.uv[1]] }))),
    })),
    wireEdges: m.wireEdges.map(([a, b]) => [a, b]),
    softEdges: m.softEdges.map(([a, b]) => [a, b]),
    nextVertId: m.nextVertId,
    nextFaceId: m.nextFaceId,
  };
}
