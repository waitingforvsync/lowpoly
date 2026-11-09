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
