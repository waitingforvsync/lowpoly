import { fromMeshData, toMeshData } from '../halfedge/convert';
import { type HalfEdgeMesh, MeshError } from '../halfedge/mesh';
import type { ReadonlyVec3, Vec3 } from '../math/vec';
import type { Corner, MeshData, VertId } from '../meshdata';
import { planarizeAround } from './planarize';

export interface MergeGroup {
  ids: VertId[];
  /** Where the merged vertex ends up. */
  pos: ReadonlyVec3;
}

/**
 * Weld groups of vertices together. Each group becomes its first vertex, moved to `pos`.
 * Faces lose corners that collapse onto each other, faces left with fewer than 3 corners are
 * dropped, and so are collapsed wire edges. Works on serialized data and rebuilds the half-edge
 * mesh, so the result is fully validated. Throws MeshError when the weld would produce invalid
 * topology (a pinched face or a non-manifold edge).
 */
export function mergeVertexGroups(mesh: HalfEdgeMesh, groups: MergeGroup[]): HalfEdgeMesh {
  const data = toMeshData(mesh);
  const remap = new Map<VertId, VertId>();
  const newPos = new Map<VertId, Vec3>();
  for (const g of groups) {
    const keep = g.ids[0];
    if (keep === undefined) continue;
    for (const id of g.ids) remap.set(id, keep);
    newPos.set(keep, [g.pos[0], g.pos[1], g.pos[2]]);
  }
  const to = (id: VertId) => remap.get(id) ?? id;

  const out: MeshData = {
    verts: data.verts
      .filter((v) => to(v.id) === v.id)
      .map((v) => ({ id: v.id, p: newPos.get(v.id) ?? v.p })),
    faces: [],
    wireEdges: [],
    softEdges: [],
    nextVertId: data.nextVertId,
    nextFaceId: data.nextFaceId,
  };

  for (const f of data.faces) {
    const loops: Corner[][] = [];
    let dropFace = false;
    f.loops.forEach((loop, li) => {
      const mapped = loop.map((c) => ({ v: to(c.v), uv: c.uv }));
      const collapsed = mapped.filter((c, i) => c.v !== mapped[(i + 1) % mapped.length]!.v);
      if (collapsed.length < 3) {
        if (li === 0) dropFace = true; // outer collapsed: the face disappears
        return; // a collapsed hole just closes
      }
      if (new Set(collapsed.map((c) => c.v)).size !== collapsed.length) {
        throw new MeshError(`Merging would pinch face ${f.id}`);
      }
      loops.push(collapsed);
    });
    if (!dropFace && loops.length) out.faces.push({ ...f, loops });
  }

  // Wire edges that collapse, duplicate each other, or now lie along a face edge are dropped.
  const seen = new Set<string>();
  for (const f of out.faces) {
    for (const loop of f.loops) {
      loop.forEach((c, i) => {
        const n = loop[(i + 1) % loop.length]!.v;
        seen.add(c.v < n ? `${c.v},${n}` : `${n},${c.v}`);
      });
    }
  }
  for (const [a0, b0] of data.wireEdges) {
    const a = to(a0);
    const b = to(b0);
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (a === b || seen.has(key)) continue;
    seen.add(key);
    out.wireEdges.push(a < b ? [a, b] : [b, a]);
  }

  // Soft edges keep their flag through the remap; collapsed or duplicate ones drop out.
  const softSeen = new Set<string>();
  for (const [a0, b0] of data.softEdges) {
    const a = to(a0);
    const b = to(b0);
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (a === b || softSeen.has(key) || !seen.has(key)) continue;
    softSeen.add(key);
    out.softEdges.push(a < b ? [a, b] : [b, a]);
  }

  let result: HalfEdgeMesh;
  try {
    result = fromMeshData(out);
  } catch (e) {
    throw new MeshError(`Merging would create invalid geometry (${(e as Error).message})`);
  }
  // Moving vertices together can bend faces: fold them flat.
  planarizeAround(
    result,
    groups.map((g) => g.ids[0]).filter((id): id is VertId => id !== undefined).map((id) => result.vertex(id)),
  );
  return result;
}

/** Weld vertices into one at their centroid. */
export function mergeAtCenter(mesh: HalfEdgeMesh, ids: VertId[]): HalfEdgeMesh {
  if (ids.length < 2) return mesh;
  const c: Vec3 = [0, 0, 0];
  for (const id of ids) {
    const p = mesh.vertex(id).pos;
    c[0] += p[0] / ids.length;
    c[1] += p[1] / ids.length;
    c[2] += p[2] / ids.length;
  }
  return mergeVertexGroups(mesh, [{ ids, pos: c }]);
}

/** Weld vertices (among `ids`) that lie within `distance` of each other. */
export function mergeByDistance(mesh: HalfEdgeMesh, ids: VertId[], distance: number): { mesh: HalfEdgeMesh; removed: number } {
  const verts = ids.map((id) => mesh.vertex(id));
  const used = new Set<VertId>();
  const groups: MergeGroup[] = [];
  const d2 = distance * distance;
  for (const v of verts) {
    if (used.has(v.id)) continue;
    const group = [v.id];
    used.add(v.id);
    for (const w of verts) {
      if (used.has(w.id)) continue;
      const dx = w.pos[0] - v.pos[0];
      const dy = w.pos[1] - v.pos[1];
      const dz = w.pos[2] - v.pos[2];
      if (dx * dx + dy * dy + dz * dz <= d2) {
        group.push(w.id);
        used.add(w.id);
      }
    }
    if (group.length > 1) groups.push({ ids: group, pos: v.pos });
  }
  if (!groups.length) return { mesh, removed: 0 };
  return { mesh: mergeVertexGroups(mesh, groups), removed: groups.reduce((n, g) => n + g.ids.length - 1, 0) };
}
