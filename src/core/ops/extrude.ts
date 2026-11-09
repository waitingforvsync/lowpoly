import { fromMeshData, toMeshData } from '../halfedge/convert';
import { edgeKey, type Face, type HalfEdge, type HalfEdgeMesh, MeshError, type Vertex } from '../halfedge/mesh';
import { add, dot, length, newellNormal, normalize, type ReadonlyVec3, scale, type Vec2, type Vec3 } from '../math/vec';
import type { Corner, FaceData, FaceId, MeshData, VertId } from '../meshdata';
import { projectUVs, wallUVs } from '../uv/continue';

/**
 * Extrusion. Each op works on the serialized form and rebuilds the half-edge mesh, so its result
 * is fully validated, and the input mesh is never modified.
 */

export interface ExtrudeOptions {
  /**
   * Texture lock (default on): new side walls continue the UVs of the face across their base
   * edge. Off: new walls get a fresh world-space planar projection.
   */
  textureLock?: boolean;
}

export interface ExtrudeResult {
  mesh: HalfEdgeMesh;
  /** Each extruded vertex's id → the id of its copy. */
  vertMap: Map<VertId, VertId>;
}

const EPS = 1e-9;

/**
 * Extrude faces as regions: edge-connected faces move together, and side walls are built along
 * each region's boundary (including the boundaries of holes). The faces keep their ids and UVs
 * and move by `offset`.
 *
 * A region whose whole boundary is open (a free-standing sheet, like a plane) is closed into a
 * solid: a reversed copy of it is left behind as a base, and if the sheet is pulled backwards the
 * result is flipped so it faces outward.
 */
export function extrudeFaces(
  mesh: HalfEdgeMesh,
  faceIds: Iterable<FaceId>,
  offset: ReadonlyVec3,
  opts: ExtrudeOptions = {},
): ExtrudeResult {
  const faces = [...new Set(faceIds)].map((id) => mesh.face(id));
  if (!faces.length) throw new MeshError('No faces to extrude');
  if (length(offset) < EPS) throw new MeshError('Extrusion distance is zero');
  const inSet = new Set(faces);
  const lock = opts.textureLock ?? true;

  const data = toMeshData(mesh);
  const faceData = new Map(data.faces.map((f) => [f.id, f]));

  // Copy every vertex of the selected faces.
  const vertMap = new Map<VertId, VertId>();
  for (const f of faces) {
    for (const h of f.halfEdges()) {
      if (vertMap.has(h.origin.id)) continue;
      const id = data.nextVertId++;
      vertMap.set(h.origin.id, id);
      data.verts.push({ id, p: add(h.origin.pos, offset) });
    }
  }
  const to = (id: VertId) => vertMap.get(id)!;

  // Interior soft edges move with the faces. Boundary edges stay where they are (between the
  // new wall and the face outside the region).
  const interiorSoft = data.softEdges.filter(([a, b]) => {
    const e = mesh.findEdge(mesh.vertex(a), mesh.vertex(b))!;
    return e.faces().length === 2 && e.faces().every((f) => inSet.has(f));
  });

  for (const region of regions(faces)) {
    const boundary = region.flatMap((f) => [...f.halfEdges()].filter((h) => !inSet.has(h.twin.face!)));
    const sheet = boundary.length > 0 && boundary.every((h) => h.twin.face === null);
    const normal = region.reduce<Vec3>((n, f) => add(n, newellNormal(f.outer.positions())), [0, 0, 0]);
    const created: FaceData[] = [];

    // The faces themselves move onto the copies.
    for (const f of region) {
      const fd = faceData.get(f.id)!;
      if (sheet) {
        // Leave a reversed copy behind as the base of the new solid.
        const base = { id: data.nextFaceId++, material: fd.material, loops: fd.loops.map(reverseLoop) };
        data.faces.push(base);
        created.push(base);
      }
      fd.loops = fd.loops.map((loop) => loop.map((c) => ({ v: to(c.v), uv: c.uv })));
      created.push(fd);
    }

    // A side wall along every boundary edge: [a, b, b', a'] reuses the half-edge a→b the face
    // gave up, and its top edge is the twin of the face's new edge a'→b'.
    for (const h of boundary) {
      const a = h.origin;
      const b = h.dest;
      const pts: Vec3[] = [a.pos, b.pos, add(b.pos, offset), add(a.pos, offset)];
      const wall: FaceData = {
        id: data.nextFaceId++,
        material: h.face!.material,
        loops: [cornersWithUVs([a.id, b.id, to(b.id), to(a.id)], pts, lock ? sourceUVs(h) : null, offset)],
      };
      data.faces.push(wall);
      created.push(wall);
    }

    // Pulling a sheet backwards would leave the new solid inside out.
    if (sheet && dot(normal, offset) < 0) for (const fd of created) fd.loops = fd.loops.map(reverseLoop);
  }

  // Interior soft edges follow the moved faces. (A sheet's base keeps the originals too; any
  // that no longer exist are dropped by `rebuild`.)
  for (const [a, b] of interiorSoft) data.softEdges.push([to(a), to(b)]);

  dropUnusedVerts(data);
  return { mesh: rebuild(data), vertMap };
}

