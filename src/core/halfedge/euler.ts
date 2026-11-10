import {
  dot,
  lerp2,
  lerp3,
  newellNormal,
  normalize,
  planeBasis,
  pointInPolygon2D,
  type ReadonlyVec3,
  type Vec2,
} from '../math/vec';
import type { FaceId, VertId } from '../meshdata';
import { isPlanar } from '../planarity';
import { faceUVFunction } from '../uv/continue';
import { type CornerInput, type Edge, type Face, type HalfEdgeMesh, type Loop, MeshError, type Vertex } from './mesh';

/**
 * Higher-level topological operators, built on HalfEdgeMesh.addFace/removeFace. Faces are
 * small, so rebuilding the affected faces keeps every pointer update in the one validated
 * primitive. Each operator checks its preconditions first and rolls back if a rebuild fails,
 * so a thrown MeshError leaves the mesh unchanged.
 */

interface Corner {
  v: Vertex;
  uv: Vec2;
}

interface FaceSnapshot {
  id: FaceId;
  material: number;
  loops: Corner[][];
}

function loopCorners(loop: Loop): Corner[] {
  return Array.from(loop.halfEdges(), (h) => ({ v: h.origin, uv: [h.uv[0], h.uv[1]] as Vec2 }));
}

function snapshotFace(face: Face): FaceSnapshot {
  return { id: face.id, material: face.material, loops: face.loops.map(loopCorners) };
}

function restoreFace(mesh: HalfEdgeMesh, s: FaceSnapshot): Face {
  return mesh.addFace(s.loops, s.material, s.id);
}

/**
 * Remove `faces`, run `rebuild`, and on failure undo whatever `rebuild` added and restore
 * the original faces.
 */
function rebuildFaces<T>(mesh: HalfEdgeMesh, faces: Face[], rebuild: () => T): T {
  const snaps = faces.map(snapshotFace);
  const edgesBefore = new Set(mesh.edges());
  const wireBefore = [...edgesBefore].filter((e) => e.isWire).map((e) => e.verts);
  for (const f of faces) mesh.removeFace(f);
  const facesBefore = new Set(mesh.faces.keys());
  const vertsBefore = new Set(mesh.verts.keys());
  try {
    return rebuild();
  } catch (err) {
    for (const [id, f] of [...mesh.faces]) if (!facesBefore.has(id)) mesh.removeFace(f);
    for (const s of snaps) restoreFace(mesh, s);
    for (const e of [...mesh.edges()]) if (e.isWire && !edgesBefore.has(e)) mesh.removeEdge(e);
    for (const [a, b] of wireBefore) if (!mesh.findEdge(a, b)) mesh.addEdge(a, b);
    for (const [id, v] of [...mesh.verts]) if (!vertsBefore.has(id) && v.out.length === 0) mesh.removeVertex(v);
    throw err;
  }
}

/** Project a face's loops into 2D on the plane of its outer loop. */
function projector(outer: readonly ReadonlyVec3[]): (p: ReadonlyVec3) => Vec2 {
  const n = normalize(newellNormal(outer));
  const { u, v } = planeBasis(n[0] === 0 && n[1] === 0 && n[2] === 0 ? [0, 0, 1] : n);
  return (p) => [dot(p, u), dot(p, v)];
}

// -----------------------------------------------------------------------------------------------
// splitEdge
// -----------------------------------------------------------------------------------------------

/**
 * Insert a new vertex on an edge at parameter t (0 = edge.he.origin, 1 = edge.he.dest).
 * Both adjacent faces gain the corner, with UVs interpolated per face.
 */
export function splitEdge(mesh: HalfEdgeMesh, edge: Edge, t = 0.5, id?: VertId): Vertex {
  const [a, b] = edge.verts;
  if (mesh.findEdge(a, b) !== edge) throw new MeshError('Edge does not belong to this mesh');
  if (id !== undefined && mesh.verts.has(id)) throw new MeshError(`Vertex id ${id} already in use`);
  const pos = lerp3(a.pos, b.pos, t);
  const faces = edge.faces();

  // New corner lists for each adjacent face, computed before anything changes.
  const plans = faces.map((f) => {
    const snap = snapshotFace(f);
    const loops = snap.loops.map((loop) => {
      const out: (Corner | { v: null; uv: Vec2 })[] = [];
      loop.forEach((c, i) => {
        out.push(c);
        const n = loop[(i + 1) % loop.length]!;
        if ((c.v === a && n.v === b) || (c.v === b && n.v === a)) {
          const local = c.v === a ? t : 1 - t;
          out.push({ v: null, uv: lerp2(c.uv, n.uv, local) });
        }
      });
      return out;
    });
    return { snap, loops };
  });

  const hard = edge.hard;
  return rebuildFaces(mesh, faces, () => {
    mesh.removeEdge(edge);
    const v = mesh.addVertex(pos, id);
    if (faces.length === 0) {
      mesh.addEdge(a, v);
      mesh.addEdge(v, b);
    }
    for (const { snap, loops } of plans) {
      mesh.addFace(
        loops.map((loop) => loop.map((c) => ({ v: c.v ?? v, uv: c.uv }))),
        snap.material,
        snap.id,
      );
    }
    // Both halves keep the original edge's hardness.
    mesh.findEdge(a, v)!.hard = hard;
    mesh.findEdge(v, b)!.hard = hard;
    return v;
  });
}

