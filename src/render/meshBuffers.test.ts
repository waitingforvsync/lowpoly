import { describe, expect, it } from 'vitest';
import { fromMeshData } from '../core/halfedge/convert';
import { cubeData, squareWithHoleData } from '../core/testing/fixtures';
import { buildMeshBuffers } from './meshBuffers';

describe('buildMeshBuffers', () => {
  it('builds flat-shaded triangles for a cube', () => {
    const b = buildMeshBuffers(fromMeshData(cubeData()));
    expect(b.positions.length).toBe(36 * 3);
    expect(b.normals.length).toBe(36 * 3);
    expect(b.uvs.length).toBe(36 * 2);
    expect(b.triFaces.length).toBe(12);
    expect(b.groups).toEqual([{ start: 0, count: 36, material: 0 }]);
    expect(b.edges.length).toBe(12 * 2 * 3);
    // Every normal is a unit axis vector.
    for (let i = 0; i < b.normals.length; i += 3) {
      expect(Math.abs(b.normals[i]!) + Math.abs(b.normals[i + 1]!) + Math.abs(b.normals[i + 2]!)).toBeCloseTo(1);
    }
  });

  it('groups triangles by material', () => {
    const data = cubeData();
    data.faces[1]!.material = 2;
    data.faces[4]!.material = 2;
    const b = buildMeshBuffers(fromMeshData(data));
    expect(b.groups).toEqual([
      { start: 0, count: 24, material: 0 },
      { start: 24, count: 12, material: 2 },
    ]);
    expect([...b.triFaces.slice(8)]).toEqual([1, 1, 4, 4]);
  });

  it('triangulates faces with holes', () => {
    const b = buildMeshBuffers(fromMeshData(squareWithHoleData()));
    expect(b.triFaces.length).toBe(8);
    expect(b.edges.length).toBe(8 * 2 * 3);
  });
});

describe('soft edges', () => {
  it('smooths normals across soft edges and keeps hard edges creased', () => {
    const data = cubeData();
    // Soften the vertical edge between the front (-Y) and right (+X) faces.
    data.softEdges = [[1, 5]];
    const m = fromMeshData(data);
    const b = buildMeshBuffers(m);
    expect(b.softEdges.length).toBe(1 * 2 * 3);
    expect(b.edges.length).toBe(11 * 2 * 3);

    // Find normals emitted at vertex 1 (1,0,0) on the front face: they lean towards +X.
    const front: number[][] = [];
    for (let i = 0; i < b.positions.length / 3; i++) {
      const p = [b.positions[i * 3], b.positions[i * 3 + 1], b.positions[i * 3 + 2]];
      const n = [b.normals[i * 3]!, b.normals[i * 3 + 1]!, b.normals[i * 3 + 2]!];
      if (p[0] === 1 && p[1] === 0 && p[2] === 0 && n[1]! < -0.1) front.push(n);
    }
    expect(front.length).toBeGreaterThan(0);
    for (const n of front) {
      expect(n[0]).toBeCloseTo(Math.SQRT1_2);
      expect(n[1]).toBeCloseTo(-Math.SQRT1_2);
      expect(n[2]).toBeCloseTo(0);
    }
  });

  it('leaves all-hard meshes flat-shaded', () => {
    const b = buildMeshBuffers(fromMeshData(cubeData()));
    expect(b.softEdges.length).toBe(0);
    for (let i = 0; i < b.normals.length; i += 3) {
      const len = Math.abs(b.normals[i]!) + Math.abs(b.normals[i + 1]!) + Math.abs(b.normals[i + 2]!);
      expect(len).toBeCloseTo(1); // an axis vector, not a blend
    }
  });
});
