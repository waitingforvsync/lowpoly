import { describe, expect, it } from 'vitest';
import { fromMeshData } from '../halfedge/convert';
import { type HalfEdgeMesh, MeshError } from '../halfedge/mesh';
import { validate } from '../halfedge/validate';
import { buildPrimitive, defaultSource } from '../primitives';
import { cubeData, quadData } from '../testing/fixtures';
import { edgeRing, evenCuts, loopCut, loopCutSegments } from './loopcut';

const counts = (m: HalfEdgeMesh) => [m.verts.size, m.edgeCount, m.faces.size];
const valid = (m: HalfEdgeMesh) => expect(validate(m)).toEqual([]);
const edge = (m: HalfEdgeMesh, a: number, b: number) => m.findEdge(m.vertex(a), m.vertex(b))!;

describe('edgeRing', () => {
  it('goes all the way round a cube as a closed ring', () => {
    const m = fromMeshData(cubeData());
    // Edge 0-1 (front bottom) is shared by the bottom and front faces; the ring runs
    // bottom → back → top → front, crossing the four edges parallel to X.
    const ring = edgeRing(edge(m, 0, 1));
    expect(ring.closed).toBe(true);
    expect(ring.edges).toHaveLength(4);
    expect(ring.faces).toHaveLength(4);
    // Every "from" end is on the same side, so the same t cuts straight across.
    expect(new Set(ring.edges.map((e) => e.from.pos[0])).size).toBe(1);
  });

  it('stops at the edge of an open sheet', () => {
    const m = fromMeshData(quadData());
    const ring = edgeRing(edge(m, 0, 1));
    expect(ring.closed).toBe(false);
    expect(ring.edges).toHaveLength(2);
    expect(ring.faces).toHaveLength(1);
  });

  it('stops at faces that are not quads', () => {
    // A cylinder's caps are n-gons; the ring around its side is closed, the one through a cap edge is not.
    const m = fromMeshData(buildPrimitive({ ...defaultSource('cylinder') } as never));
    const vertical = [...m.edges()].find((e) => Math.abs(e.verts[0].pos[2] - e.verts[1].pos[2]) > 0.5)!;
    expect(edgeRing(vertical).closed).toBe(true);
  });
});

describe('loopCut', () => {
  it('cuts a cube in half all the way round', () => {
    const m = fromMeshData(cubeData());
    const made = loopCut(m, edge(m, 0, 1), [0.5]);
    valid(m);
    expect(made).toHaveLength(4);
    expect(counts(m)).toEqual([12, 20, 10]);
    for (const v of m.verts.values()) expect([0, 0.5, 1]).toContain(v.pos[0]);
  });

  it('makes several evenly spaced cuts, measured consistently from one side', () => {
    const m = fromMeshData(cubeData());
    loopCut(m, edge(m, 1, 0), evenCuts(3));
    valid(m);
    expect(counts(m)).toEqual([20, 36, 18]);
    const xs = [...new Set([...m.verts.values()].map((v) => v.pos[0]))].sort();
    expect(xs).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('cuts an open strip and leaves an off-centre cut where asked', () => {
    const m = fromMeshData(quadData());
    loopCut(m, edge(m, 0, 1), [0.25]);
    valid(m);
    expect(counts(m)).toEqual([6, 7, 2]);
    expect([...m.verts.values()].filter((v) => v.pos[0] === 0.25)).toHaveLength(2);
  });

  it('previews the same lines it cuts', () => {
    const m = fromMeshData(quadData());
    const segs = loopCutSegments(edgeRing(edge(m, 0, 1)), [0.5]);
    expect(segs).toEqual([
      [
        [0.5, 0, 0],
        [0.5, 1, 0],
      ],
    ]);
  });

  it('refuses bad parameters', () => {
    const m = fromMeshData(quadData());
    expect(() => loopCut(m, edge(m, 0, 1), [1])).toThrow(MeshError);
    expect(() => evenCuts(0)).toThrow(MeshError);
  });
});
