import { describe, expect, it } from 'vitest';
import { fromMeshData } from '../halfedge/convert';
import { type HalfEdgeMesh, MeshError } from '../halfedge/mesh';
import { validate } from '../halfedge/validate';
import type { Vec3 } from '../math/vec';
import { cubeData, quadData, squareWithHoleData } from '../testing/fixtures';
import { cleanPoints, drawLoopOnFace, drawPathOnFace, faceUnder, locateOnFace, loopMeshData } from './draw';
import { pushPull } from './pushpull';

const counts = (m: HalfEdgeMesh) => [m.verts.size, m.edgeCount, m.faces.size];
const valid = (m: HalfEdgeMesh) => expect(validate(m)).toEqual([]);
const area = (m: HalfEdgeMesh, id: number) => {
  // Shoelace in XY (test faces are horizontal).
  const ps = m.face(id).outer.positions();
  let a = 0;
  ps.forEach((p, i) => {
    const q = ps[(i + 1) % ps.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  });
  return Math.abs(a / 2);
};

/** A 4×4 square on z = 0 (face 0), with planar UVs = xy / 4. */
function bigQuad(): HalfEdgeMesh {
  const d = quadData();
  d.verts.forEach((v) => (v.p = [v.p[0] * 4, v.p[1] * 4, 0]));
  d.faces[0]!.loops[0]!.forEach((c, i) => (c.uv = [[0, 0], [1, 0], [1, 1], [0, 1]][i] as [number, number]));
  return fromMeshData(d);
}

const rect = (x0: number, y0: number, x1: number, y1: number, z = 0): Vec3[] => [
  [x0, y0, z],
  [x1, y0, z],
  [x1, y1, z],
  [x0, y1, z],
];

describe('locateOnFace', () => {
  it('classifies corners, edges, inside, outside, holes and off-plane points', () => {
    const m = fromMeshData(squareWithHoleData());
    const f = m.face(0);
    expect(locateOnFace(f, [0, 0, 0]).kind).toBe('vertex');
    const e = locateOnFace(f, [1, 0, 0]);
    expect(e.kind).toBe('edge');
    if (e.kind === 'edge') expect(e.edge.he.origin.pos[0] + (e.edge.he.dest.pos[0] - e.edge.he.origin.pos[0]) * e.t).toBeCloseTo(1);
    expect(locateOnFace(f, [0.5, 0.5, 0]).kind).toBe('inside');
    expect(locateOnFace(f, [2, 2, 0]).kind).toBe('outside'); // in the hole
    expect(locateOnFace(f, [1, 2, 0]).kind).toBe('hole');
    expect(locateOnFace(f, [5, 2, 0]).kind).toBe('outside');
    expect(locateOnFace(f, [0.5, 0.5, 0.1]).kind).toBe('offplane');
  });
});

describe('drawLoopOnFace', () => {
  it('turns a shape inside a face into a hole filled by a new face, continuing the texture', () => {
    const m = bigQuad();
    const r = drawLoopOnFace(m, 0, rect(1, 1, 3, 2));
    valid(m);
    expect(counts(m)).toEqual([8, 8, 2]);
    expect(r.inner).toHaveLength(1);
    const inner = m.face(r.inner[0]!);
    expect(inner.normal()).toEqual([0, 0, 1]);
    expect(area(m, inner.id)).toBeCloseTo(2);
    // UVs continue the 4×4 face's mapping (uv = xy / 4).
    for (const h of inner.outer.halfEdges()) {
      expect(h.uv[0]).toBeCloseTo(h.origin.pos[0] / 4);
      expect(h.uv[1]).toBeCloseTo(h.origin.pos[1] / 4);
    }
    // The new face can be pulled up into a box on the square.
    const pulled = pushPull(m, [inner.id], 1);
    valid(pulled.mesh);
  });

  it('splits a face when the shape runs from edge to edge', () => {
    const m = bigQuad();
    // A rectangle across the whole square: two corners on each of the bottom and top edges.
    const r = drawLoopOnFace(m, 0, rect(1, 0, 3, 4));
    valid(m);
    expect(m.faces.size).toBe(3);
    expect(r.inner).toHaveLength(1);
    expect(area(m, r.inner[0]!)).toBeCloseTo(8);
  });

  it('cuts a corner off when the shape starts at a corner of the face', () => {
    const m = bigQuad();
    const r = drawLoopOnFace(m, 0, rect(0, 0, 1, 1));
    valid(m);
    expect(m.faces.size).toBe(2);
    expect(area(m, r.inner[0]!)).toBeCloseTo(1);
    expect(r.faces.map((id) => area(m, id)).reduce((a, b) => a + b)).toBeCloseTo(16);
  });

  it('refuses shapes that leave the face, cross themselves, touch at one point or surround a hole', () => {
    expect(() => drawLoopOnFace(bigQuad(), 0, rect(3, 3, 5, 5))).toThrow(MeshError);
    const bowtie: Vec3[] = [
      [1, 1, 0],
      [3, 3, 0],
      [3, 1, 0],
      [1, 3, 0],
    ];
    expect(() => drawLoopOnFace(bigQuad(), 0, bowtie)).toThrow(/crosses itself/);
    const touching: Vec3[] = [
      [2, 0, 0],
      [3, 1, 0],
      [1, 1, 0],
    ];
    expect(() => drawLoopOnFace(bigQuad(), 0, touching)).toThrow(/one point/);
    expect(() => drawLoopOnFace(fromMeshData(squareWithHoleData()), 0, rect(0.5, 0.5, 3.5, 3.5))).toThrow(/surround a hole/);
  });
});

describe('drawPathOnFace', () => {
  it('splits a face along a straight line between two edges', () => {
    const m = bigQuad();
    const faces = drawPathOnFace(m, 0, [
      [1, 0, 0],
      [1, 4, 0],
    ]);
    valid(m);
    expect(faces).toHaveLength(2);
    expect(counts(m)).toEqual([6, 7, 2]);
    expect(faces.map((id) => area(m, id)).sort((a, b) => a - b)).toEqual([4, 12]);
  });

  it('splits along a bent path through the inside, between adjacent corners', () => {
    const m = bigQuad();
    const faces = drawPathOnFace(m, 0, [
      [0, 0, 0],
      [2, 1, 0],
      [4, 0, 0],
    ]);
    valid(m);
    expect(faces.map((id) => area(m, id)).sort((a, b) => a - b)).toEqual([2, 14]);
  });

  it('does nothing for a line along an existing edge, and refuses a line leaving the face', () => {
    const m = bigQuad();
    expect(drawPathOnFace(m, 0, [[0, 0, 0], [4, 0, 0]])).toEqual([]);
    expect(counts(m)).toEqual([4, 4, 1]);
    expect(() => drawPathOnFace(m, 0, [[0, 0, 0], [2, 2, 0]])).toThrow(MeshError);
  });

  it('splits the neighbouring face too when a line starts on a shared edge', () => {
    const m = fromMeshData(cubeData());
    // Across the top face (id 1, z = 1) from the middle of the front edge to the back edge.
    const faces = drawPathOnFace(m, 1, [
      [0.5, 0, 1],
      [0.5, 1, 1],
    ]);
    valid(m);
    expect(faces).toHaveLength(2);
    expect(counts(m)).toEqual([10, 15, 7]);
  });
});

describe('faceUnder', () => {
  it('finds the face a shape is drawn on, or none', () => {
    const m = fromMeshData(cubeData());
    expect(faceUnder(m, rect(0.2, 0.2, 0.8, 0.8, 1), true)?.id).toBe(1);
    expect(faceUnder(m, rect(0.2, 0.2, 1.8, 0.8, 1), true)).toBeNull();
    expect(faceUnder(m, [[0, 0, 1], [1, 1, 1]], false)?.id).toBe(1);
    expect(faceUnder(m, [[0, 0, 1], [1, 0, 1]], false)).toBeNull(); // only along an edge
  });
});

describe('loopMeshData', () => {
  it('makes a single face, wound toward `up`', () => {
    for (const pts of [rect(0, 0, 2, 1), rect(0, 0, 2, 1).reverse()]) {
      const m = fromMeshData(loopMeshData(pts, [0, 0, 1]));
      valid(m);
      expect(counts(m)).toEqual([4, 4, 1]);
      expect(m.face(0).normal()).toEqual([0, 0, 1]);
    }
  });

  it('refuses non-planar, degenerate and self-crossing shapes', () => {
    expect(() => loopMeshData([[0, 0, 0], [1, 0, 0], [1, 1, 1], [0, 1, 0]], [0, 0, 1])).toThrow(/plane/);
    expect(() => loopMeshData([[0, 0, 0], [1, 0, 0], [2, 0, 0]], [0, 0, 1])).toThrow(/area/);
    expect(() => loopMeshData([[0, 0, 0], [2, 2, 0], [2, 0, 0], [0, 1, 0]], [0, 0, 1])).toThrow(/crosses itself/);
  });

  it('drops repeated points', () => {
    expect(cleanPoints([[0, 0, 0], [0, 0, 0], [1, 0, 0], [0, 0, 0]], true)).toEqual([
      [0, 0, 0],
      [1, 0, 0],
    ]);
  });
});
