import { addHole, splitEdge, splitFace } from '../halfedge/euler';
import { type Edge, type Face, type HalfEdgeMesh, MeshError, type Vertex } from '../halfedge/mesh';
import {
  dot,
  length,
  lerp3,
  newellNormal,
  normalize,
  planeBasis,
  pointInPolygon2D,
  type ReadonlyVec2,
  type ReadonlyVec3,
  sub,
  type Vec2,
  type Vec3,
} from '../math/vec';
import type { FaceId, MaterialId, MeshData } from '../meshdata';
import { isPlanar, planarTolerance } from '../planarity';
import { triangulateFace } from '../triangulate';
import { faceUVFunction, projectUVs } from '../uv/continue';

/**
 * Drawing on faces (Line and Rectangle tools). Drawn shapes are lists of points in the mesh's
 * local space. A closed shape inside a face becomes a hole filled by a new face; a line or shape
 * that runs from the face's edge to its edge splits the face. A shape that isn't on any face
 * becomes a new single-face mesh (`loopMeshData`). Everything here edits the mesh in place; on a
 * thrown error the caller discards the (possibly partly edited) copy.
 */

/** Where a point lies relative to a face. */
export type FaceLocation =
  | { kind: 'vertex'; v: Vertex }
  /** On an outer-loop edge, at parameter t from `edge.he.origin`. */
  | { kind: 'edge'; edge: Edge; t: number }
  | { kind: 'inside' }
  /** On the edge of one of the face's holes. */
  | { kind: 'hole' }
  | { kind: 'outside' }
  | { kind: 'offplane' };

const isBoundary = (l: FaceLocation): boolean => l.kind === 'vertex' || l.kind === 'edge';

interface Frame {
  to2: (p: ReadonlyVec3) => Vec2;
  eps: number;
  outer: Vec2[];
  holes: Vec2[][];
}

function frameOf(face: Face): Frame {
  const { u, v } = planeBasis(face.normal());
  const to2 = (p: ReadonlyVec3): Vec2 => [dot(p, u), dot(p, v)];
  return {
    to2,
    eps: planarTolerance(face.loops.flatMap((l) => l.positions())),
    outer: face.outer.positions().map(to2),
    holes: face.holes.map((l) => l.positions().map(to2)),
  };
}

/** Closest point on segment a-b: parameter t in [0, 1] and distance. */
function onSegment(p: ReadonlyVec3, a: ReadonlyVec3, b: ReadonlyVec3): { t: number; d: number } {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / len2)) : 0;
  return { t, d: length(sub(p, lerp3(a, b, t))) };
}

export function locateOnFace(face: Face, p: ReadonlyVec3): FaceLocation {
  const f = frameOf(face);
  if (Math.abs(dot(sub(p, face.outer.he.origin.pos), face.normal())) > f.eps) return { kind: 'offplane' };
  const outer = [...face.outer.halfEdges()];
  for (const h of outer) if (length(sub(p, h.origin.pos)) <= f.eps) return { kind: 'vertex', v: h.origin };
  for (const h of outer) {
    const s = onSegment(p, h.origin.pos, h.dest.pos);
    if (s.d <= f.eps) return { kind: 'edge', edge: h.edge, t: h.edge.he === h ? s.t : 1 - s.t };
  }
  for (const hole of face.holes) {
    for (const h of hole.halfEdges()) if (onSegment(p, h.origin.pos, h.dest.pos).d <= f.eps) return { kind: 'hole' };
  }
  const q = f.to2(p);
  if (!pointInPolygon2D(q, f.outer) || f.holes.some((h) => pointInPolygon2D(q, h))) return { kind: 'outside' };
  return { kind: 'inside' };
}

// --- 2D segment tests ----------------------------------------------------------------------------

