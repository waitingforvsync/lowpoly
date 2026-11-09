import { addHole } from '../halfedge/euler';
import { type Edge, type Face, type HalfEdgeMesh, MeshError, type Vertex } from '../halfedge/mesh';
import { add, dot, newellNormal, normalize, planeBasis, pointInPolygon2D, scale, sub, type Vec2, type Vec3 } from '../math/vec';
import type { FaceId } from '../meshdata';
import { isPlanar, planeOf } from '../planarity';
import { triangulateFace } from '../triangulate';
import { faceUVMap, projectUVs } from '../uv/continue';

/**
 * Make a face from a closed outline, given as edges forming one cycle or as vertices. Vertices
 * already joined by edges into a cycle use that cycle's order; otherwise they're ordered by angle
 * around their centre. The outline must be planar. The winding is whichever direction the
 * neighbouring faces allow; when both are free, the face points away from the mesh's centre.
 * Edits the mesh in place.
 */
export function makeFace(mesh: HalfEdgeMesh, input: { edges: Edge[] } | { verts: Vertex[] }): Face {
  const order = 'edges' in input ? cycleOf(input.edges) : orderVerts(mesh, input.verts);
  if (!order) throw new MeshError('The selected edges must form one closed loop');
  if (order.length < 3) throw new MeshError('A face needs at least 3 vertices');
  const pts = order.map((v) => v.pos);
  if (!isPlanar(pts)) throw new MeshError('The outline is not planar');
  if (newellNormal(pts).every((x) => Math.abs(x) < 1e-12)) throw new MeshError('The outline has no area');

  const free = (loop: Vertex[]) =>
    loop.every((v, i) => {
      const h = mesh.findHalfEdge(v, loop[(i + 1) % loop.length]!);
      return !h?.loop;
    });
  const fwd = free(order);
  const rev = [...order].reverse();
  const back = free(rev);
  if (!fwd && !back) throw new MeshError('A face already fills that outline (or its edges have faces on both sides)');

  let loop = fwd ? order : rev;
  if (fwd && back) {
    // Face away from the centre of the rest of the mesh.
    const centre = meshCentre(mesh);
    const n = newellNormal(pts);
    const c = scale(pts.reduce<Vec3>((s, p) => add(s, p), [0, 0, 0]), 1 / pts.length);
    if (centre && dot(n, sub(c, centre)) < 0) loop = rev;
  }

  const uvs = projectUVs(loop.map((v) => v.pos));
  const material = neighbourMaterial(mesh, loop) ?? 0;
  return mesh.addFace([loop.map((v, i) => ({ v, uv: uvs[i]! }))], material);
}

/**
 * Cut a face out of the face around it: `inner` must lie in the plane of a surrounding face,
 * facing the same way, inside its outline and sharing no vertices with it. Its outline becomes a
 * hole in that face, filled by `inner`. Deleting `inner` afterwards leaves an open hole.
 */
export function makeHole(mesh: HalfEdgeMesh, inner: Face): Face {
  if (inner.holes.length) throw new MeshError('The inner face has holes of its own');
  const pts = inner.outer.positions();
  const n = inner.normal();
  const innerVerts = new Set(inner.outer.verts());
  for (const outer of mesh.faces.values()) {
    if (outer === inner || dot(outer.normal(), n) < 1 - 1e-6) continue;
    if ([...outer.halfEdges()].some((h) => innerVerts.has(h.origin))) continue;
    if (!isPlanar([...outer.outer.positions(), ...pts])) continue;
    if (!faceContains(outer, pts)) continue;
    const map = faceUVMap(
      [...outer.halfEdges()].map((h) => h.origin.pos),
      [...outer.halfEdges()].map((h) => h.uv),
    );
    const corners = Array.from(inner.outer.halfEdges(), (h) => ({ v: h.origin, uv: map?.(h.origin.pos) ?? h.uv }));
    addHole(mesh, outer, corners);
    return outer;
  }
  throw new MeshError('No face surrounds this one in the same plane');
}

