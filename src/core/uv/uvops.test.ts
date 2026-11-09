import { describe, expect, it } from 'vitest';
import { fromMeshData } from '../halfedge/convert';
import type { HalfEdgeMesh } from '../halfedge/mesh';
import { validate } from '../halfedge/validate';
import { buildPrimitive, defaultSource } from '../primitives';
import { cubeData } from '../testing/fixtures';
import { nearestAxis, projectFaceUVs, transformFaceUVs } from './uvops';

const uvs = (m: HalfEdgeMesh, faceId: number) => [...m.face(faceId).halfEdges()].map((h) => [...h.uv]);
const uvOf = (m: HalfEdgeMesh, faceId: number, v: number) => [...m.face(faceId).halfEdges()].find((h) => h.origin.id === v)!.uv;

describe('projectFaceUVs', () => {
  it('per face: projects each face onto its own plane in world units', () => {
    const m = fromMeshData(cubeData());
    projectFaceUVs(m, m.faces.values(), 'face');
    expect(validate(m)).toEqual([]);
    // Top face (+Z) uses +Y as up: u = x, v = y.
    expect(uvOf(m, 1, 6)).toEqual([1, 1]);
    expect(uvOf(m, 1, 4)).toEqual([0, 0]);
    // Front face (-Y), upright: v = z.
    expect(uvOf(m, 2, 5)[1]).toBe(1);
    expect(uvOf(m, 2, 1)[1]).toBe(0);
  });

  it('box: faces of a slanted solid use the nearest world axis', () => {
    const m = fromMeshData(buildPrimitive({ type: 'cone', params: { ...defaultSource('cone').params, sides: 4 } } as never));
    projectFaceUVs(m, m.faces.values(), 'box');
    expect(validate(m)).toEqual([]);
    expect(nearestAxis([0.2, -0.9, 0.3])).toEqual([0, -1, 0]);
    expect(nearestAxis([0, 0, -1])).toEqual([0, 0, -1]);
  });

  it('planar: one plane for all faces, so shared corners get the same UV', () => {
    const m = fromMeshData(cubeData());
    projectFaceUVs(m, [m.face(1), m.face(2)], 'planar');
    // Vertex 4 and 5 are shared by top and front; one projection means equal UVs.
    expect(uvOf(m, 1, 5)).toEqual(uvOf(m, 2, 5));
    expect(uvOf(m, 1, 4)).toEqual(uvOf(m, 2, 4));
  });

  it('applies scale, rotation and offset', () => {
    const m = fromMeshData(cubeData());
    projectFaceUVs(m, [m.face(1)], 'face', { scale: 2, rotation: 90, offset: [1, 0] });
    // (1, 0) / 2 = (0.5, 0) → rotated 90° = (0, 0.5) → + (1, 0) = (1, 0.5)
    expect(uvOf(m, 1, 5)).toEqual([1, 0.5]);
  });
});

describe('transformFaceUVs', () => {
  it('scales and rotates about the centre of the UVs', () => {
    const m = fromMeshData(cubeData());
    projectFaceUVs(m, [m.face(1)], 'face');
    transformFaceUVs(m, [m.face(1)], { scale: 0.5, rotation: 0, offset: [0, 0] });
    // Centre (0.5, 0.5); corners move twice as far from it.
    expect(uvs(m, 1).flat().sort()).toEqual([-0.5, -0.5, -0.5, -0.5, 1.5, 1.5, 1.5, 1.5]);
    transformFaceUVs(m, [m.face(1)], { scale: 1, rotation: 0, offset: [0.25, 0] });
    expect(uvOf(m, 1, 4)).toEqual([-0.25, -0.5]);
  });
});