// -----------------------------------------------------------------------------------------------
// splitFace
// -----------------------------------------------------------------------------------------------

/**
 * Split a face by connecting two vertices of its outer loop with a new edge, or with a chain of
 * new edges through `path` (points inside the face, in its plane, going from `va` to `vb`).
 * The original face keeps its id and the side running from `va` to `vb`; the other side becomes
 * a new face. Holes go to whichever side contains them. Path corners get UVs that continue the
 * face's texture. Without a path the vertices must not be adjacent.
 */
export function splitFace(
  mesh: HalfEdgeMesh,
  face: Face,
  va: Vertex,
  vb: Vertex,
  newFaceId: FaceId = mesh.nextFaceId,
  path: readonly ReadonlyVec3[] = [],
): [Face, Face] {
  if (mesh.faces.get(face.id) !== face) throw new MeshError(`Face ${face.id} does not belong to this mesh`);
  if (mesh.faces.has(newFaceId)) throw new MeshError(`Face id ${newFaceId} already in use`);
  const snap = snapshotFace(face);
  const outer = snap.loops[0]!;
  const i = outer.findIndex((c) => c.v === va);
  const j = outer.findIndex((c) => c.v === vb);
  if (i < 0 || j < 0) throw new MeshError('Both vertices must be on the outer loop of the face');
  const n = outer.length;
  if (i === j) throw new MeshError('Vertices must be distinct');
  if (!path.length) {
    if ((i + 1) % n === j || (j + 1) % n === i) throw new MeshError('Vertices must be distinct and not adjacent');
    if (mesh.findEdge(va, vb)) throw new MeshError(`Edge ${va.id}-${vb.id} already exists`);
  } else if (!isPlanar([...snap.loops.flat().map((c) => c.v.pos), ...path])) {
    throw new MeshError('The path must lie in the plane of the face');
  }

  const side = (from: number, to: number): Corner[] => {
    const out: Corner[] = [];
    for (let k = from; ; k = (k + 1) % n) {
      out.push(outer[k]!);
      if (k === to) break;
    }
    return out;
  };
  // Path corners: placeholders until the vertices exist (inside the rebuild, so a failure
  // removes them again). UVs continue the face's mapping.
  const uvMap = path.length ? faceUVFunction(outer.map((c) => c.v.pos), outer.map((c) => c.uv)) : null;
  const pathUV = path.map((p) => uvMap!(p));
  const pathVerts: Vertex[] = [];
  const pathCorners = (reverse: boolean): Corner[] => {
    const cs = pathVerts.map((v, k) => ({ v, uv: pathUV[k]! }));
    return reverse ? cs.reverse() : cs;
  };
  const sideA = side(i, j);
  const sideB = side(j, i);

  // Distribute holes by containment.
  const proj = projector(outer.map((c) => c.v.pos));
  const polyA = [...sideA.map((c) => proj(c.v.pos)), ...[...path].reverse().map(proj)];
  const holesA: Corner[][] = [];
  const holesB: Corner[][] = [];
  for (const hole of snap.loops.slice(1)) {
    const inside = hole.map((c) => pointInPolygon2D(proj(c.v.pos), polyA));
    if (inside.every((x) => x)) holesA.push(hole);
    else if (inside.every((x) => !x)) holesB.push(hole);
    else throw new MeshError('The new edge would cross a hole');
  }

  return rebuildFaces(mesh, [face], () => {
    for (const p of path) pathVerts.push(mesh.addVertex([p[0], p[1], p[2]]));
    const loopA = [...sideA, ...pathCorners(true)];
    const loopB = [...sideB, ...pathCorners(false)];
    const fa = mesh.addFace([loopA, ...holesA], snap.material, snap.id);
    const fb = mesh.addFace([loopB, ...holesB], snap.material, newFaceId);
    return [fa, fb];
  });
}

// -----------------------------------------------------------------------------------------------
// joinFaces
// -----------------------------------------------------------------------------------------------

/**
 * Dissolve an edge shared by two different faces, merging them into one. The face on the
 * `edge.he` side keeps its id, material and UVs at the edge's endpoints. Both sides must be
 * outer loops, and the faces must share only this edge.
 */
