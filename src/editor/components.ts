import type { Document, ObjectId } from '../core/document';
import { type Edge, edgeKey, type Face, type HalfEdgeMesh, type Vertex } from '../core/halfedge/mesh';
import type { ComponentMode, ComponentSet, ElementKey } from './selection';

/** Resolving component keys against meshes, and converting selections between modes. */

export function keyOfEdge(e: Edge): string {
  return edgeKey(e.he.origin.id, e.he.dest.id);
}

export function vertexOf(mesh: HalfEdgeMesh, key: ElementKey): Vertex | undefined {
  return typeof key === 'number' ? mesh.verts.get(key) : undefined;
}

export function edgeOf(mesh: HalfEdgeMesh, key: ElementKey): Edge | undefined {
  return typeof key === 'string' ? mesh.edgeByKey(key) : undefined;
}

export function faceOf(mesh: HalfEdgeMesh, key: ElementKey): Face | undefined {
  return typeof key === 'number' ? mesh.faces.get(key) : undefined;
}

export function elementExists(mesh: HalfEdgeMesh, mode: ComponentMode, key: ElementKey): boolean {
  if (mode === 'vertex') return vertexOf(mesh, key) !== undefined;
  if (mode === 'edge') return edgeOf(mesh, key) !== undefined;
  return faceOf(mesh, key) !== undefined;
}

/** The distinct vertices covered by a set of elements. */
export function verticesOf(mesh: HalfEdgeMesh, mode: ComponentMode, keys: Iterable<ElementKey>): Vertex[] {
  const out = new Set<Vertex>();
  for (const k of keys) {
    if (mode === 'vertex') {
      const v = vertexOf(mesh, k);
      if (v) out.add(v);
    } else if (mode === 'edge') {
      const e = edgeOf(mesh, k);
      if (e) for (const v of e.verts) out.add(v);
    } else {
      const f = faceOf(mesh, k);
      if (f) for (const h of f.halfEdges()) out.add(h.origin);
    }
  }
  return [...out];
}

export function edgesOf(mesh: HalfEdgeMesh, keys: Iterable<ElementKey>): Edge[] {
  return [...keys].map((k) => edgeOf(mesh, k)).filter((e): e is Edge => e !== undefined);
}

export function facesOf(mesh: HalfEdgeMesh, keys: Iterable<ElementKey>): Face[] {
  return [...keys].map((k) => faceOf(mesh, k)).filter((f): f is Face => f !== undefined);
}

/** Every element of a mesh in the given mode. */
export function allKeys(mesh: HalfEdgeMesh, mode: ComponentMode): ElementKey[] {
  if (mode === 'vertex') return [...mesh.verts.keys()];
  if (mode === 'face') return [...mesh.faces.keys()];
  return [...mesh.edges()].map(keyOfEdge);
}

/**
 * Convert a selection from one mode to another. Going "down" (faces → edges → vertices) takes
 * every element touched. Going "up" takes elements whose parts are all selected.
 */
export function convertSelection(doc: Document, sel: ComponentSet, from: ComponentMode, to: ComponentMode): ComponentSet {
  if (from === to) return sel;
  const out = new Map<ObjectId, Set<ElementKey>>();
  for (const [id, keys] of sel) {
    const obj = doc.findObject(id);
    if (!obj) continue;
    const mesh = obj.mesh;
    const result = new Set<ElementKey>();

    if (to === 'vertex') {
      for (const v of verticesOf(mesh, from, keys)) result.add(v.id);
    } else if (to === 'edge') {
      if (from === 'face') {
        for (const f of facesOf(mesh, keys)) for (const h of f.halfEdges()) result.add(keyOfEdge(h.edge));
      } else {
        const vs = new Set(verticesOf(mesh, from, keys));
        for (const e of mesh.edges()) if (vs.has(e.verts[0]) && vs.has(e.verts[1])) result.add(keyOfEdge(e));
      }
    } else {
      // to faces: every vertex (or edge) of the face is selected
      if (from === 'edge') {
        const es = new Set(edgesOf(mesh, keys));
        for (const f of mesh.faces.values()) {
          if ([...f.halfEdges()].every((h) => es.has(h.edge))) result.add(f.id);
        }
      } else {
        const vs = new Set(verticesOf(mesh, from, keys));
        for (const f of mesh.faces.values()) {
          if ([...f.halfEdges()].every((h) => vs.has(h.origin))) result.add(f.id);
        }
      }
    }
    if (result.size) out.set(id, result);
  }
  return out;
}
