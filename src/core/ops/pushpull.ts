import { addHole, joinFaces } from '../halfedge/euler';
import { type Face, type HalfEdgeMesh, MeshError, type Vertex } from '../halfedge/mesh';
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from '../math/vec';
import type { FaceId } from '../meshdata';
import { isFacePlanar, isPlanar } from '../planarity';
import { dissolveVertex } from './dissolve';
import { faceUVMap } from '../uv/continue';
import { type ExtrudeOptions, extrudeFaces, regions } from './extrude';
import { faceContains } from './faces';

/**
 * SketchUp-style Push/Pull: move faces along their normal, building side walls.
 *
 * - Selected faces are grouped into edge-connected, coplanar groups; each group moves along its
 *   own normal by `distance` (negative pushes inward).
 * - **Stretch:** if every face around a group is perpendicular to it (the top of a box), the
 *   group's vertices just move, so the box gets taller or shorter instead of growing new faces.
 * - Otherwise the group is extruded. Walls that end up coplanar with, and facing the same way as,
 *   the face beyond their base edge are merged into it, and leftover straight-through vertices
 *   are dissolved.
 * - **Push through:** a group pushed inward until it lies flat against an opposite-facing face
 *   cuts a hole through that face (a tunnel), as in SketchUp.
 */

export interface PushPullResult {
  mesh: HalfEdgeMesh;
  /** Ids of the pushed faces that still exist (a face pushed all the way through is gone). */
  faces: FaceId[];
}

const PERP_EPS = 1e-6;

export function pushPull(
  mesh: HalfEdgeMesh,
  faceIds: Iterable<FaceId>,
  distance: number,
  opts: ExtrudeOptions = {},
): PushPullResult {
  const ids = [...new Set(faceIds)];
  if (!ids.length) throw new MeshError('No faces to push or pull');
  if (Math.abs(distance) < 1e-9) return { mesh, faces: ids };
  const selected = new Set(ids);

  let current = mesh;
  for (const groupIds of coplanarGroups(mesh, ids)) {
    const group = groupIds.map((id) => current.face(id));
    const n = groupNormal(group);
    const offset = scale(n, distance);
    if (tryStretch(current, group, offset, opts.textureLock ?? true)) continue;

    const before = new Set(current.faces.keys());
    const baseVerts = new Set<Vertex>();
    for (const f of group) for (const h of f.halfEdges()) baseVerts.add(h.origin);
    const baseIds = [...baseVerts].map((v) => v.id);

    current = extrudeFaces(current, groupIds, offset, opts).mesh;
    const walls = [...current.faces.values()].filter((f) => !before.has(f.id));
    if (distance < 0) pushThrough(current, groupIds, walls);
    mergeWalls(current, walls, selected);
    dissolveStraightVerts(
      current,
      baseIds.map((id) => current.verts.get(id)).filter((v): v is Vertex => !!v),
    );
  }
  return { mesh: current, faces: ids.filter((id) => current.faces.has(id)) };
}

/** Group faces that are edge-connected and coplanar with the same facing. */
function coplanarGroups(mesh: HalfEdgeMesh, ids: FaceId[]): FaceId[][] {
  const out: FaceId[][] = [];
  for (const region of regions(ids.map((id) => mesh.face(id)))) {
    const left = new Set(region);
    while (left.size) {
      const seed = left.values().next().value!;
      const n = seed.normal();
      const group: Face[] = [];
      const stack = [seed];
      left.delete(seed);
      while (stack.length) {
        const f = stack.pop()!;
        group.push(f);
        for (const h of f.halfEdges()) {
          const g = h.twin.face;
          if (!g || !left.has(g)) continue;
          if (dot(g.normal(), n) > 1 - PERP_EPS && isPlanar([...f.outer.positions(), ...g.outer.positions()])) {
            left.delete(g);
            stack.push(g);
          }
        }
      }
      out.push(group.map((f) => f.id));
    }
  }
  return out;
}

function groupNormal(group: Face[]): Vec3 {
  return normalize(group.reduce<Vec3>((s, f) => add(s, f.normal()), [0, 0, 0]));
}

/**
 * Move the group's vertices if every other face touching them is perpendicular to the move (so
 * those faces simply stretch). Returns false, changing nothing, when that doesn't apply. With
 * texture lock, the stretched faces' UVs are extended rather than stretched: the moved corners
 * get UVs from each face's existing mapping.
 */