export function joinFaces(mesh: HalfEdgeMesh, edge: Edge): Face {
  const h = edge.he;
  const t = h.twin;
  const f1 = h.face;
  const f2 = t.face;
  if (!f1 || !f2) throw new MeshError('Edge must have a face on both sides');
  if (f1 === f2) throw new MeshError('Edge has the same face on both sides');
  if (h.loop !== f1.outer || t.loop !== f2.outer) throw new MeshError('Both sides must be outer loops');

  let shared = 0;
  for (const x of f1.outer.halfEdges()) if (x.twin.face === f2) shared++;
  if (shared !== 1) throw new MeshError(`Faces share ${shared} edges; expected exactly 1`);

  // f1 from h.next (corner at b) around to h (corner at a): [b, ..., a]
  // f2 from t.next (corner at a) around to t (corner at b): [a, ..., b]; drop both ends.
  const walk = (start: typeof h, end: typeof h): Corner[] => {
    const out: Corner[] = [];
    let x = start;
    for (;;) {
      out.push({ v: x.origin, uv: [x.uv[0], x.uv[1]] });
      if (x === end) break;
      x = x.next!;
    }
    return out;
  };
  const merged = [...walk(h.next!, h), ...walk(t.next!, t).slice(1, -1)];
  if (new Set(merged.map((c) => c.v)).size !== merged.length) {
    throw new MeshError('Faces also touch at a vertex; merging would repeat it');
  }
  if (!isPlanar([...f1.halfEdges(), ...f2.halfEdges()].map((x) => x.origin.pos))) {
    throw new MeshError('Faces are not coplanar');
  }
  const holes = [...f1.holes, ...f2.holes].map(loopCorners);
  const material = f1.material;
  const id = f1.id;

  return rebuildFaces(mesh, [f1, f2], () => {
    mesh.removeEdge(edge);
    return mesh.addFace([merged, ...holes], material, id);
  });
}

// -----------------------------------------------------------------------------------------------
// Holes
// -----------------------------------------------------------------------------------------------

export interface AddHoleResult {
  hole: Loop;
  /** The face filling the hole, when `fill` was requested. */
  fill: Face | null;
}

/**
 * Cut a hole into a face, bounded by vertices not already in the face. Pass the corners in either
 * winding; they are reoriented to wind opposite to the face. With `fill`, a new face is created
 * inside the hole (as when drawing a shape on a face in SketchUp).
 */
export function addHole(
  mesh: HalfEdgeMesh,
  face: Face,
  corners: readonly CornerInput[],
  opts: { fill?: boolean; fillId?: FaceId } = {},
): AddHoleResult {
  if (mesh.faces.get(face.id) !== face) throw new MeshError(`Face ${face.id} does not belong to this mesh`);
  const snap = snapshotFace(face);
  const inFace = new Set(snap.loops.flat().map((c) => c.v));
  if (corners.some((c) => inFace.has(c.v))) throw new MeshError('Hole vertices must not already be in the face');

  let hole: Corner[] = corners.map((c) => ({ v: c.v, uv: c.uv ? [c.uv[0], c.uv[1]] : [0, 0] }));
  if (!isPlanar([...snap.loops.flat(), ...hole].map((c) => c.v.pos))) {
    throw new MeshError('Hole vertices must lie in the plane of the face');
  }
  const faceN = newellNormal(snap.loops[0]!.map((c) => c.v.pos));
  const holeN = newellNormal(hole.map((c) => c.v.pos));
  if (dot(faceN, holeN) > 0) hole = hole.reverse();

  return rebuildFaces(mesh, [face], () => {
    const f = mesh.addFace([...snap.loops, hole], snap.material, snap.id);
    const holeLoop = f.holes[f.holes.length - 1]!;
    const fill = opts.fill ? mesh.addFace([[...hole].reverse()], snap.material, opts.fillId) : null;
    return { hole: holeLoop, fill };
  });
}

/**
 * Create a face filling a hole of `face`. The new face winds opposite to the hole and copies
 * its UVs.
 */
export function fillHole(mesh: HalfEdgeMesh, face: Face, hole: Loop, id?: FaceId): Face {
  if (hole.face !== face || !face.holes.includes(hole)) throw new MeshError('Loop is not a hole of this face');
  const corners = loopCorners(hole).reverse();
  return mesh.addFace([corners], face.material, id);
}

/**
 * Remove a hole from a face, so the face covers that area. The hole must be open (no face
 * filling it). Hole edges left as wire edges, and vertices left isolated, are deleted.
 */
export function removeHole(mesh: HalfEdgeMesh, face: Face, hole: Loop): void {
  if (hole.face !== face || !face.holes.includes(hole)) throw new MeshError('Loop is not a hole of this face');
  for (const h of hole.halfEdges()) {
    if (!h.twin.isBoundary) throw new MeshError('Hole is filled by another face; remove or join that face first');
  }
  const snap = snapshotFace(face);
  const holeIndex = face.holes.indexOf(hole) + 1;
  const holeVerts = snap.loops[holeIndex]!.map((c) => c.v);
  const loops = snap.loops.filter((_, i) => i !== holeIndex);

  rebuildFaces(mesh, [face], () => mesh.addFace(loops, snap.material, snap.id));

  for (let i = 0; i < holeVerts.length; i++) {
    const e = mesh.findEdge(holeVerts[i]!, holeVerts[(i + 1) % holeVerts.length]!);
    if (e?.isWire) mesh.removeEdge(e);
  }
  for (const v of holeVerts) if (v.out.length === 0) mesh.removeVertex(v);
}
