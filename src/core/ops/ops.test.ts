import { describe, expect, it } from 'vitest';
import { fromMeshData, toMeshData } from '../halfedge/convert';
import { splitEdge, splitFace } from '../halfedge/euler';
import { HalfEdgeMesh } from '../halfedge/mesh';
import { validate } from '../halfedge/validate';
import { buildPrimitive } from '../primitives';
import { cubeData, quadData } from '../testing/fixtures';
import { deleteEdges, deleteFaces, deleteVerts } from './delete';
import { dissolveEdges, dissolveFaces, dissolveVertex } from './dissolve';
import { mergeAtCenter, mergeByDistance } from './merge';

const counts = (m: HalfEdgeMesh) => [m.verts.size, m.edgeCount, m.faces.size];

describe('delete', () => {
  it('deleteFaces keeps shared edges and vertices', () => {
    const m = fromMeshData(cubeData());
    deleteFaces(m, [m.face(1)]);
    expect(validate(m)).toEqual([]);
    expect(counts(m)).toEqual([8, 12, 5]);
  });

  it('deleteFaces removes edges and vertices only it used', () => {
    const m = fromMeshData(quadData());
    deleteFaces(m, [m.face(0)]);
    expect(counts(m)).toEqual([0, 0, 0]);
  });

  it('deleteFaces on every face of a cube empties it', () => {
    const m = fromMeshData(cubeData());
    deleteFaces(m, m.faces.values());
    expect(counts(m)).toEqual([0, 0, 0]);
  });

  it('deleteEdges removes the bordering faces', () => {
    const m = fromMeshData(cubeData());
    deleteEdges(m, [m.findEdge(m.vertex(4), m.vertex(5))!]);
    expect(validate(m)).toEqual([]);
    expect(counts(m)).toEqual([8, 11, 4]);
  });

  it('deleteVerts removes every face touching the vertex', () => {
    const m = fromMeshData(cubeData());
    deleteVerts(m, [m.vertex(0)]);
    expect(validate(m)).toEqual([]);
    expect(counts(m)).toEqual([7, 9, 3]);
  });
});

describe('dissolveVertex', () => {
  it('removes a vertex in the middle of an edge, restoring the original faces', () => {
    const m = fromMeshData(cubeData());
    const v = splitEdge(m, m.findEdge(m.vertex(0), m.vertex(1))!);
    dissolveVertex(m, v);
    expect(validate(m)).toEqual([]);
    expect(counts(m)).toEqual([8, 12, 6]);
    expect(m.findEdge(m.vertex(0), m.vertex(1))!.faces()).toHaveLength(2);
  });

  it('merges a closed fan into one face', () => {
    // Pyramid-like fan: a quad split into 4 triangles around a centre vertex.
    const m = new HalfEdgeMesh();
    const c = [m.addVertex([0, 0, 0]), m.addVertex([1, 0, 0]), m.addVertex([1, 1, 0]), m.addVertex([0, 1, 0])];
    const mid = m.addVertex([0.5, 0.5, 0]);
    for (let i = 0; i < 4; i++) m.addFace([[{ v: c[i]! }, { v: c[(i + 1) % 4]! }, { v: mid }]]);
    const f = dissolveVertex(m, mid)!;
    expect(validate(m)).toEqual([]);
    expect(counts(m)).toEqual([4, 4, 1]);
    expect(f.outer.verts()).toHaveLength(4);
    expect(f.normal()).toEqual([0, 0, 1]);
  });

  it('merges an open fan at a boundary', () => {
    // Quad 0-1-2-3 split into two triangles at vertex 0; dissolving vertex 0 leaves triangle 1-2-3.
    const m = fromMeshData(quadData());
    splitFace(m, m.face(0), m.vertex(0), m.vertex(2));
    const f = dissolveVertex(m, m.vertex(0))!;
    expect(validate(m)).toEqual([]);
    expect(counts(m)).toEqual([3, 3, 1]);
    expect(f.outer.verts().map((v) => v.id).sort()).toEqual([1, 2, 3]);
  });

  it('refuses a cube corner, whose faces are not coplanar', () => {
    const m = fromMeshData(cubeData());
    expect(() => dissolveVertex(m, m.vertex(0))).toThrow(/not coplanar/);
    expect(toMeshData(m)).toEqual(cubeData());
  });

  it('joins two wire edges into one', () => {
    const m = new HalfEdgeMesh();
    const [a, b, c] = [m.addVertex([0, 0, 0]), m.addVertex([1, 0, 0]), m.addVertex([2, 0, 0])];
    m.addEdge(a, b);
    m.addEdge(b, c);
    expect(dissolveVertex(m, b)).toBeNull();
    expect(validate(m)).toEqual([]);
    expect(m.findEdge(a, c)?.isWire).toBe(true);
  });
});

