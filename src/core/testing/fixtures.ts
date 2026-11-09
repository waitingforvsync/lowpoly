import type { Corner, MeshData } from '../meshdata';
import type { Vec2, Vec3 } from '../math/vec';

const QUAD_UVS: Vec2[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

function loop(ids: number[], uvs: Vec2[] = QUAD_UVS): Corner[] {
  return ids.map((v, i) => ({ v, uv: uvs[i] ?? [0, 0] }));
}

function verts(ps: Vec3[]): MeshData['verts'] {
  return ps.map((p, id) => ({ id, p }));
}

/** Unit cube [0,1]^3, outward-facing CCW quads, canonical order. */
export function cubeData(): MeshData {
  return {
    verts: verts([
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ]),
    faces: [
      { id: 0, material: 0, loops: [loop([0, 3, 2, 1])] }, // bottom (-Z)
      { id: 1, material: 0, loops: [loop([4, 5, 6, 7])] }, // top (+Z)
      { id: 2, material: 0, loops: [loop([0, 1, 5, 4])] }, // front (-Y)
      { id: 3, material: 0, loops: [loop([2, 3, 7, 6])] }, // back (+Y)
      { id: 4, material: 0, loops: [loop([0, 4, 7, 3])] }, // left (-X)
      { id: 5, material: 0, loops: [loop([1, 2, 6, 5])] }, // right (+X)
    ],
    wireEdges: [],
    nextVertId: 8,
    nextFaceId: 6,
  };
}

/** Single quad on the XY plane (normal +Z), side 1. */
export function quadData(): MeshData {
  return {
    verts: verts([
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ]),
    faces: [{ id: 0, material: 0, loops: [loop([0, 1, 2, 3])] }],
    wireEdges: [],
    nextVertId: 4,
    nextFaceId: 1,
  };
}

/** Two triangles sharing edge 1-3, together forming the unit square (normal +Z). */
export function twoTrianglesData(): MeshData {
  return {
    verts: verts([
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ]),
    faces: [
      { id: 0, material: 0, loops: [loop([0, 1, 3], [[0, 0], [1, 0], [0, 1]])] },
      { id: 1, material: 1, loops: [loop([1, 2, 3], [[1, 0], [1, 1], [0, 1]])] },
    ],
    wireEdges: [],
    nextVertId: 4,
    nextFaceId: 2,
  };
}

/** 4x4 square on XY (normal +Z) with a 2x2 square hole in the middle. UV = xy / 4. */
export function squareWithHoleData(): MeshData {
  const ps: Vec3[] = [
    [0, 0, 0],
    [4, 0, 0],
    [4, 4, 0],
    [0, 4, 0],
    [1, 1, 0],
    [1, 3, 0],
    [3, 3, 0],
    [3, 1, 0],
  ];
  const uvLoop = (ids: number[]): Corner[] => ids.map((v) => ({ v, uv: [ps[v]![0] / 4, ps[v]![1] / 4] }));
  return {
    verts: verts(ps),
    faces: [{ id: 0, material: 0, loops: [uvLoop([0, 1, 2, 3]), uvLoop([4, 5, 6, 7])] }],
    wireEdges: [],
    nextVertId: 8,
    nextFaceId: 1,
  };
}
