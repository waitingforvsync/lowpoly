import { describe, expect, it } from 'vitest';
import { fromMeshData } from '../halfedge/convert';
import { splitFace } from '../halfedge/euler';
import { edgeKey, type HalfEdgeMesh } from '../halfedge/mesh';
import { validate } from '../halfedge/validate';
import type { MeshData } from '../meshdata';
import { buildPrimitive, defaultSource } from '../primitives';
import { cubeData, quadData, squareWithHoleData } from '../testing/fixtures';
import { connectVertices, subdivideEdges } from './connect';
import { deleteFaces } from './delete';
import { extrudeEdges, extrudeFaces, extrudeVerts } from './extrude';
import { makeFace, makeHole, triangulateFaces } from './faces';
import { insetFaces } from './inset';
import { flipNormals, recalculateNormals, shellOrientation, shells } from './normals';
import { pushPull } from './pushpull';

const counts = (m: HalfEdgeMesh) => [m.verts.size, m.edgeCount, m.faces.size];
const valid = (m: HalfEdgeMesh) => expect(validate(m)).toEqual([]);
const z = (m: HalfEdgeMesh, faceId: number) => m.face(faceId).outer.positions().map((p) => p[2]);
const outward = (m: HalfEdgeMesh) => shells(m).every((s) => shellOrientation(s) > 0);
const uvAt = (m: HalfEdgeMesh, faceId: number, vertId: number) =>
  [...m.face(faceId).halfEdges()].find((h) => h.origin.id === vertId)!.uv;

describe('extrudeFaces', () => {
  it('extrudes a cube top into a taller box with four walls', () => {
    const r = extrudeFaces(fromMeshData(cubeData()), [1], [0, 0, 1]);
    valid(r.mesh);
    expect(counts(r.mesh)).toEqual([12, 20, 10]);
    expect(z(r.mesh, 1)).toEqual([2, 2, 2, 2]);
    expect(r.vertMap.size).toBe(4);
    expect(outward(r.mesh)).toBe(true);
  });

  it('closes a free-standing sheet into a solid, outward whichever way it is pulled', () => {
    for (const dz of [1, -1]) {
      const r = extrudeFaces(fromMeshData(quadData()), [0], [0, 0, dz]);
      valid(r.mesh);
      expect(counts(r.mesh)).toEqual([8, 12, 6]);
      expect(outward(r.mesh)).toBe(true);
    }
  });

  it('builds walls around holes too', () => {
    const r = extrudeFaces(fromMeshData(squareWithHoleData()), [0], [0, 0, 1]);
    valid(r.mesh);
    // top + base + 4 outer walls + 4 hole walls
    expect(r.mesh.faces.size).toBe(10);
    expect(outward(r.mesh)).toBe(true);
  });

  it('extrudes an edge-connected region as one piece', () => {
    const r = extrudeFaces(fromMeshData(cubeData()), [1, 2], [0, -0.5, 0.5]);
    valid(r.mesh);
    // 6 boundary edges of the top+front region get walls.
    expect(r.mesh.faces.size).toBe(12);
  });

  it('continues the neighbouring face texture up the new walls (texture lock)', () => {
    const r = extrudeFaces(fromMeshData(cubeData()), [1], [0, 0, 1]);
    const a2 = r.vertMap.get(4)!;
    const b2 = r.vertMap.get(5)!;
    const wall = [...r.mesh.faces.values()].find((f) => f.outer.verts().some((v) => v.id === a2) && f.outer.verts().some((v) => v.id === b2) && f.id !== 1)!;
    // The front face has UV (0,1) at vertex 4 and (1,1) at vertex 5; the wall continues upward.
    expect(uvAt(r.mesh, wall.id, 4)).toEqual([0, 1]);
    expect(uvAt(r.mesh, wall.id, 5)).toEqual([1, 1]);
    expect(uvAt(r.mesh, wall.id, b2)).toEqual([1, 2]);
    expect(uvAt(r.mesh, wall.id, a2)).toEqual([0, 2]);
  });

  it('keeps interior soft edges soft on the moved faces', () => {
    const data = cubeData();
    data.softEdges = [[4, 5]];
    const r = extrudeFaces(fromMeshData(data), [1, 2], [0, 0, 1]);
    valid(r.mesh);
    const [a, b] = [r.vertMap.get(4)!, r.vertMap.get(5)!];
    expect(r.mesh.findEdge(r.mesh.vertex(a), r.mesh.vertex(b))!.hard).toBe(false);
  });
});