/**
 * Extrude faces by `distance` along their normals: each edge-connected region moves along its
 * average normal (as Blender's region extrude).
 */
export function extrudeAlongNormals(
  mesh: HalfEdgeMesh,
  faceIds: Iterable<FaceId>,
  distance: number,
  opts: ExtrudeOptions = {},
): HalfEdgeMesh {
  let current = mesh;
  for (const region of regions([...new Set(faceIds)].map((id) => mesh.face(id)))) {
    const n = normalize(region.reduce<Vec3>((s, f) => add(s, newellNormal(f.outer.positions())), [0, 0, 0]));
    current = extrudeFaces(current, region.map((f) => f.id), scale(n, distance), opts).mesh;
  }
  return current;
}

/**
 * Extrude edges that have a free side (open-boundary or wire edges) into quads, and move the
 * copies by `offset`. Returns the vertex map; each edge a–b's copy is vertMap(a)–vertMap(b).
 */
export function extrudeEdges(
  mesh: HalfEdgeMesh,
  edgeKeys: Iterable<string>,
  offset: ReadonlyVec3,
  opts: ExtrudeOptions = {},
): ExtrudeResult {
  const edges = [...new Set(edgeKeys)].map((k) => {
    const e = mesh.edgeByKey(k);
    if (!e) throw new MeshError(`No edge ${k}`);
    return e;
  });
  if (!edges.length) throw new MeshError('No edges to extrude');
  if (length(offset) < EPS) throw new MeshError('Extrusion distance is zero');
  const lock = opts.textureLock ?? true;

  const data = toMeshData(mesh);
  const vertMap = new Map<VertId, VertId>();
  for (const e of edges) {
    for (const v of e.verts) {
      if (vertMap.has(v.id)) continue;
      const id = data.nextVertId++;
      vertMap.set(v.id, id);
      data.verts.push({ id, p: add(v.pos, offset) });
    }
  }
  const to = (id: VertId) => vertMap.get(id)!;

  // Choose which half of each edge the quad uses. Boundary edges have one free half; wire edges
  // take whichever orientation agrees with the quads already planned next to them.
  const used = new Set<string>();
  const quadPairs = (a: Vertex, b: Vertex): [VertId, VertId][] => [
    [a.id, b.id],
    [b.id, to(b.id)],
    [to(b.id), to(a.id)],
    [to(a.id), a.id],
  ];
  const fits = (h: HalfEdge) =>
    h.loop === null &&
    quadPairs(h.origin, h.dest).every(([x, y]) => {
      if (used.has(`${x}>${y}`)) return false;
      const existing = mesh.verts.has(x) && mesh.verts.has(y) ? mesh.findHalfEdge(mesh.vertex(x), mesh.vertex(y)) : undefined;
      return !existing?.loop;
    });

  for (const e of edges) {
    if (!e.he.isBoundary && !e.he.twin.isBoundary) {
      throw new MeshError('Only edges on an open boundary (or loose edges) can be extruded');
    }
    const h = fits(e.he) ? e.he : fits(e.he.twin) ? e.he.twin : null;
    if (!h) throw new MeshError('These edges cannot be extruded together without overlapping faces');
    for (const [x, y] of quadPairs(h.origin, h.dest)) used.add(`${x}>${y}`);
    const a = h.origin;
    const b = h.dest;
    const pts: Vec3[] = [a.pos, b.pos, add(b.pos, offset), add(a.pos, offset)];
    data.faces.push({
      id: data.nextFaceId++,
      material: h.twin.face?.material ?? 0,
      loops: [cornersWithUVs([a.id, b.id, to(b.id), to(a.id)], pts, lock ? sourceUVs(h) : null, offset)],
    });
  }

  // Wire edges that now border a face are no longer wire edges.
  const faceEdges = new Set<string>();
  for (const f of data.faces) for (const l of f.loops) l.forEach((c, i) => faceEdges.add(edgeKey(c.v, l[(i + 1) % l.length]!.v)));
  data.wireEdges = data.wireEdges.filter(([a, b]) => !faceEdges.has(edgeKey(a, b)));

  return { mesh: rebuild(data), vertMap };
}

