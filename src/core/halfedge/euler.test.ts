import { describe, expect, it } from 'vitest';
import { cubeData, quadData, squareWithHoleData, twoTrianglesData } from '../testing/fixtures';
import { fromMeshData, toMeshData } from './convert';
import { addHole, fillHole, joinFaces, removeHole, splitEdge, splitFace } from './euler';
import { HalfEdgeMesh } from './mesh';
import { validate } from './validate';

const ids = (vs: { id: number }[]) => vs.map((v) => v.id);

describe('splitEdge', () => {
  it('inserts a vertex into both adjacent faces with interpolated UVs', () => {
    const m = fromMeshData(cubeData());
    const a = m.vertex(0);
    const b = m.vertex(1);
    const v = splitEdge(m, m.findEdge(a, b)!, 0.25);
    expect(validate(m)).toEqual([]);
    expect(v.id).toBe(8);

    // The edge's stored direction decides what t means; check the position is a quarter of the
    // way from one endpoint.
    expect([0.25, 0.75]).toContain(v.pos[0]);
    expect(v.pos[1]).toBe(0);
    expect(v.pos[2]).toBe(0);

    expect(m.edgeCount).toBe(13);
    expect(m.findEdge(a, b)).toBeUndefined();
    const bottom = m.face(0);
    const front = m.face(2);
    expect(bottom.outer.verts()).toHaveLength(5);
    expect(front.outer.verts()).toHaveLength(5);

    // Front face: 0(0,0) -> 1(1,0). The new corner's UV lies on that UV edge at the same parameter.
    const hv = m.findHalfEdge(v, b)!;
    expect(hv.face).toBe(front);
    expect(hv.uv[0]).toBeCloseTo(v.pos[0]);
    expect(hv.uv[1]).toBe(0);
  });

  it('splits at t measured from edge.he.origin', () => {
    const m = fromMeshData(quadData());
    const e = m.findEdge(m.vertex(0), m.vertex(1))!;
    const origin = e.he.origin;
    const v = splitEdge(m, e, 0.25);
    const d = Math.hypot(v.pos[0] - origin.pos[0], v.pos[1] - origin.pos[1]);
    expect(d).toBeCloseTo(0.25);
  });

  it('splits boundary and wire edges', () => {
    const m = fromMeshData(quadData());
    splitEdge(m, m.findEdge(m.vertex(0), m.vertex(1))!);
    expect(validate(m)).toEqual([]);
    expect(m.face(0).outer.verts()).toHaveLength(5);

    const w = new HalfEdgeMesh();
    const a = w.addVertex([0, 0, 0]);
    const b = w.addVertex([2, 0, 0]);
    const v = splitEdge(w, w.addEdge(a, b));
    expect(validate(w)).toEqual([]);
    expect(v.pos).toEqual([1, 0, 0]);
    expect(w.findEdge(a, v)!.isWire).toBe(true);
    expect(w.findEdge(v, b)!.isWire).toBe(true);
    expect(w.findEdge(a, b)).toBeUndefined();
  });

  it('honours an explicit vertex id and rejects a used one', () => {
    const m = fromMeshData(quadData());
    const e = m.findEdge(m.vertex(0), m.vertex(1))!;
    expect(() => splitEdge(m, e, 0.5, 2)).toThrow(/already in use/);
    expect(toMeshData(m)).toEqual(quadData());
    expect(splitEdge(m, e, 0.5, 20).id).toBe(20);
  });
});