function tryStretch(mesh: HalfEdgeMesh, group: Face[], offset: Vec3, textureLock: boolean): boolean {
  const inGroup = new Set(group);
  const verts = new Set<Vertex>();
  for (const f of group) for (const h of f.halfEdges()) verts.add(h.origin);
  const dir = normalize(offset);
  const touching = new Set<Face>();
  for (const v of verts) {
    for (const h of v.out) {
      // An open edge leaving the group would need a wall.
      if (inGroup.has(h.face!) && !h.twin.face) return false;
      if (inGroup.has(h.twin.face!) && !h.face) return false;
      if (h.face && !inGroup.has(h.face)) touching.add(h.face);
    }
    if (v.out.some((h) => h.edge.isWire)) return false;
  }
  if (!touching.size) return false;
  for (const f of touching) if (Math.abs(dot(f.normal(), dir)) > PERP_EPS) return false;

  const maps = textureLock
    ? [...touching].map((f) => {
        const hs = [...f.halfEdges()];
        return { hs, map: faceUVMap(hs.map((h) => h.origin.pos), hs.map((h) => h.uv)) };
      })
    : [];
  const before = new Map([...verts].map((v) => [v, v.pos] as const));
  for (const v of verts) v.pos = add(v.pos, offset);
  if (![...touching].every(isFacePlanar)) {
    for (const [v, p] of before) v.pos = p;
    return false;
  }
  for (const { hs, map } of maps) {
    if (map) for (const h of hs) if (verts.has(h.origin)) h.uv = map(h.origin.pos);
  }
  return true;
}

/**
 * A pushed face now lying flat against an opposite-facing face, inside its outline, is removed
 * and becomes a hole in that face: the walls form a tunnel through the solid.
 */
function pushThrough(mesh: HalfEdgeMesh, groupIds: FaceId[], walls: Face[]): void {
  const exclude = new Set<Face>(walls);
  for (const id of groupIds) {
    const top = mesh.faces.get(id);
    if (!top) continue;
    exclude.add(top);
    const n = top.normal();
    const pts = top.outer.positions();
    const topVerts = new Set(top.outer.verts());
    for (const other of mesh.faces.values()) {
      if (exclude.has(other) || dot(other.normal(), n) > -1 + PERP_EPS) continue;
      if ([...other.halfEdges()].some((h) => topVerts.has(h.origin))) continue;
      if (!isPlanar([...other.outer.positions(), ...pts])) continue;
      if (!faceContains(other, pts)) continue;
      // The hole continues the texture of the face it's cut into.
      const map = faceUVMap(
        [...other.halfEdges()].map((h) => h.origin.pos),
        [...other.halfEdges()].map((h) => h.uv),
      );
      const corners = Array.from(top.outer.halfEdges(), (h) => ({ v: h.origin, uv: map?.(h.origin.pos) ?? h.uv }));
      mesh.removeFace(top);
      addHole(mesh, other, corners);
      break;
    }
  }
}

/** Merge each wall into the face across its base edge when they're coplanar and face the same way. */
function mergeWalls(mesh: HalfEdgeMesh, walls: Face[], selected: ReadonlySet<FaceId>): void {
  for (const wall of walls) {
    if (mesh.faces.get(wall.id) !== wall) continue;
    for (const h of wall.outer.halfEdges()) {
      const other = h.twin.face;
      if (!other || other === wall || selected.has(other.id) || walls.includes(other)) continue;
      if (dot(other.normal(), wall.normal()) < 1 - PERP_EPS) continue;
      if (!isPlanar([...other.outer.positions(), ...wall.outer.positions()])) continue;
      try {
        joinFaces(mesh, h.edge);
      } catch {
        // Leave the crease when the faces can't be joined (e.g. they touch twice).
      }
      break;
    }
  }
}

/** Dissolve vertices left in the middle of a straight run of two edges. */
function dissolveStraightVerts(mesh: HalfEdgeMesh, verts: Vertex[]): void {
  for (const v of verts) {
    if (mesh.verts.get(v.id) !== v || v.out.length !== 2) continue;
    const [p, q] = v.out.map((h) => normalize(sub(h.dest.pos, v.pos)));
    if (length(cross(p!, q!)) > 1e-6 || dot(p!, q!) > 0) continue;
    try {
      dissolveVertex(mesh, v);
    } catch {
      // Keep it.
    }
  }
}
