import { describe, expect, it } from 'vitest';
import { fromMeshData, toMeshData } from '../halfedge/convert';
import { HalfEdgeMesh } from '../halfedge/mesh';
import { validate } from '../halfedge/validate';
import { isPlanar } from '../planarity';
import { cubeData, quadData, squareWithHoleData } from '../testing/fixtures';
import { planarizeAround } from './planarize';

const counts = (m: HalfEdgeMesh) => [m.verts.size, m.edgeCount, m.faces.size];

describe('isPlanar', () => {
  it('accepts flat polygons and rejects bent ones', () => {
    expect(isPlanar([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]])).toBe(true);
    expect(isPlanar([[0, 0, 0], [1, 0, 0], [1, 1, 0.01], [0, 1, 0]])).toBe(false);
    // Tiny noise is tolerated.
    expect(isPlanar([[0, 0, 0], [1, 0, 0], [1, 1, 1e-7], [0, 1, 0]])).toBe(true);
  });
});

describe('planarizeAround', () => {
  it('leaves planar faces alone', () => {
    const m = fromMeshData(cubeData());
    expect(planarizeAround(m, [m.vertex(6)])).toEqual({ folded: 0 });
    // Raising a corner straight up keeps it in both side planes: only the top bends.
    m.vertex(6).pos = [1, 1, 1.5];
    expect(planarizeAround(m, [m.vertex(6)])).toEqual({ folded: 1 });
    expect(validate(m)).toEqual([]);
  });

  it('is a no-op on an untouched mesh', () => {
    const m = fromMeshData(cubeData());
    planarizeAround(m, m.verts.values());
    expect(toMeshData(m)).toEqual(cubeData());
  });

  it("folds a quad along the diagonal between the moved corner's neighbours", () => {
    const m = fromMeshData(quadData());
    const v = m.vertex(3); // top-left corner
    v.pos = [0, 1, 0.5];
    expect(planarizeAround(m, [v])).toEqual({ folded: 1 });
    expect(validate(m)).toEqual([]);
    expect(counts(m)).toEqual([4, 5, 2]);
    expect(m.findEdge(m.vertex(0), m.vertex(2))).toBeDefined(); // the "/" diagonal
    // The unmoved part keeps the face's id and stays in the original plane.
    expect(m.face(0).outer.verts().map((x) => x.id).sort()).toEqual([0, 1, 2]);
    // Fold edges are hard.
    expect(m.findEdge(m.vertex(0), m.vertex(2))!.hard).toBe(true);
  });

  it('folds every face around a raised cube corner', () => {
    const m = fromMeshData(cubeData());
    const v = m.vertex(6);
    v.pos = [1.3, 1.3, 1.5]; // off all three of its faces' planes
    expect(planarizeAround(m, [v])).toEqual({ folded: 3 });
    expect(validate(m)).toEqual([]);
    expect(counts(m)).toEqual([8, 15, 9]);
    // Each fold chord joins two neighbours of the moved corner.
    for (const [a, b] of [[5, 7], [2, 7], [2, 5]]) expect(m.findEdge(m.vertex(a!), m.vertex(b!))).toBeDefined();
  });

  it('keeps UVs on folded pieces', () => {
    const m = fromMeshData(quadData());
    m.vertex(3).pos = [0, 1, 0.5];
    planarizeAround(m, [m.vertex(3)]);
    for (const f of m.faces.values()) {
      for (const h of f.halfEdges()) expect(h.uv).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]][h.origin.id]);
    }
  });

  it('falls back to triangulate-and-merge when neither side is coplanar', () => {
    // Hexagon with alternate corners raised by different amounts.
    const m = new HalfEdgeMesh();
    const vs = Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2;
      return m.addVertex([Math.cos(a), Math.sin(a), 0]);
    });
    m.addFace([vs.map((v) => ({ v }))]);
    vs[0]!.pos[2] = 0.3;
    vs[2]!.pos[2] = -0.2;
    vs[4]!.pos[2] = 0.5;
    planarizeAround(m, [vs[0]!, vs[2]!, vs[4]!]);
    expect(validate(m)).toEqual([]);
    expect(m.faces.size).toBeGreaterThan(1);
  });

  it('refuses to fold a bent face with holes', () => {
    const m = fromMeshData(squareWithHoleData());
    m.vertex(2).pos = [4, 4, 1];
    expect(() => planarizeAround(m, [m.vertex(2)])).toThrow(/holes/);
  });
});

describe('edge hardness', () => {
  it('round-trips through MeshData', () => {
    const data = cubeData();
    data.softEdges = [[4, 5], [5, 6]];
    const m = fromMeshData(data);
    expect(m.findEdge(m.vertex(4), m.vertex(5))!.hard).toBe(false);
    expect(m.findEdge(m.vertex(0), m.vertex(1))!.hard).toBe(true);
    expect(toMeshData(m)).toEqual(data);
  });

  it('rejects soft edges that do not exist', () => {
    const data = cubeData();
    data.softEdges = [[0, 6]];
    expect(() => fromMeshData(data)).toThrow(/Soft edge 0-6/);
  });
});
