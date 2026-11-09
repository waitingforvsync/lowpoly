import type { Face } from '../halfedge/mesh';
import type { FaceId } from '../meshdata';

/** Which faces a Paint click affects. */
export type PaintScope =
  /** Just the clicked face (or the face selection, if the clicked face is in it). */
  | 'face'
  /** Faces connected to the clicked one through edges, sharing its material (SketchUp: Ctrl). */
  | 'connected'
  /** Every face of the object with the clicked face's material (SketchUp: Shift). */
  | 'same';

/** Faces of a mesh to paint, given the clicked face and the scope. */
export function paintTargets(faces: Iterable<Face>, clicked: Face, scope: PaintScope): FaceId[] {
  if (scope === 'face') return [clicked.id];
  const mat = clicked.material;
  if (scope === 'same') return [...faces].filter((f) => f.material === mat).map((f) => f.id);
  const seen = new Set<Face>([clicked]);
  const stack = [clicked];
  while (stack.length) {
    const f = stack.pop()!;
    for (const h of f.halfEdges()) {
      const n = h.twin.face;
      if (n && n.material === mat && !seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return [...seen].map((f) => f.id);
}

