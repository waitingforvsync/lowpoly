import { describe, expect, it } from 'vitest';
import { cubeData, quadData } from '../testing/fixtures';
import { fromMeshData, toMeshData } from './convert';
import { HalfEdgeMesh } from './mesh';
import { validate } from './validate';

describe('HalfEdgeMesh primitives', () => {
  it('builds a face from scratch, creating its edges', () => {
    const m = new HalfEdgeMesh();
    const [a, b, c] = [m.addVertex([0, 0, 0]), m.addVertex([1, 0, 0]), m.addVertex([0, 1, 0])];
    const f = m.addFace([[{ v: a }, { v: b }, { v: c }]]);
    expect(validate(m)).toEqual([]);
    expect(m.edgeCount).toBe(3);
    expect(f.outer.verts()).toEqual([a, b, c]);
    expect(f.normal()).toEqual([0, 0, 1]);
    for (const e of m.edges()) expect(e.isBoundary).toBe(true);
  });

  it('assigns increasing ids and keeps counters past explicit ids', () => {
    const m = new HalfEdgeMesh();
    expect(m.addVertex([0, 0, 0]).id).toBe(0);
    expect(m.addVertex([0, 0, 0], 10).id).toBe(10);
    expect(m.addVertex([0, 0, 0]).id).toBe(11);
  });

  it('copies positions instead of aliasing the input', () => {
    const m = new HalfEdgeMesh();
    const p: [number, number, number] = [1, 2, 3];
    const v = m.addVertex(p);
    p[0] = 9;
    expect(v.pos).toEqual([1, 2, 3]);
  });

  it('reuses existing edges when an adjacent face is added', () => {
    const m = fromMeshData(quadData());
    const v4 = m.addVertex([2, 0, 0]);
    const v5 = m.addVertex([2, 1, 0]);
    m.addFace([[{ v: m.vertex(1) }, { v: v4 }, { v: v5 }, { v: m.vertex(2) }]]);
    expect(validate(m)).toEqual([]);
    expect(m.edgeCount).toBe(7);
    expect(m.findEdge(m.vertex(1), m.vertex(2))!.faces()).toHaveLength(2);
  });

  it('leaves the mesh unchanged when addFace fails', () => {
    const m = fromMeshData(quadData());
    const before = toMeshData(m);
    const v4 = m.addVertex([5, 5, 0]);
    const beforeWithV4 = toMeshData(m);
    // 0->1 is already used by the quad, so this face is rejected (after 3-4 would be created).
    expect(() => m.addFace([[{ v: m.vertex(3) }, { v: v4 }, { v: m.vertex(0) }, { v: m.vertex(1) }]])).toThrow(
      /already used/,
    );
    expect(toMeshData(m)).toEqual(beforeWithV4);
    expect(validate(m)).toEqual([]);
    expect(before.verts).toHaveLength(4);
  });

  it('removeFace keeps edges by default, as boundary or wire edges', () => {
    const m = fromMeshData(cubeData());
    m.removeFace(m.face(1));
    expect(validate(m)).toEqual([]);
    expect(m.faces.size).toBe(5);
    expect(m.edgeCount).toBe(12);
    const topEdge = m.findEdge(m.vertex(4), m.vertex(5))!;
    expect(topEdge.isBoundary).toBe(true);
  });

  it('removeFace can clean up wire edges and isolated vertices', () => {
    const m = fromMeshData(quadData());
    m.removeFace(m.face(0), { removeWireEdges: true, removeIsolatedVerts: true });
    expect(validate(m)).toEqual([]);
    expect(m.edgeCount).toBe(0);
    expect(m.verts.size).toBe(0);
  });

  it('removeFace cleanup leaves shared edges and vertices alone', () => {
    const m = fromMeshData(cubeData());
    m.removeFace(m.face(1), { removeWireEdges: true, removeIsolatedVerts: true });
    expect(validate(m)).toEqual([]);
    expect(m.edgeCount).toBe(12);
    expect(m.verts.size).toBe(8);
  });

  it('guards edge and vertex removal', () => {
    const m = fromMeshData(quadData());
    const e = m.findEdge(m.vertex(0), m.vertex(1))!;
    expect(() => m.removeEdge(e)).toThrow(/borders a face/);
    expect(() => m.removeVertex(m.vertex(0))).toThrow(/still has/);
    expect(() => m.addEdge(m.vertex(0), m.vertex(1))).toThrow(/already exists/);
    expect(() => m.addEdge(m.vertex(0), m.vertex(0))).toThrow(/itself/);
  });

  it('rejects vertices from another mesh', () => {
    const m1 = fromMeshData(quadData());
    const m2 = fromMeshData(quadData());
    expect(() => m1.addFace([[{ v: m2.vertex(0) }, { v: m1.vertex(1) }, { v: m1.vertex(2) }]])).toThrow(
      /does not belong/,
    );
  });

  it('wire edges: add and remove', () => {
    const m = new HalfEdgeMesh();
    const a = m.addVertex([0, 0, 0]);
    const b = m.addVertex([1, 0, 0]);
    const e = m.addEdge(a, b);
    expect(e.isWire).toBe(true);
    expect(validate(m)).toEqual([]);
    m.removeEdge(e);
    expect(m.edgeCount).toBe(0);
    expect(a.out).toHaveLength(0);
    expect(validate(m)).toEqual([]);
  });
});