const orient = (a: ReadonlyVec2, b: ReadonlyVec2, c: ReadonlyVec2): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** The open segments a-b and c-d cross at a single interior point of both. */
function properCross(a: ReadonlyVec2, b: ReadonlyVec2, c: ReadonlyVec2, d: ReadonlyVec2, eps: number): boolean {
  const lab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const lcd = Math.hypot(d[0] - c[0], d[1] - c[1]);
  const o1 = orient(a, b, c) / lab;
  const o2 = orient(a, b, d) / lab;
  const o3 = orient(c, d, a) / lcd;
  const o4 = orient(c, d, b) / lcd;
  return ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps));
}

function dist2D(p: ReadonlyVec2, a: ReadonlyVec2, b: ReadonlyVec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** The segments cross or touch. */
function segmentsMeet(a: ReadonlyVec2, b: ReadonlyVec2, c: ReadonlyVec2, d: ReadonlyVec2, eps: number): boolean {
  return (
    properCross(a, b, c, d, eps) ||
    dist2D(a, c, d) <= eps ||
    dist2D(b, c, d) <= eps ||
    dist2D(c, a, b) <= eps ||
    dist2D(d, a, b) <= eps
  );
}

/** No two non-adjacent segments of the polyline (or polygon, if `closed`) meet. */
export function isSimple2D(pts: readonly ReadonlyVec2[], closed: boolean, eps: number): boolean {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= eps) return false;
    for (let j = i + 2; j < segs; j++) {
      if (closed && i === 0 && j === segs - 1) continue; // the closing segment meets the first
      if (segmentsMeet(a, b, pts[j]!, pts[(j + 1) % n]!, eps)) return false;
    }
  }
  return true;
}

/** Drop consecutive duplicate points (and a closing point equal to the first, for loops). */
export function cleanPoints(pts: readonly ReadonlyVec3[], closed: boolean, eps = 1e-9): Vec3[] {
  const out: Vec3[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || length(sub(p, last)) > eps) out.push([p[0], p[1], p[2]]);
  }
  if (closed && out.length > 1 && length(sub(out[0]!, out[out.length - 1]!)) <= eps) out.pop();
  return out;
}

/**
 * Check that a path (or closed shape) drawn on a face stays on it: no segment crosses the face's
 * edges or holes, no part runs outside it, and it doesn't cross itself.
 */
function checkOnFace(face: Face, pts: readonly Vec3[], closed: boolean): void {
  const f = frameOf(face);
  const p2 = pts.map(f.to2);
  const n = pts.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = p2[i]!;
    const b = p2[(i + 1) % n]!;
    for (const loop of [f.outer, ...f.holes]) {
      for (let k = 0; k < loop.length; k++) {
        if (properCross(a, b, loop[k]!, loop[(k + 1) % loop.length]!, f.eps)) {
          throw new MeshError('The line crosses the edge of the face');
        }
      }
    }
    for (const s of [0.25, 0.5, 0.75]) {
      const loc = locateOnFace(face, lerp3(pts[i]!, pts[(i + 1) % n]!, s));
      if (loc.kind === 'outside' || loc.kind === 'offplane') throw new MeshError('The line leaves the face');
      if (loc.kind === 'hole') throw new MeshError("Lines can't run along the edge of a hole");
    }
  }
  if (!isSimple2D(p2, closed, f.eps)) throw new MeshError('The shape crosses itself');
}

/** The vertex at a boundary point, splitting the edge it lies on if needed. */
function vertexAt(mesh: HalfEdgeMesh, faceId: FaceId, p: ReadonlyVec3): Vertex {
  const loc = locateOnFace(mesh.face(faceId), p);
  if (loc.kind === 'vertex') return loc.v;
  if (loc.kind === 'edge') return splitEdge(mesh, loc.edge, loc.t);
  throw new MeshError('The line must start and end on the edge of the face');
}

/** The segment a-b runs along the face's edge (so drawing it adds nothing). */
function alongBoundary(face: Face, a: ReadonlyVec3, b: ReadonlyVec3): boolean {
  return isBoundary(locateOnFace(face, lerp3(a, b, 0.5)));
}