describe('dissolveEdges / dissolveFaces', () => {
  it('dissolveEdges merges faces and cleans up straight-through vertices', () => {
    // Split two adjacent quads' shared edge into a run, then dissolve the edges across it.
    const m = fromMeshData(buildPrimitive({ type: 'box', params: { width: 1, depth: 1, height: 1 } }));
    const top = [...m.faces.values()].find((f) => f.normal()[2] > 0.9)!;
    const [a, , c] = top.outer.verts();
    splitFace(m, top, a!, c!);
    const res = dissolveEdges(m, [m.findEdge(a!, c!)!]);
    expect(res).toEqual({ dissolved: 1, failed: 0 });
    expect(validate(m)).toEqual([]);
    expect(counts(m)).toEqual([8, 12, 6]);
  });

  it('dissolveEdges skips boundary edges', () => {
    const m = fromMeshData(quadData());
    expect(dissolveEdges(m, [m.findEdge(m.vertex(0), m.vertex(1))!])).toEqual({ dissolved: 0, failed: 1 });
    expect(toMeshData(m)).toEqual(quadData());
  });

  it('dissolveFaces merges a strip of faces', () => {
    // 3x1 strip of quads.
    const m = new HalfEdgeMesh();
    const bottom = [0, 1, 2, 3].map((x) => m.addVertex([x, 0, 0]));
    const top = [0, 1, 2, 3].map((x) => m.addVertex([x, 1, 0]));
    for (let i = 0; i < 3; i++) m.addFace([[{ v: bottom[i]! }, { v: bottom[i + 1]! }, { v: top[i + 1]! }, { v: top[i]! }]]);
    const res = dissolveFaces(m, m.faces.values());
    expect(res.dissolved).toBe(2);
    expect(validate(m)).toEqual([]);
    // The two inner edges are gone, and their now straight-through vertices remain (4 per side).
    expect(m.faces.size).toBe(1);
    expect(m.edgeCount).toBe(8);
  });
});

describe('merge', () => {
  it('mergeAtCenter collapses an edge of a cube into a vertex, folding the bent sides', () => {
    const m = fromMeshData(cubeData());
    const out = mergeAtCenter(m, [4, 5]);
    expect(validate(out)).toEqual([]);
    // Top and front become triangles; left and right each fold into two triangles.
    expect(counts(out)).toEqual([7, 13, 8]);
    expect(out.vertex(4).pos).toEqual([0.5, 0, 1]);
    expect(out.verts.has(5)).toBe(false);
  });

  it('mergeAtCenter drops faces that collapse', () => {
    const m = fromMeshData(cubeData());
    // Collapse the whole top face to a point: the top disappears, the sides become triangles.
    const out = mergeAtCenter(m, [4, 5, 6, 7]);
    expect(validate(out)).toEqual([]);
    expect(counts(out)).toEqual([5, 8, 5]);
  });

  it('refuses to pinch a face', () => {
    const m = fromMeshData(quadData());
    expect(() => mergeAtCenter(m, [0, 2])).toThrow(/pinch/);
  });

  it('mergeByDistance welds coincident vertices', () => {
    // Two separate quads touching along x = 1.
    const m = new HalfEdgeMesh();
    const P = (x: number, y: number) => m.addVertex([x, y, 0]);
    const q1 = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
    const q2 = [P(1, 0), P(2, 0), P(2, 1), P(1, 1)];
    m.addFace([q1.map((v) => ({ v }))]);
    m.addFace([q2.map((v) => ({ v }))]);
    expect(m.edgeCount).toBe(8);
    const { mesh, removed } = mergeByDistance(m, [...m.verts.keys()], 1e-4);
    expect(removed).toBe(2);
    expect(validate(mesh)).toEqual([]);
    expect(counts(mesh)).toEqual([6, 7, 2]);
  });
});
