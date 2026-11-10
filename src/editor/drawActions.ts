import * as THREE from 'three';
import { DEFAULT_MATERIAL_ID, type ObjectId, SceneObject } from '../core/document';
import { fromMeshData } from '../core/halfedge/convert';
import { newellNormal, type ReadonlyVec3, type Vec3 } from '../core/math/vec';
import { drawLoopOnFace, drawPathOnFace, faceUnder, locateOnFace, loopMeshData } from '../core/ops/draw';
import { evenCuts, loopCut } from '../core/ops/loopcut';
import { transformToMatrix } from '../render/transformMath';
import { AddObjectsCommand } from './commands';
import { editMeshes } from './componentActions';
import { edgeOf } from './components';
import { editor } from './editor';
import { isComponentMode } from './modes';
import { editObjects } from './selection';
import { selectionMode, showStatus } from './state';

/** Line, Rectangle and Loop Cut tools: turning what was drawn into document changes (M6). */

export type DrawOutcome =
  /** The document changed. */
  | 'drawn'
  /** Valid, but there was nothing to add (e.g. a line along an existing edge). */
  | 'nothing'
  /** Not on a face, so nothing can be made yet (an open line in mid-air). */
  | 'pending'
  /** Refused; the reason is shown in the status bar. */
  | 'error';

const round = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

function toLocal(points: readonly ReadonlyVec3[], inverse: THREE.Matrix4): Vec3[] {
  return points.map((p) => {
    const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(inverse);
    return [round(v.x), round(v.y), round(v.z)];
  });
}

/**
 * Put a drawn shape (world-space points; `closed` for a loop) into the document. On a face of a
 * visible, unlocked object it cuts that face (a hole filled by a new face, or a split). A closed
 * shape anywhere else becomes a new object with one face whose front faces `up`. `prefer` is
 * tried first (the object the drawing started on).
 */
export function drawShape(
  points: readonly ReadonlyVec3[],
  closed: boolean,
  label: string,
  up: ReadonlyVec3,
  prefer: ObjectId | null = null,
): DrawOutcome {
  const doc = editor.doc;
  const objs = doc.objects.filter((o) => o.visible && !o.locked);
  objs.sort((a, b) => Number(b.id === prefer) - Number(a.id === prefer));
  for (const obj of objs) {
    const local = toLocal(points, transformToMatrix(obj.transform).invert());
    const face = faceUnder(obj.mesh, local, closed);
    if (!face) continue;
    // An open line cuts the face only once it runs from edge to edge.
    const onEdge = (p: Vec3) => ['vertex', 'edge'].includes(locateOnFace(face, p).kind);
    if (!closed && !(onEdge(local[0]!) && onEdge(local[local.length - 1]!))) return 'pending';
    const faceId = face.id;
    let inner: number[] = [];
    let failed = false;
    const changed = editMeshes(
      label,
      [[obj, new Set()]],
      (mesh) => {
        try {
          if (closed) inner = drawLoopOnFace(mesh, faceId, local).inner;
          else drawPathOnFace(mesh, faceId, local);
        } catch (e) {
          failed = true; // editMeshes shows the reason
          throw e;
        }
        return selectionMode.peek() === 'face' && inner.length ? { select: inner } : undefined;
      },
      closed ? 'face' : undefined,
    );
    return changed ? 'drawn' : failed ? 'error' : 'nothing';
  }
  if (!closed) return 'pending';
  return newShapeObject(points, label, up);
}

function newShapeObject(points: readonly ReadonlyVec3[], label: string, up: ReadonlyVec3): DrawOutcome {
  const doc = editor.doc;
  const origin = points[0]!;
  const local = points.map((p) => [round(p[0] - origin[0]), round(p[1] - origin[1]), round(p[2] - origin[2])] as Vec3);
  // Flat shapes face up; others face `up` (the viewer).
  const n = newellNormal(local);
  const flat = Math.abs(n[2]) > 0.99 * Math.hypot(n[0], n[1], n[2]);
  let data;
  try {
    data = loopMeshData(local, flat ? [0, 0, 1] : up, DEFAULT_MATERIAL_ID);
  } catch (e) {
    showStatus(`${label}: ${(e as Error).message}`, 'error');
    return 'error';
  }
  const obj = new SceneObject(doc.nextObjectId, doc.uniqueObjectName('Shape'), fromMeshData(data), {
    position: [origin[0], origin[1], origin[2]],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });
  editor.execute(new AddObjectsCommand(editor.ctx, [obj], label), () => {
    // In a component mode, the new shape is editable straight away (e.g. to push/pull it).
    if (isComponentMode(selectionMode.peek())) editObjects.value = new Set([...editObjects.peek(), obj.id]);
  });
  return 'drawn';
}

/** Loop cut through an edge of an object: `cuts` evenly spaced cuts, or one at parameter `t`. */
export function loopCutEdge(objectId: ObjectId, key: string, how: { cuts: number } | { t: number; from: number }): boolean {
  const obj = editor.doc.findObject(objectId);
  if (!obj) return false;
  return editMeshes(
    'Loop Cut',
    [[obj, new Set([key])]],
    (mesh) => {
      const e = edgeOf(mesh, key);
      if (!e) throw new Error('Edge not found');
      // `t` is measured from vertex `from`; the ring measures from this edge's `he` origin.
      const ts = 'cuts' in how ? evenCuts(how.cuts) : [e.he.origin.id === how.from ? how.t : 1 - how.t];
      const made = loopCut(mesh, e, ts);
      return { select: made };
    },
    'edge',
  );
}