/**
 * Split a face along a path from a point on its outer edge, through points inside it, to another
 * point on its outer edge. Returns the two resulting faces (the original id first), or [] when
 * the path only runs along existing edges.
 */
export function drawPathOnFace(mesh: HalfEdgeMesh, faceId: FaceId, points: readonly ReadonlyVec3[]): FaceId[] {
  const pts = cleanPoints(points, false);
  if (pts.length < 2) throw new MeshError('A line needs two different points');
  const face = mesh.face(faceId);
  const ends = [locateOnFace(face, pts[0]!), locateOnFace(face, pts[pts.length - 1]!)];
  if (!ends.every(isBoundary)) throw new MeshError('A line across a face must start and end on its outer edge');
  for (const p of pts.slice(1, -1)) {
    if (locateOnFace(face, p).kind !== 'inside') throw new MeshError('The line leaves the face');
  }
  checkOnFace(face, pts, false);
  if (pts.length === 2 && alongBoundary(face, pts[0]!, pts[1]!)) return [];

  const va = vertexAt(mesh, faceId, pts[0]!);
  const vb = vertexAt(mesh, faceId, pts[pts.length - 1]!);
  if (va === vb) throw new MeshError('The line must end at a different point than it starts');
  const newId = mesh.nextFaceId;
  splitFace(mesh, mesh.face(faceId), va, vb, newId, pts.slice(1, -1));
  return [faceId, newId];
}

export interface DrawResult {
  /** Every face the shape now covers part of, or that it split off. */
  faces: FaceId[];
  /** The faces inside the drawn shape. */
  inner: FaceId[];
}

/**
 * Draw a closed shape on a face. Entirely inside: it becomes a hole in the face, filled by a new
 * face. Touching the face's outer edge at two or more points: the face is split along each part of
 * the shape that runs through its inside.
 */
export function drawLoopOnFace(mesh: HalfEdgeMesh, faceId: FaceId, points: readonly ReadonlyVec3[]): DrawResult {
  const loop = cleanPoints(points, true);
  if (loop.length < 3) throw new MeshError('A shape needs at least three points');
  const face = mesh.face(faceId);
  const locs = loop.map((p) => locateOnFace(face, p));
  if (locs.some((l) => l.kind === 'outside' || l.kind === 'offplane')) throw new MeshError('The shape is not inside the face');
  if (locs.some((l) => l.kind === 'hole')) throw new MeshError("Shapes can't touch the edge of a hole");
  checkOnFace(face, loop, true);
  const f = frameOf(face);
  const poly = loop.map(f.to2);
  const insideShape = (fid: FaceId): boolean => pointInPolygon2D(f.to2(interiorPoint(mesh.face(fid))), poly);

  const touching = locs.map(isBoundary);
  const first = touching.indexOf(true);
  if (first < 0) {
    for (const hole of face.holes) {
      if (hole.positions().some((p) => pointInPolygon2D(f.to2(p), poly))) throw new MeshError('The shape would surround a hole');
    }
    const hes = [...face.outer.halfEdges()];
    const uv = faceUVFunction(
      hes.map((h) => h.origin.pos),
      hes.map((h) => h.uv),
    );
    const verts = loop.map((p) => mesh.addVertex([p[0], p[1], p[2]]));
    try {
      const { fill } = addHole(mesh, face, verts.map((v) => ({ v, uv: uv(v.pos) })), { fill: true });
      return { faces: [faceId, fill!.id], inner: [fill!.id] };
    } catch (e) {
      for (const v of verts) if (v.out.length === 0) mesh.removeVertex(v);
      throw e;
    }
  }
  if (touching.filter(Boolean).length === 1) throw new MeshError("A shape touching the face's edge at one point can't cut it");

  // Walk the shape from a boundary point, cutting along each stretch between boundary points.
  const n = loop.length;
  const family: FaceId[] = [faceId];
  let path: Vec3[] = [loop[first]!];
  for (let k = 1; k <= n; k++) {
    const i = (first + k) % n;
    path.push(loop[i]!);
    if (!touching[i]) continue;
    cutAlong(mesh, family, path);
    path = [loop[i]!];
  }
  return { faces: family, inner: family.filter(insideShape) };
}