describe('extrudeEdges / extrudeVerts', () => {
  it('extrudes a boundary edge into a quad', () => {
    const r = extrudeEdges(fromMeshData(quadData()), [edgeKey(0, 1)], [0, 0, 1]);
    valid(r.mesh);
    expect(counts(r.mesh)).toEqual([6, 7, 2]);
  });

  it('extrudes a chain of boundary edges with consistent walls', () => {
    const r = extrudeEdges(fromMeshData(quadData()), [edgeKey(0, 1), edgeKey(1, 2)], [0, 0, 1]);
    valid(r.mesh);
    expect(counts(r.mesh)).toEqual([7, 9, 3]);
  });

  it('extrudes loose edges into a strip', () => {
    const data: MeshData = {
      verts: [
        { id: 0, p: [0, 0, 0] },
        { id: 1, p: [1, 0, 0] },
        { id: 2, p: [2, 0, 0] },
      ],
      faces: [],
      wireEdges: [
        [0, 1],
        [1, 2],
      ],
      softEdges: [],
      nextVertId: 3,
      nextFaceId: 0,
    };
    const r = extrudeEdges(fromMeshData(data), [edgeKey(0, 1), edgeKey(1, 2)], [0, 1, 0]);
    valid(r.mesh);
    expect(counts(r.mesh)).toEqual([6, 7, 2]);
    expect([...r.mesh.edges()].some((e) => e.isWire)).toBe(false);
  });

  it('refuses edges with faces on both sides', () => {
    expect(() => extrudeEdges(fromMeshData(cubeData()), [edgeKey(4, 5)], [0, 0, 1])).toThrow(/open boundary/);
  });

  it('extrudes vertices into loose edges', () => {
    const r = extrudeVerts(fromMeshData(cubeData()), [6], [1, 1, 1]);
    valid(r.mesh);
    expect(counts(r.mesh)).toEqual([9, 13, 6]);
  });
});