/** Extrude vertices into loose edges: each vertex gets a copy at `offset`, joined by an edge. */
export function extrudeVerts(mesh: HalfEdgeMesh, ids: Iterable<VertId>, offset: ReadonlyVec3): ExtrudeResult {
  const verts = [...new Set(ids)].map((id) => mesh.vertex(id));
  if (!verts.length) throw new MeshError('No vertices to extrude');
  if (length(offset) < EPS) throw new MeshError('Extrusion distance is zero');
  const data = toMeshData(mesh);
  const vertMap = new Map<VertId, VertId>();
  for (const v of verts) {
    const id = data.nextVertId++;
    vertMap.set(v.id, id);
    data.verts.push({ id, p: add(v.pos, offset) });
    data.wireEdges.push(v.id < id ? [v.id, id] : [id, v.id]);
  }
  return { mesh: rebuild(data), vertMap };
}

// -----------------------------------------------------------------------------------------------

/** Edge-connected groups of the given faces. */
export function regions(faces: readonly Face[]): Face[][] {
  const inSet = new Set(faces);
  const seen = new Set<Face>();
  const out: Face[][] = [];
  for (const start of faces) {
    if (seen.has(start)) continue;
    const group: Face[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const f = stack.pop()!;
      group.push(f);
      for (const h of f.halfEdges()) {
        const n = h.twin.face;
        if (n && inSet.has(n) && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    out.push(group);
  }
  return out;
}

/**
 * UVs at the ends of the edge a→b to continue from: those of the face across the edge (so the
 * wall's texture runs on from its neighbour), or else those of the face being extruded.
 */
function sourceUVs(h: HalfEdge): [Vec2, Vec2] | null {
  const t = h.twin;
  if (t.loop) return [[...t.next!.uv], [...t.uv]];
  if (h.loop) return [[...h.uv], [...h.next!.uv]];
  return null;
}

/** Corners of a wall quad [a, b, b', a'] with continued UVs, or a planar projection. */
function cornersWithUVs(ids: VertId[], pts: Vec3[], src: [Vec2, Vec2] | null, offset: ReadonlyVec3): Corner[] {
  const cont = src ? wallUVs(pts[0]!, pts[1]!, src[0], src[1], offset) : null;
  const uvs: Vec2[] = cont && src ? [src[0], src[1], cont[0], cont[1]] : projectUVs(pts);
  return ids.map((v, i) => ({ v, uv: uvs[i]! }));
}

export function reverseLoop(loop: Corner[]): Corner[] {
  return [...loop].reverse();
}

/** Remove vertices no face or wire edge refers to any more. */
export function dropUnusedVerts(data: MeshData): void {
  const used = new Set<VertId>();
  for (const f of data.faces) for (const l of f.loops) for (const c of l) used.add(c.v);
  for (const [a, b] of data.wireEdges) {
    used.add(a);
    used.add(b);
  }
  data.verts = data.verts.filter((v) => used.has(v.id));
  data.softEdges = data.softEdges.filter(([a, b]) => used.has(a) && used.has(b));
}

/**
 * Rebuild (and so validate) a mesh from edited data. Soft-edge entries for edges that no longer
 * exist are dropped.
 */
export function rebuild(data: MeshData): HalfEdgeMesh {
  data.verts.sort((a, b) => a.id - b.id);
  data.faces.sort((a, b) => a.id - b.id);
  const edges = new Set(data.wireEdges.map(([a, b]) => edgeKey(a, b)));
  for (const f of data.faces) for (const l of f.loops) l.forEach((c, i) => edges.add(edgeKey(c.v, l[(i + 1) % l.length]!.v)));
  const soft = new Set<string>();
  data.softEdges = data.softEdges.filter(([a, b]) => {
    const k = edgeKey(a, b);
    if (!edges.has(k) || soft.has(k)) return false;
    soft.add(k);
    return true;
  });
  try {
    return fromMeshData(data);
  } catch (e) {
    throw new MeshError(`The result would be invalid geometry (${(e as Error).message})`);
  }
}