describe('splitFace', () => {
  it('splits a quad into two triangles', () => {
    const m = fromMeshData(quadData());
    const [fa, fb] = splitFace(m, m.face(0), m.vertex(0), m.vertex(2));
    expect(validate(m)).toEqual([]);
    expect(fa.id).toBe(0);
    expect(fb.id).toBe(1);
    expect(ids(fa.outer.verts())).toEqual([0, 1, 2]);
    expect(ids(fb.outer.verts())).toEqual([2, 3, 0]);
    expect(m.findEdge(m.vertex(0), m.vertex(2))!.faces()).toHaveLength(2);
    // UVs are carried across.
    expect(m.findHalfEdge(m.vertex(2), m.vertex(3))!.uv).toEqual([1, 1]);
  });

  it('rejects adjacent or foreign vertices and existing edges', () => {
    const m = fromMeshData(cubeData());
    const top = m.face(1);
    expect(() => splitFace(m, top, m.vertex(4), m.vertex(5))).toThrow(/not adjacent/);
    expect(() => splitFace(m, top, m.vertex(4), m.vertex(0))).toThrow(/outer loop/);
    expect(toMeshData(m)).toEqual(cubeData());
  });

  it('sends holes to the side that contains them', () => {
    // 6-wide rectangle, hole on the right half; split down the middle.
    const m = new HalfEdgeMesh();
    const P = (x: number, y: number) => m.addVertex([x, y, 0]);
    const outer = [P(0, 0), P(3, 0), P(6, 0), P(6, 2), P(3, 2), P(0, 2)];
    const hole = [P(4, 0.5), P(4, 1.5), P(5, 1.5), P(5, 0.5)]; // CW
    const f = m.addFace([outer.map((v) => ({ v })), hole.map((v) => ({ v }))]);
    expect(validate(m)).toEqual([]);

    const [left, right] = splitFace(m, f, outer[4]!, outer[1]!);
    expect(validate(m)).toEqual([]);
    // left = 2-wide side running from (3,2) through (0,*) to (3,0)
    expect(ids(left.outer.verts())).toEqual([4, 5, 0, 1]);
    expect(left.holes).toHaveLength(0);
    expect(right.holes).toHaveLength(1);
  });

  it('refuses to cut through a hole', () => {
    const m = fromMeshData(squareWithHoleData());
    expect(() => splitFace(m, m.face(0), m.vertex(0), m.vertex(2))).toThrow(/cross a hole/);
    expect(toMeshData(m)).toEqual(squareWithHoleData());
  });
});

describe('joinFaces', () => {
  it('merges two triangles into a quad', () => {
    const m = fromMeshData(twoTrianglesData());
    const f = joinFaces(m, m.findEdge(m.vertex(1), m.vertex(3))!);
    expect(validate(m)).toEqual([]);
    expect(m.faces.size).toBe(1);
    expect(m.edgeCount).toBe(4);
    expect(f.outer.verts()).toHaveLength(4);
    // Corner UVs come from the faces they belonged to.
    const uvOf = (id: number) => Array.from(f.outer.halfEdges()).find((h) => h.origin.id === id)!.uv;
    expect(uvOf(0)).toEqual([0, 0]);
    expect(uvOf(2)).toEqual([1, 1]);
  });

  it('keeps the id and material of the edge.he side', () => {
    const m = fromMeshData(twoTrianglesData());
    const e = m.findEdge(m.vertex(1), m.vertex(3))!;
    const keep = e.he.face!;
    const f = joinFaces(m, e);
    expect(f.id).toBe(keep.id);
    expect(f.material).toBe(keep.material);
  });

  it('undoes splitFace', () => {
    const m = fromMeshData(quadData());
    splitFace(m, m.face(0), m.vertex(1), m.vertex(3));
    const f = joinFaces(m, m.findEdge(m.vertex(1), m.vertex(3))!);
    expect(validate(m)).toEqual([]);
    const loop = ids(f.outer.verts());
    // Same cyclic order as the original quad.
    const start = loop.indexOf(0);
    expect([...loop.slice(start), ...loop.slice(0, start)]).toEqual([0, 1, 2, 3]);
  });

  it('carries holes from both faces', () => {
    const m = new HalfEdgeMesh();
    const P = (x: number, y: number) => m.addVertex([x, y, 0]);
    const outer = [P(0, 0), P(3, 0), P(6, 0), P(6, 2), P(3, 2), P(0, 2)];
    const hole = [P(4, 0.5), P(4, 1.5), P(5, 1.5), P(5, 0.5)];
    const f = m.addFace([outer.map((v) => ({ v })), hole.map((v) => ({ v }))]);
    splitFace(m, f, outer[4]!, outer[1]!);
    const joined = joinFaces(m, m.findEdge(outer[1]!, outer[4]!)!);
    expect(validate(m)).toEqual([]);
    expect(joined.holes).toHaveLength(1);
  });

  it('rejects boundary edges and faces sharing several edges', () => {
    const m = fromMeshData(quadData());
    expect(() => joinFaces(m, m.findEdge(m.vertex(0), m.vertex(1))!)).toThrow(/both sides/);

    // Joining top + front on a cube is fine (they share one edge)...
    const c = fromMeshData(cubeData());
    const f = joinFaces(c, c.findEdge(c.vertex(4), c.vertex(5))!);
    expect(validate(c)).toEqual([]);
    expect(f.outer.verts()).toHaveLength(6);
    // ...but the merged face now shares two edges (1-5 and 5-6) with the right face.
    expect(() => joinFaces(c, c.findEdge(c.vertex(1), c.vertex(5))!)).toThrow(/share 2 edges/);
    expect(validate(c)).toEqual([]);
  });
});