/**
 * Split faces into triangles (keeping holes' outlines as edges). The first triangle of each face
 * keeps its id. Triangles are already planar. Returns the ids of every resulting triangle.
 */
export function triangulateFaces(mesh: HalfEdgeMesh, faces: Iterable<Face>): FaceId[] {
  const out: FaceId[] = [];
  for (const f of [...faces]) {
    if (mesh.faces.get(f.id) !== f) continue;
    if (!f.holes.length && f.outer.verts().length === 3) {
      out.push(f.id);
      continue;
    }
    const { corners, indices } = triangulateFace(f);
    const tris: { v: Vertex; uv: Vec2 }[][] = [];
    for (let i = 0; i < indices.length; i += 3) {
      tris.push([0, 1, 2].map((k) => {
        const h = corners[indices[i + k]!]!;
        return { v: h.origin, uv: [h.uv[0], h.uv[1]] as Vec2 };
      }));
    }
    const { id, material } = f;
    mesh.removeFace(f);
    tris.forEach((t, i) => out.push(mesh.addFace([t], material, i === 0 ? id : undefined).id));
  }
  return out;
}

// -----------------------------------------------------------------------------------------------

/** Order the vertices of edges forming exactly one simple cycle, or null. */
function cycleOf(edges: Edge[]): Vertex[] | null {
  const adj = new Map<Vertex, Vertex[]>();
  for (const e of edges) {
    const [a, b] = e.verts;
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  }
  if (!adj.size || [...adj.values()].some((n) => n.length !== 2)) return null;
  const start = adj.keys().next().value!;
  const order = [start];
  let prev = start;
  let cur = adj.get(start)![0]!;
  while (cur !== start) {
    order.push(cur);
    const [x, y] = adj.get(cur)!;
    const next = x === prev ? y! : x!;
    prev = cur;
    cur = next;
    if (order.length > adj.size) return null;
  }
  return order.length === adj.size ? order : null;
}

/** Vertices in cycle order if mesh edges join them into one cycle, else by angle around their centre. */
function orderVerts(mesh: HalfEdgeMesh, verts: Vertex[]): Vertex[] {
  const set = new Set(verts);
  const edges = [...mesh.edges()].filter((e) => set.has(e.verts[0]) && set.has(e.verts[1]));
  const cycle = cycleOf(edges);
  if (cycle && cycle.length === set.size) return cycle;
  const pts = verts.map((v) => v.pos);
  const { normal, origin } = planeOf(pts);
  const { u, v } = planeBasis(normalize(normal));
  const angle = (p: Vec3) => Math.atan2(dot(sub(p, origin), v), dot(sub(p, origin), u));
  return [...verts].sort((a, b) => angle(a.pos) - angle(b.pos));
}

function meshCentre(mesh: HalfEdgeMesh): Vec3 | null {
  if (!mesh.verts.size) return null;
  const c: Vec3 = [0, 0, 0];
  for (const v of mesh.verts.values()) {
    c[0] += v.pos[0];
    c[1] += v.pos[1];
    c[2] += v.pos[2];
  }
  return scale(c, 1 / mesh.verts.size);
}

function neighbourMaterial(mesh: HalfEdgeMesh, loop: Vertex[]): number | undefined {
  for (let i = 0; i < loop.length; i++) {
    const e = mesh.findEdge(loop[i]!, loop[(i + 1) % loop.length]!);
    const f = e?.faces()[0];
    if (f) return f.material;
  }
  return undefined;
}

/** All points inside the face's outer loop and outside its holes (points in its plane). */
export function faceContains(face: Face, pts: readonly Vec3[]): boolean {
  const { u, v } = planeBasis(face.normal());
  const to2 = (p: Vec3): Vec2 => [dot(p, u), dot(p, v)];
  const outer = face.outer.positions().map(to2);
  const holes = face.holes.map((l) => l.positions().map(to2));
  return pts.every((p) => pointInPolygon2D(to2(p), outer) && holes.every((h) => !pointInPolygon2D(to2(p), h)));
}