/** Split whichever face of `family` the path crosses; add the new face to the family. */
function cutAlong(mesh: HalfEdgeMesh, family: FaceId[], path: Vec3[]): void {
  const a = path[0]!;
  const b = path[1]!;
  for (const id of family) {
    const face = mesh.face(id);
    if (path.length === 2 && alongBoundary(face, a, b)) return;
  }
  const mid = lerp3(a, b, 0.5);
  const id = family.find((fid) => locateOnFace(mesh.face(fid), mid).kind === 'inside');
  if (id === undefined) throw new MeshError('The shape is not inside the face');
  const made = drawPathOnFace(mesh, id, path);
  for (const fid of made) if (!family.includes(fid)) family.push(fid);
}

/** A point strictly inside a face (the centroid of its first triangle). */
function interiorPoint(face: Face): Vec3 {
  const { corners, indices } = triangulateFace(face);
  const [i, j, k] = [indices[0]!, indices[1]!, indices[2]!].map((x) => corners[x]!.origin.pos) as [Vec3, Vec3, Vec3];
  return [(i[0] + j[0] + k[0]) / 3, (i[1] + j[1] + k[1]) / 3, (i[2] + j[2] + k[2]) / 3];
}

/**
 * The face a drawn shape lies on: every point and segment midpoint is in its plane and on or
 * inside it, and some part runs through its inside. Null if there is none.
 */
export function faceUnder(mesh: HalfEdgeMesh, points: readonly ReadonlyVec3[], closed: boolean): Face | null {
  const pts = cleanPoints(points, closed);
  if (pts.length < 2) return null;
  const n = pts.length;
  const samples = [...pts];
  for (let i = 0; i < (closed ? n : n - 1); i++) samples.push(lerp3(pts[i]!, pts[(i + 1) % n]!, 0.5));
  for (const face of mesh.faces.values()) {
    const locs = samples.map((p) => locateOnFace(face, p));
    if (locs.some((l) => l.kind === 'offplane' || l.kind === 'outside')) continue;
    if (locs.some((l) => l.kind === 'inside')) return face;
  }
  return null;
}

/**
 * A single-face mesh from a closed, planar, non-self-crossing shape, wound so that its normal
 * points along `up` (or as close to it as the shape allows). UVs are a world-space projection.
 */
export function loopMeshData(points: readonly ReadonlyVec3[], up: ReadonlyVec3, material: MaterialId = 0): MeshData {
  const loop = cleanPoints(points, true);
  if (loop.length < 3) throw new MeshError('A face needs at least three points');
  if (!isPlanar(loop)) throw new MeshError('The points are not in one plane');
  const n = newellNormal(loop);
  if (length(n) < 1e-12) throw new MeshError('The shape has no area');
  const { u, v } = planeBasis(normalize(n));
  const eps = planarTolerance(loop);
  if (!isSimple2D(loop.map((p) => [dot(p, u), dot(p, v)] as Vec2), true, eps)) throw new MeshError('The shape crosses itself');
  const pts = dot(n, up) < 0 ? [...loop].reverse() : loop;
  const uvs = projectUVs(pts);
  return {
    verts: pts.map((p, id) => ({ id, p })),
    faces: [{ id: 0, material, loops: [pts.map((_, i) => ({ v: i, uv: uvs[i]! }))] }],
    wireEdges: [],
    softEdges: [],
    nextVertId: pts.length,
    nextFaceId: 1,
  };
}