describe('holes', () => {
  it('addHole cuts a hole and can fill it', () => {
    const m = fromMeshData(quadData());
    const inner = [
      m.addVertex([0.25, 0.25, 0]),
      m.addVertex([0.75, 0.25, 0]),
      m.addVertex([0.75, 0.75, 0]),
      m.addVertex([0.25, 0.75, 0]),
    ]; // CCW: same as the face, so addHole must flip it
    const { hole, fill } = addHole(m, m.face(0), inner.map((v) => ({ v })), { fill: true });
    expect(validate(m)).toEqual([]);
    expect(m.face(0).holes).toEqual([hole]);
    expect(fill).not.toBeNull();
    expect(fill!.normal()).toEqual([0, 0, 1]);
    // The hole's edges are now interior edges between the outer face and the fill face.
    for (const h of hole.halfEdges()) expect(h.twin.face).toBe(fill);
  });

  it('rolls back completely when a rebuild fails partway', () => {
    const m = fromMeshData(quadData());
    const inner = [
      m.addVertex([0.25, 0.25, 0]),
      m.addVertex([0.25, 0.75, 0]),
      m.addVertex([0.75, 0.75, 0]),
      m.addVertex([0.75, 0.25, 0]),
    ];
    const before = toMeshData(m);
    // The face is rebuilt with its hole, then the fill face fails on a used id.
    expect(() => addHole(m, m.face(0), inner.map((v) => ({ v })), { fill: true, fillId: 0 })).toThrow(
      /already in use/,
    );
    expect(validate(m)).toEqual([]);
    expect(toMeshData(m)).toEqual(before);
  });

  it('addHole rejects vertices already in the face', () => {
    const m = fromMeshData(quadData());
    const v = m.addVertex([0.5, 0.5, 0]);
    const w = m.addVertex([0.6, 0.5, 0]);
    expect(() => addHole(m, m.face(0), [{ v: m.vertex(0) }, { v }, { v: w }])).toThrow(/already be in the face/);
  });

  it('fillHole creates a face with matching UVs', () => {
    const m = fromMeshData(squareWithHoleData());
    const face = m.face(0);
    const fill = fillHole(m, face, face.holes[0]!);
    expect(validate(m)).toEqual([]);
    expect(fill.normal()).toEqual([0, 0, 1]);
    for (const h of fill.outer.halfEdges()) {
      expect(h.uv).toEqual([h.origin.pos[0] / 4, h.origin.pos[1] / 4]);
    }
  });

  it('removeHole closes an open hole and deletes its edges and vertices', () => {
    const m = fromMeshData(squareWithHoleData());
    const face = m.face(0);
    removeHole(m, face, face.holes[0]!);
    expect(validate(m)).toEqual([]);
    expect(m.face(0).holes).toHaveLength(0);
    expect(m.verts.size).toBe(4);
    expect(m.edgeCount).toBe(4);
  });

  it('removeHole refuses a filled hole', () => {
    const m = fromMeshData(squareWithHoleData());
    const face = m.face(0);
    fillHole(m, face, face.holes[0]!);
    expect(() => removeHole(m, face, face.holes[0]!)).toThrow(/filled/);
    expect(validate(m)).toEqual([]);
  });
});
