import { describe, expect, it } from 'vitest';
import { cloneMeshData, type MeshData } from '../meshdata';
import { cubeData, squareWithHoleData, twoTrianglesData } from '../testing/fixtures';
import { cloneMesh, fromMeshData, toMeshData } from './convert';
import { validate } from './validate';

describe('MeshData <-> HalfEdgeMesh', () => {
  it.each([
    ['cube', cubeData],
    ['two triangles', twoTrianglesData],
    ['square with hole', squareWithHoleData],
  ])('round-trips the %s exactly', (_, make) => {
    const data = make();
    const mesh = fromMeshData(data);
    expect(validate(mesh)).toEqual([]);
    expect(toMeshData(mesh)).toEqual(data);
  });

  it('builds the expected cube topology', () => {
    const mesh = fromMeshData(cubeData());
    expect(mesh.verts.size).toBe(8);
    expect(mesh.edgeCount).toBe(12);
    expect(mesh.faces.size).toBe(6);
    for (const e of mesh.edges()) expect(e.faces()).toHaveLength(2);
    for (const v of mesh.verts.values()) expect(v.out).toHaveLength(3);
    // Euler characteristic of a closed genus-0 surface.
    expect(mesh.verts.size - mesh.edgeCount + mesh.faces.size).toBe(2);
  });

  it('builds hole loops', () => {
    const mesh = fromMeshData(squareWithHoleData());
    const face = mesh.face(0);
    expect(face.holes).toHaveLength(1);
    expect(face.holes[0]!.isHole).toBe(true);
    expect(face.holes[0]!.verts().map((v) => v.id)).toEqual([4, 5, 6, 7]);
    // Hole edges are boundary edges: the face on one side, open on the other.
    for (const h of face.holes[0]!.halfEdges()) {
      expect(h.edge.isBoundary).toBe(true);
      expect(h.twin.isBoundary).toBe(true);
    }
  });

  it('preserves per-corner UVs', () => {
    const mesh = fromMeshData(twoTrianglesData());
    const h = mesh.findHalfEdge(mesh.vertex(1), mesh.vertex(3))!;
    expect(h.face!.id).toBe(0);
    expect(h.uv).toEqual([1, 0]);
    expect(h.twin.face!.id).toBe(1);
    expect(h.twin.uv).toEqual([0, 1]);
  });

  it('round-trips wire edges and isolated vertices', () => {
    const data = cubeData();
    data.verts.push({ id: 8, p: [5, 5, 5] }, { id: 9, p: [6, 5, 5] }, { id: 10, p: [9, 9, 9] });
    data.wireEdges.push([0, 8], [8, 9]);
    data.nextVertId = 11;
    const mesh = fromMeshData(data);
    expect(validate(mesh)).toEqual([]);
    expect(mesh.findEdge(mesh.vertex(0), mesh.vertex(8))!.isWire).toBe(true);
    expect(toMeshData(mesh)).toEqual(data);
  });

  it('keeps nextVertId/nextFaceId at least past existing ids', () => {
    const data = cubeData();
    data.nextVertId = 100;
    data.nextFaceId = 0; // stale counter
    const mesh = fromMeshData(data);
    expect(mesh.nextVertId).toBe(100);
    expect(mesh.nextFaceId).toBe(6);
  });

  it('cloneMesh produces an independent copy', () => {
    const mesh = fromMeshData(cubeData());
    const copy = cloneMesh(mesh);
    copy.vertex(0).pos[0] = 42;
    expect(mesh.vertex(0).pos[0]).toBe(0);
    expect(toMeshData(mesh)).toEqual(cubeData());
  });

  it('cloneMeshData produces an independent copy', () => {
    const data = cubeData();
    const copy = cloneMeshData(data);
    copy.faces[0]!.loops[0]![0]!.uv[0] = 9;
    expect(data.faces[0]!.loops[0]![0]!.uv[0]).toBe(0);
    expect(copy).not.toEqual(data);
  });
});

describe('fromMeshData rejects invalid data', () => {
  const cases: [string, (d: MeshData) => void, RegExp][] = [
    [
      'a non-manifold edge (three faces)',
      (d) => {
        d.verts.push({ id: 8, p: [0.5, -1, 0.5] });
        // Uses half-edge 1->0? Edge 0-1 already has bottom (1->0) and front (0->1).
        d.faces.push({ id: 6, material: 0, loops: [[0, 1, 8].map((v) => ({ v, uv: [0, 0] }))] });
      },
      /already used/,
    ],
    [
      'inconsistent orientation',
      (d) => {
        d.faces[1]!.loops[0]!.reverse(); // flip the top face
      },
      /already used/,
    ],
    [
      'a repeated vertex',
      (d) => {
        d.faces[0]!.loops[0]![1]!.v = 0;
      },
      /more than once/,
    ],
    [
      'a loop with fewer than 3 corners',
      (d) => {
        d.faces[0]!.loops[0]!.splice(2);
      },
      /at least 3/,
    ],
    [
      'an unknown vertex',
      (d) => {
        d.faces[0]!.loops[0]![0]!.v = 99;
      },
      /No vertex with id 99/,
    ],
    [
      'a duplicate vertex id',
      (d) => {
        d.verts.push({ id: 0, p: [0, 0, 0] });
      },
      /already in use/,
    ],
    [
      'a duplicate face id',
      (d) => {
        d.faces[1]!.id = 0;
      },
      /already in use/,
    ],
    [
      'a wire edge duplicating a face edge',
      (d) => {
        d.wireEdges.push([0, 1]);
      },
      /already exists/,
    ],
  ];

  it.each(cases)('%s', (_, mutate, message) => {
    const data = cubeData();
    mutate(data);
    expect(() => fromMeshData(data)).toThrow(message);
  });
});
