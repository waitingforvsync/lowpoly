import { dot, newellNormal } from '../math/vec';
import { edgeKey, type HalfEdge, type HalfEdgeMesh, type Loop, MeshError } from './mesh';
import { isFacePlanar } from '../planarity';

/**
 * Check every structural invariant of a half-edge mesh. Returns a list of problems, which is
 * empty for a valid mesh. Used in all unit tests, and after every op in dev builds.
 */
export function validate(mesh: HalfEdgeMesh): string[] {
  const errors: string[] = [];
  const err = (msg: string) => {
    if (errors.length < 50) errors.push(msg);
  };

  // Collect half-edges from the edge index.
  const allHes = new Set<HalfEdge>();
  let edgeCount = 0;
  for (const e of mesh.edges()) {
    edgeCount++;
    const h = e.he;
    const t = h.twin;
    const name = `edge ${h.origin.id}-${t.origin.id}`;
    if (!t || t.twin !== h) err(`${name}: twin pointers are not symmetric`);
    if (h.edge !== e || t.edge !== e) err(`${name}: half-edge.edge does not point back to the edge`);
    if (h.origin === t.origin) err(`${name}: both halves start at the same vertex`);
    if (mesh.edgeByKey(edgeKey(h.origin.id, t.origin.id)) !== e) err(`${name}: edge index key mismatch`);
    if (mesh.verts.get(h.origin.id) !== h.origin) err(`${name}: origin vertex ${h.origin.id} not in mesh`);
    if (mesh.verts.get(t.origin.id) !== t.origin) err(`${name}: origin vertex ${t.origin.id} not in mesh`);
    if (!h.origin.out.includes(h)) err(`${name}: half-edge missing from vertex ${h.origin.id} out list`);
    if (!t.origin.out.includes(t)) err(`${name}: half-edge missing from vertex ${t.origin.id} out list`);
    allHes.add(h);
    allHes.add(t);
  }
  if (edgeCount !== mesh.edgeCount) err('edge iteration count differs from edgeCount');

  // Vertices.
  let outTotal = 0;
  for (const [id, v] of mesh.verts) {
    if (v.id !== id) err(`vertex keyed ${id} has id ${v.id}`);
    if (id >= mesh.nextVertId) err(`vertex id ${id} >= nextVertId ${mesh.nextVertId}`);
    if (!v.pos.every(Number.isFinite)) err(`vertex ${id} has a non-finite position`);
    for (const h of v.out) {
      if (h.origin !== v) err(`vertex ${id}: out half-edge has origin ${h.origin.id}`);
      if (!allHes.has(h)) err(`vertex ${id}: out half-edge is not part of any indexed edge`);
    }
    if (new Set(v.out.map((h) => h.dest)).size !== v.out.length) err(`vertex ${id}: duplicate outgoing edges`);
    outTotal += v.out.length;
  }
  if (outTotal !== allHes.size) err(`vertex out lists hold ${outTotal} half-edges, expected ${allHes.size}`);

  // Faces and loops.
  const liveLoops = new Set<Loop>();
  for (const [id, f] of mesh.faces) {
    if (f.id !== id) err(`face keyed ${id} has id ${f.id}`);
    if (id >= mesh.nextFaceId) err(`face id ${id} >= nextFaceId ${mesh.nextFaceId}`);
    if (!f.outer) {
      err(`face ${id}: no outer loop`);
      continue;
    }
    const faceVerts = new Set<number>();
    for (const loop of f.loops) {
      liveLoops.add(loop);
      if (loop.face !== f) err(`face ${id}: loop.face points elsewhere`);
      let h = loop.he;
      let count = 0;
      do {
        if (!allHes.has(h)) {
          err(`face ${id}: loop contains a half-edge that is not indexed`);
          break;
        }
        if (h.loop !== loop) err(`face ${id}: half-edge ${h.origin.id}->${h.dest.id} has the wrong loop`);
        if (!h.next || !h.prev) {
          err(`face ${id}: half-edge ${h.origin.id}->${h.dest.id} has no next/prev`);
          break;
        }
        if (h.next.prev !== h) err(`face ${id}: next/prev mismatch at ${h.origin.id}->${h.dest.id}`);
        if (h.next.origin !== h.dest) err(`face ${id}: loop is not continuous at vertex ${h.dest.id}`);
        if (faceVerts.has(h.origin.id)) err(`face ${id}: vertex ${h.origin.id} appears more than once`);
        faceVerts.add(h.origin.id);
        if (!h.uv.every(Number.isFinite)) err(`face ${id}: non-finite UV`);
        h = h.next;
        if (++count > allHes.size) {
          err(`face ${id}: loop does not close`);
          break;
        }
      } while (h !== loop.he);
      if (count < 3) err(`face ${id}: loop has ${count} corners`);
    }

    if (!isFacePlanar(f)) err(`face ${id}: not planar`);

    // Holes wind opposite to the outer loop. Skip degenerate (zero-area) loops.
    const n = newellNormal(f.outer.positions());
    for (const hole of f.holes) {
      const hn = newellNormal(hole.positions());
      const d = dot(n, hn);
      if (d > 1e-12) err(`face ${id}: hole winds the same way as the outer loop`);
    }
  }

  // Every half-edge is either in a live loop with links, or boundary with no links.
  for (const h of allHes) {
    if (h.loop) {
      if (!liveLoops.has(h.loop)) err(`half-edge ${h.origin.id}->${h.dest.id} references a dead loop`);
    } else if (h.next || h.prev) {
      err(`boundary half-edge ${h.origin.id}->${h.dest.id} has next/prev links`);
    }
  }

  return errors;
}

export function assertValid(mesh: HalfEdgeMesh): void {
  const errors = validate(mesh);
  if (errors.length) throw new MeshError(`Invalid mesh:\n  ${errors.join('\n  ')}`);
}
