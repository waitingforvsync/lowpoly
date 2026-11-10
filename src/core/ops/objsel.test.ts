import { describe, expect, it } from 'vitest';
import { fromMeshData, toMeshData } from '../halfedge/convert';
import type { HalfEdgeMesh } from '../halfedge/mesh';
import { validate } from '../halfedge/validate';
import { buildPrimitive, defaultSource } from '../primitives';
import { cubeData, quadData } from '../testing/fixtures';
import { extractFaces, meshBounds, mergeMeshData, transformMeshData, translateMeshData } from './object';
import { shellOrientation, shells } from './normals';
import { loopCut } from './loopcut';
import { edgeLoop, growFaces, growVertices, linkedVertices, shrinkFaces, shrinkVertices } from './select';

const counts = (m: HalfEdgeMesh) => [m.verts.size, m.edgeCount, m.faces.size];
const valid = (m: HalfEdgeMesh) => expect(validate(m)).toEqual([]);
const outward = (m: HalfEdgeMesh) => shells(m).every((s) => shellOrientation(s) > 0);

/** A flat n×n grid of quads on z = 0 (faces row by row, vertices (i, j) at id j·(n+1)+i). */
function grid(n: number): HalfEdgeMesh {
  const verts = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) verts.push({ id: j * (n + 1) + i, p: [i, j, 0] as [number, number, number] });
  const faces = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      faces.push({ id: j * n + i, material: 0, loops: [[a, a + 1, a + n + 2, a + n + 1].map((v) => ({ v, uv: [0, 0] as [number, number] }))] });
    }
  }
  return fromMeshData({ verts, faces, wireEdges: [], softEdges: [], nextVertId: verts.length, nextFaceId: faces.length });
}

describe('object operations on mesh data', () => {
  it('merges two meshes without clashing ids', () => {
    const m = fromMeshData(mergeMeshData(cubeData(), translateMeshData(cubeData(), [3, 0, 0])));
    valid(m);
    expect(counts(m)).toEqual([16, 24, 12]);
    expect(outward(m)).toBe(true);
  });

  it('keeps faces facing out through a mirroring transform', () => {
    const mirrored = transformMeshData(cubeData(), [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    const m = fromMeshData(mirrored);
    valid(m);
    expect(outward(m)).toBe(true);
    expect(meshBounds(mirrored)).toEqual({ min: [-1, 0, 0], max: [0, 1, 1] });
  });

  it('refuses a transform that flattens the mesh', () => {
    expect(() => transformMeshData(cubeData(), [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])).toThrow();
  });

  it('extracts faces into a compact mesh, keeping soft edges between them', () => {
    const cyl = fromMeshData(buildPrimitive(defaultSource('cylinder')));
    const sides = [...cyl.faces.values()].filter((f) => f.outer.verts().length === 4).map((f) => f.id);
    // Smooth the edges between the sides.
    for (const e of cyl.edges()) if (e.faces().every((f) => f.outer.verts().length === 4)) e.hard = false;
    const part = extractFaces(cyl, sides.slice(0, 3));
    const m = fromMeshData(part);
    valid(m);
    expect(counts(m)).toEqual([8, 10, 3]);
    // The edges between the three faces are still soft (border edges keep their flag too).
    expect([...m.edges()].filter((e) => e.faces().length === 2).every((e) => !e.hard)).toBe(true);
    expect(toMeshData(m).verts.map((v) => v.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('selection helpers', () => {
  it('grows and shrinks vertex selections by one ring', () => {
    const m = grid(4);
    const centre = m.vertex(12); // (2, 2)
    const grown = growVertices(new Set([centre]));
    expect(grown.size).toBe(5);
    expect(growVertices(grown).size).toBe(13);
    expect(shrinkVertices(growVertices(grown))).toEqual(grown);
  });

  it('grows faces across shared vertices and shrinks from the border', () => {
    const m = grid(5);
    const f = m.face(12); // (2, 2), away from the grid's edge
    const grown = growFaces(new Set([f]));
    expect(grown.size).toBe(9);
    expect(shrinkFaces(grown)).toEqual(new Set([f]));
  });

  it('finds everything linked to a vertex, and nothing in a separate shell', () => {
    const m = fromMeshData(mergeMeshData(cubeData(), translateMeshData(quadData(), [5, 0, 0])));
    expect(linkedVertices([m.vertex(0)]).size).toBe(8);
    expect(linkedVertices([m.vertex(9)]).size).toBe(4);
  });

  it('walks edge loops straight across a quad grid, stopping at the border', () => {
    const m = grid(4);
    // Horizontal edge in the middle row: (1,2)-(2,2) → the loop is the whole row y = 2.
    const e = m.findEdge(m.vertex(11), m.vertex(12))!;
    const loop = edgeLoop(e);
    expect(loop).toHaveLength(4);
    expect(loop.every((x) => x.verts.every((v) => v.pos[1] === 2))).toBe(true);
  });

  it('stops at vertices without four edges, and closes round a ring', () => {
    const m = fromMeshData(cubeData());
    // Cube corners have three edges, so the loop is just the edge.
    expect(edgeLoop(m.findEdge(m.vertex(0), m.vertex(1))!)).toHaveLength(1);
    // A cube cut round its middle (loop cut) has a closed ring of 4-valent vertices.
    const cut = fromMeshData(cubeData());
    loopCut(cut, cut.findEdge(cut.vertex(0), cut.vertex(4))!, [0.5]);
    const mid = [...cut.edges()].find((e) => e.verts.every((v) => v.pos[2] === 0.5))!;
    const ring = edgeLoop(mid);
    expect(ring).toHaveLength(4);
    expect(ring.every((e) => e.verts.every((v) => v.pos[2] === 0.5))).toBe(true);
  });
});