describe('pushPull', () => {
  it('stretches a box when its top is pulled or pushed', () => {
    for (const d of [1, -0.5]) {
      const r = pushPull(fromMeshData(cubeData()), [1], d);
      valid(r.mesh);
      expect(counts(r.mesh)).toEqual([8, 12, 6]);
      expect(z(r.mesh, 1)).toEqual(Array(4).fill(1 + d));
      expect(r.faces).toEqual([1]);
    }
  });

  it('turns a free-standing rectangle into a box', () => {
    for (const d of [1, -1]) {
      const r = pushPull(fromMeshData(quadData()), [0], d);
      valid(r.mesh);
      expect(counts(r.mesh)).toEqual([8, 12, 6]);
      expect(outward(r.mesh)).toBe(true);
    }
  });

  it('extrudes an inset face out of the top of a box', () => {
    const inset = insetFaces(fromMeshData(cubeData()), [1], 0.25).mesh;
    const r = pushPull(inset, [1], 0.5);
    valid(r.mesh);
    expect(counts(r.mesh)).toEqual([16, 28, 14]);
    expect(outward(r.mesh)).toBe(true);
  });

  it('pushes a pocket into a box', () => {
    const inset = insetFaces(fromMeshData(cubeData()), [1], 0.25).mesh;
    const r = pushPull(inset, [1], -0.5);
    valid(r.mesh);
    expect(counts(r.mesh)).toEqual([16, 28, 14]);
    expect(z(r.mesh, 1)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(outward(r.mesh)).toBe(true);
  });

  it('merges walls that line up with the faces beside them', () => {
    // Split the top into two halves, then pull up one half.
    const m = fromMeshData(cubeData());
    subdivideEdges(m, [m.findEdge(m.vertex(4), m.vertex(5))!, m.findEdge(m.vertex(7), m.vertex(6))!]);
    splitFace(m, m.face(1), m.vertex(8), m.vertex(9));
    const half = [...m.faces.values()].find((f) => f.normal()[2] > 0.5 && f.outer.verts().some((v) => v.id === 5))!;
    const r = pushPull(m, [half.id], 1);
    valid(r.mesh);
    // The front, right and back walls merge into their faces; one new wall faces the other half.
    expect(counts(r.mesh)).toEqual([12, 18, 8]);
    expect(outward(r.mesh)).toBe(true);
  });

  it('pushes all the way through to cut a tunnel', () => {
    const inset = insetFaces(fromMeshData(cubeData()), [1], 0.25, 'hole').mesh;
    const r = pushPull(inset, [1], -1);
    valid(r.mesh);
    expect(r.faces).toEqual([]);
    expect(r.mesh.face(0).holes.length).toBe(1);
    expect(counts(r.mesh)).toEqual([16, 24, 10]);
  });

  it('pulls a cylinder cap (stretch) and a sphere face (extrude)', () => {
    const cyl = fromMeshData(buildPrimitive(defaultSource('cylinder')));
    const top = [...cyl.faces.values()].find((f) => f.normal()[2] > 0.99)!;
    const r = pushPull(cyl, [top.id], 0.5);
    valid(r.mesh);
    expect(counts(r.mesh)).toEqual(counts(cyl));

    const sph = fromMeshData(buildPrimitive(defaultSource('sphere')));
    const f = sph.faces.values().next().value!;
    const r2 = pushPull(sph, [f.id], 0.3);
    valid(r2.mesh);
    expect(r2.mesh.faces.size).toBe(sph.faces.size + 3);
  });
});

describe('insetFaces', () => {
  it('insets a quad with a ring of quads, continuing its UVs', () => {
    const r = insetFaces(fromMeshData(quadData()), [0], 0.25);
    valid(r.mesh);
    expect(counts(r.mesh)).toEqual([8, 12, 5]);
    const inner = r.mesh.face(0);
    for (const h of inner.halfEdges()) {
      expect(h.uv[0]).toBeCloseTo(h.origin.pos[0]);
      expect(h.uv[1]).toBeCloseTo(h.origin.pos[1]);
      expect([0.25, 0.75]).toContain(h.origin.pos[0]);
    }
  });

  it('insets as a hole (SketchUp offset)', () => {
    const r = insetFaces(fromMeshData(quadData()), [0], 0.25, 'hole');
    valid(r.mesh);
    expect(counts(r.mesh)).toEqual([8, 8, 2]);
    expect(r.mesh.face(0).holes.length).toBe(0);
    expect(r.mesh.face(1).holes.length).toBe(1);
  });

  it('insets hole outlines too', () => {
    const r = insetFaces(fromMeshData(squareWithHoleData()), [0], 0.25);
    valid(r.mesh);
    expect(r.mesh.faces.size).toBe(9);
    expect(r.mesh.face(0).holes.length).toBe(1);
  });

  it('refuses an inset larger than the face', () => {
    expect(() => insetFaces(fromMeshData(quadData()), [0], 0.6)).toThrow(/too large/);
  });
});

describe('connect / subdivide', () => {
  it('connects opposite corners of a quad', () => {
    const m = fromMeshData(quadData());
    const keys = connectVertices(m, [m.vertex(0), m.vertex(2)]);
    valid(m);
    expect(keys).toEqual([edgeKey(0, 2)]);
    expect(m.faces.size).toBe(2);
  });

  it('joins consecutive selected corners only, so a fully selected quad has nothing to connect', () => {
    const m = fromMeshData(cubeData());
    expect(() => connectVertices(m, [4, 5, 6, 7].map((id) => m.vertex(id)))).toThrow();
    const keys = connectVertices(m, [4, 6].map((id) => m.vertex(id)));
    valid(m);
    expect(keys).toEqual([edgeKey(4, 6)]);
  });

  it('refuses when nothing can be connected', () => {
    const m = fromMeshData(quadData());
    expect(() => connectVertices(m, [m.vertex(0), m.vertex(1)])).toThrow();
  });

  it('subdivides an edge into equal pieces', () => {
    const m = fromMeshData(cubeData());
    const keys = subdivideEdges(m, [m.findEdge(m.vertex(4), m.vertex(5))!], 3);
    valid(m);
    expect(keys.length).toBe(4);
    expect(m.verts.size).toBe(11);
    const xs = [...m.verts.values()].filter((v) => v.id >= 8).map((v) => v.pos[0]).sort();
    expect(xs).toEqual([0.25, 0.5, 0.75]);
  });
});

describe('makeFace / makeHole / triangulate', () => {
  it('fills an open box top from its vertices, facing out', () => {
    const m = fromMeshData(cubeData());
    deleteFaces(m, [m.face(1)]);
    const f = makeFace(m, { verts: [4, 6, 5, 7].map((id) => m.vertex(id)) });
    valid(m);
    expect(f.normal()[2]).toBeCloseTo(1);
  });

  it('fills an outline of edges', () => {
    const m = fromMeshData(cubeData());
    deleteFaces(m, [m.face(1)]);
    const edges = [[4, 5], [5, 6], [6, 7], [7, 4]].map(([a, b]) => m.findEdge(m.vertex(a!), m.vertex(b!))!);
    makeFace(m, { edges });
    valid(m);
    expect(m.faces.size).toBe(6);
  });

  it('refuses edges that are not one closed loop, and outlines already filled', () => {
    const m = fromMeshData(cubeData());
    const two = [m.findEdge(m.vertex(4), m.vertex(5))!, m.findEdge(m.vertex(5), m.vertex(6))!];
    expect(() => makeFace(m, { edges: two })).toThrow(/closed loop/);
    expect(() => makeFace(m, { verts: [4, 5, 6, 7].map((id) => m.vertex(id)) })).toThrow(/already/);
  });

  it('cuts an inner face out of the face around it', () => {
    const data: MeshData = {
      verts: [
        [0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0],
        [1, 1, 0], [2, 1, 0], [2, 2, 0], [1, 2, 0],
      ].map((p, id) => ({ id, p: p as [number, number, number] })),
      faces: [
        { id: 0, material: 0, loops: [[0, 1, 2, 3].map((v) => ({ v, uv: [0, 0] as [number, number] }))] },
        { id: 1, material: 0, loops: [[4, 5, 6, 7].map((v) => ({ v, uv: [0, 0] as [number, number] }))] },
      ],
      wireEdges: [],
      softEdges: [],
      nextVertId: 8,
      nextFaceId: 2,
    };
    const m = fromMeshData(data);
    makeHole(m, m.face(1));
    valid(m);
    expect(m.face(0).holes.length).toBe(1);
    expect(m.edgeCount).toBe(8);
  });

  it('triangulates faces, including ones with holes', () => {
    const cube = fromMeshData(cubeData());
    triangulateFaces(cube, [...cube.faces.values()]);
    valid(cube);
    expect(counts(cube)).toEqual([8, 18, 12]);

    const holed = fromMeshData(squareWithHoleData());
    const ids = triangulateFaces(holed, [holed.face(0)]);
    valid(holed);
    expect(ids.length).toBe(8);
    expect([...holed.faces.values()].every((f) => !f.holes.length && f.outer.verts().length === 3)).toBe(true);
  });
});

describe('normals', () => {
  it('flips whole shells and recalculates them outward', () => {
    const flipped = flipNormals(fromMeshData(cubeData()), [1]);
    valid(flipped.mesh);
    expect(flipped.flipped).toBe(1);
    expect(outward(flipped.mesh)).toBe(false);
    const fixed = recalculateNormals(flipped.mesh);
    expect(fixed.flipped).toBe(1);
    expect(outward(fixed.mesh)).toBe(true);
    expect(recalculateNormals(fixed.mesh).flipped).toBe(0);
  });

  it('keeps UVs with their corners when flipping', () => {
    const r = flipNormals(fromMeshData(quadData()));
    valid(r.mesh);
    expect(r.mesh.face(0).normal()[2]).toBeCloseTo(-1);
    expect(uvAt(r.mesh, 0, 2)).toEqual([1, 1]);
  });
});
