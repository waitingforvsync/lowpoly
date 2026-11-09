import { describe, expect, it } from 'vitest';
import { cross, dot, length, sub, type ReadonlyVec3, type Vec3 } from './math/vec';
import { fromMeshData } from './halfedge/convert';
import { cubeData, squareWithHoleData } from './testing/fixtures';
import { triangulateFace, triangulatePolygon } from './triangulate';

function triangles(loops: ReadonlyVec3[][], idx: number[]): [Vec3, Vec3, Vec3][] {
  const flat = loops.flat();
  const out: [Vec3, Vec3, Vec3][] = [];
  for (let i = 0; i < idx.length; i += 3) {
    out.push([flat[idx[i]!]! as Vec3, flat[idx[i + 1]!]! as Vec3, flat[idx[i + 2]!]! as Vec3]);
  }
  return out;
}

/** Sum of triangle areas, and check every triangle faces along `normal`. */
function checkTris(loops: ReadonlyVec3[][], normal: Vec3): number {
  const idx = triangulatePolygon(loops);
  let area = 0;
  for (const [a, b, c] of triangles(loops, idx)) {
    const n = cross(sub(b, a), sub(c, a));
    expect(dot(n, normal)).toBeGreaterThanOrEqual(0);
    area += length(n) / 2;
  }
  return area;
}

describe('triangulatePolygon', () => {
  it('splits a square into two CCW triangles', () => {
    const sq: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ];
    expect(triangulatePolygon([sq])).toHaveLength(6);
    expect(checkTris([sq], [0, 0, 1])).toBeCloseTo(1);
  });

  it('handles a concave L-shape', () => {
    const L: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 1, 0],
      [1, 1, 0],
      [1, 2, 0],
      [0, 2, 0],
    ];
    expect(triangulatePolygon([L])).toHaveLength(12);
    expect(checkTris([L], [0, 0, 1])).toBeCloseTo(3);
  });

  it('handles holes', () => {
    const d = squareWithHoleData();
    const pos = (id: number) => d.verts[id]!.p;
    const loops = d.faces[0]!.loops.map((l) => l.map((c) => pos(c.v)));
    expect(triangulatePolygon(loops)).toHaveLength(8 * 3);
    expect(checkTris(loops, [0, 0, 1])).toBeCloseTo(12);
  });

  it('handles faces in any orientation', () => {
    // Square in the YZ plane facing -X.
    const sq: Vec3[] = [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ];
    expect(checkTris([sq], [-1, 0, 0])).toBeCloseTo(1);
  });

  it('handles a slightly non-planar quad', () => {
    const q: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0.05],
      [1, 1, 0],
      [0, 1, 0.05],
    ];
    expect(triangulatePolygon([q])).toHaveLength(6);
  });

  it('falls back to a fan for degenerate faces', () => {
    const line: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ];
    expect(triangulatePolygon([line])).toEqual([0, 1, 2]);
  });
});

describe('triangulateFace', () => {
  it('returns corners carrying UVs, with triangles facing along the face normal', () => {
    const m = fromMeshData(cubeData());
    for (const f of m.faces.values()) {
      const { corners, indices } = triangulateFace(f);
      expect(corners).toHaveLength(4);
      expect(indices).toHaveLength(6);
      const n = f.normal();
      for (let i = 0; i < indices.length; i += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => corners[indices[i + k]!]!.origin.pos);
        expect(dot(cross(sub(b!, a!), sub(c!, a!)), n)).toBeGreaterThan(0);
      }
    }
  });

  it('flattens outer and hole corners', () => {
    const m = fromMeshData(squareWithHoleData());
    const { corners, indices } = triangulateFace(m.face(0));
    expect(corners).toHaveLength(8);
    expect(indices).toHaveLength(24);
  });
});
