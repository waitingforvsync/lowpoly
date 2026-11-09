import type { ObjectId, SceneObject } from '../core/document';
import { fromMeshData, toMeshData } from '../core/halfedge/convert';
import type { HalfEdgeMesh } from '../core/halfedge/mesh';
import type { Vec3 } from '../core/math/vec';
import type { MaterialId } from '../core/meshdata';
import { deleteEdges, deleteFaces, deleteVerts } from '../core/ops/delete';
import { dissolveEdges, dissolveFaces, dissolveVertex } from '../core/ops/dissolve';
import { mergeAtCenter, mergeByDistance } from '../core/ops/merge';
import { planarizeAround } from '../core/ops/planarize';
import { type Command, CompositeCommand } from '../history/history';
import { MoveVertsCommand, ReplaceMeshCommand, type VertexMove } from './commands';
import { allKeys, edgesOf, facesOf, verticesOf } from './components';
import { editor } from './editor';
import {
  type ComponentMode,
  componentSelection,
  editObjects,
  type ElementKey,
  setComponents,
} from './selection';
import { showStatus } from './state';
import { transformPoint, inverseTransformPoint } from './transformPoints';

/** Operations on the vertex/edge/face selection of the objects being edited. */

const MERGE_DISTANCE = 1e-4;

function selectedEntries(mode: ComponentMode): [SceneObject, ReadonlySet<ElementKey>][] {
  const doc = editor.doc;
  return [...componentSelection[mode].value]
    .map(([id, keys]) => [doc.findObject(id), keys] as const)
    .filter((e): e is [SceneObject, ReadonlySet<ElementKey>] => !!e[0] && e[1].size > 0);
}

/**
 * Run a topology-changing edit on a copy of each object's mesh, and record the results as one
 * undo step. An object whose edit throws is left unchanged and the reason reported.
 */
function editMeshes(
  label: string,
  objects: [SceneObject, ReadonlySet<ElementKey>][],
  edit: (mesh: HalfEdgeMesh, keys: ReadonlySet<ElementKey>) => HalfEdgeMesh | void,
): boolean {
  const cmds: Command[] = [];
  const errors: string[] = [];
  for (const [obj, keys] of objects) {
    const before = ReplaceMeshCommand.capture(obj);
    const work = fromMeshData(before.mesh);
    try {
      const result = edit(work, keys) ?? work;
      cmds.push(new ReplaceMeshCommand(editor.ctx, obj.id, before, { mesh: toMeshData(result), source: null }, label));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (cmds.length) editor.execute(cmds.length === 1 ? cmds[0]! : new CompositeCommand(label, cmds));
  if (errors.length) showStatus(`${label}: ${errors[0]}`, 'error');
  return cmds.length > 0;
}

export function deleteComponents(mode: ComponentMode): void {
  const entries = selectedEntries(mode);
  if (!entries.length) return;
  editMeshes(`Delete ${plural(mode)}`, entries, (mesh, keys) => {
    if (mode === 'vertex') deleteVerts(mesh, verticesOf(mesh, 'vertex', keys));
    else if (mode === 'edge') deleteEdges(mesh, edgesOf(mesh, keys));
    else deleteFaces(mesh, facesOf(mesh, keys));
  });
}

export function dissolveComponents(mode: ComponentMode): void {
  const entries = selectedEntries(mode);
  if (!entries.length) return;
  let failed = 0;
  const ok = editMeshes(`Dissolve ${plural(mode)}`, entries, (mesh, keys) => {
    if (mode === 'vertex') {
      for (const v of verticesOf(mesh, 'vertex', keys)) {
        try {
          if (mesh.verts.get(v.id) === v) dissolveVertex(mesh, v);
        } catch {
          failed++;
        }
      }
    } else if (mode === 'edge') {
      failed += dissolveEdges(mesh, edgesOf(mesh, keys)).failed;
    } else {
      failed += dissolveFaces(mesh, facesOf(mesh, keys)).failed;
    }
  });
  if (ok && failed) showStatus(`Dissolve: ${failed} element(s) could not be dissolved and were left as they are`);
}

/** Weld the selected vertices of each object into one, at their centre. */
export function mergeComponentsAtCenter(mode: ComponentMode): void {
  const entries = selectedEntries(mode);
  if (!entries.length) return;
  const merged: [ObjectId, ElementKey][] = [];
  editMeshes('Merge Vertices', entries, (mesh, keys) => {
    const ids = verticesOf(mesh, mode, keys).map((v) => v.id);
    if (ids.length < 2) return;
    const out = mergeAtCenter(mesh, ids);
    merged.push([entries.find(([, k]) => k === keys)![0].id, ids[0]!]);
    return out;
  });
  if (mode === 'vertex' && merged.length) {
    setComponents('vertex', new Map(merged.map(([id, v]) => [id, new Set([v])])));
  }
}

export function mergeComponentsByDistance(mode: ComponentMode): void {
  const entries = selectedEntries(mode);
  if (!entries.length) return;
  let removed = 0;
  editMeshes('Merge by Distance', entries, (mesh, keys) => {
    const res = mergeByDistance(
      mesh,
      verticesOf(mesh, mode, keys).map((v) => v.id),
      MERGE_DISTANCE,
    );
    removed += res.removed;
    return res.mesh;
  });
  showStatus(`Merge by distance: removed ${removed} vertex${removed === 1 ? '' : 'es'}`);
}

// --- Selection (not undoable) -----------------------------------------------------------------

export function selectAllComponents(mode: ComponentMode): void {
  const doc = editor.doc;
  setComponents(
    mode,
    new Map([...editObjects.value].map((id) => [id, new Set(allKeys(doc.object(id).mesh, mode))])),
  );
}

export function invertComponents(mode: ComponentMode): void {
  const doc = editor.doc;
  const current = componentSelection[mode].value;
  setComponents(
    mode,
    new Map(
      [...editObjects.value].map((id) => {
        const sel = current.get(id) ?? new Set();
        return [id, new Set(allKeys(doc.object(id).mesh, mode).filter((k) => !sel.has(k)))];
      }),
    ),
  );
}



// --- Positions --------------------------------------------------------------------------------

/** World-space centroid of the selected components, or null when nothing is selected. */
export function componentCentroid(mode: ComponentMode): Vec3 | null {
  let n = 0;
  const c: Vec3 = [0, 0, 0];
  for (const [obj, keys] of selectedEntries(mode)) {
    for (const v of verticesOf(obj.mesh, mode, keys)) {
      const w = transformPoint(obj.transform, v.pos);
      c[0] += w[0];
      c[1] += w[1];
      c[2] += w[2];
      n++;
    }
  }
  return n ? [c[0] / n, c[1] / n, c[2] / n] : null;
}

/** Move the selection so its centroid lands on `target` (world space). */
export function moveComponentsTo(mode: ComponentMode, target: Vec3): void {
  const c = componentCentroid(mode);
  if (!c) return;
  const delta: Vec3 = [target[0] - c[0], target[1] - c[1], target[2] - c[2]];
  if (delta.every((d) => Math.abs(d) < 1e-12)) return;
  const moves = selectedEntries(mode).map(([obj, keys]) => {
    const verts = verticesOf(obj.mesh, mode, keys);
    return {
      objectId: obj.id,
      ids: verts.map((v) => v.id),
      before: verts.map((v) => [...v.pos] as Vec3),
      after: verts.map((v) => {
        const w = transformPoint(obj.transform, v.pos);
        return inverseTransformPoint(obj.transform, [w[0] + delta[0], w[1] + delta[1], w[2] + delta[2]]);
      }),
    };
  });
  commitVertexMoves(moves, `Move ${plural(mode)}`);
}

/**
 * Record vertex moves as one undo step. Faces bent by the move are folded into planar pieces;
 * objects without folds use the cheap position-only command. If any object can't be folded
 * (a bent face with holes), the whole edit is refused. Meshes must be at their `before` positions.
 */
export function commitVertexMoves(moves: VertexMove[], label: string): boolean {
  const plain: VertexMove[] = [];
  const replaced: Command[] = [];
  for (const m of moves) {
    const obj = editor.doc.object(m.objectId);
    const before = ReplaceMeshCommand.capture(obj);
    const work = fromMeshData(before.mesh);
    m.ids.forEach((id, i) => (work.vertex(id).pos = [...m.after[i]!]));
    try {
      const { folded } = planarizeAround(
        work,
        m.ids.map((id) => work.vertex(id)),
      );
      if (folded === 0) plain.push(m);
      else replaced.push(new ReplaceMeshCommand(editor.ctx, obj.id, before, { mesh: toMeshData(work), source: null }, label));
    } catch (e) {
      showStatus(`${label}: ${(e as Error).message}`, 'error');
      return false;
    }
  }
  const cmds: Command[] = [...replaced];
  if (plain.length) cmds.unshift(new MoveVertsCommand(editor.ctx, plain, label));
  if (cmds.length) editor.execute(cmds.length === 1 ? cmds[0]! : new CompositeCommand(label, cmds));
  return true;
}

/** Mark the selected edges hard (split normals) or soft (smooth normals). */
export function setEdgesHard(hard: boolean): void {
  const entries = selectedEntries('edge').filter(([obj, keys]) => edgesOf(obj.mesh, keys).some((e) => e.hard !== hard));
  if (!entries.length) return;
  editMeshes(hard ? 'Mark Hard' : 'Mark Soft', entries, (mesh, keys) => {
    for (const e of edgesOf(mesh, keys)) e.hard = hard;
  });
}

/** Whether the selected edges are hard, soft, mixed (null), or none selected (undefined). */
export function selectedEdgesHard(): boolean | null | undefined {
  let found: boolean | undefined;
  for (const [obj, keys] of selectedEntries('edge')) {
    for (const e of edgesOf(obj.mesh, keys)) {
      if (found === undefined) found = e.hard;
      else if (found !== e.hard) return null;
    }
  }
  return found;
}

// --- Materials --------------------------------------------------------------------------------

export function assignMaterialToFaces(material: MaterialId): void {
  const entries = selectedEntries('face').filter(([obj, keys]) =>
    facesOf(obj.mesh, keys).some((f) => f.material !== material),
  );
  if (!entries.length) return;
  editMeshes('Assign Material', entries, (mesh, keys) => {
    for (const f of facesOf(mesh, keys)) f.material = material;
  });
}

/** The material shared by every selected face, or null when mixed (undefined if none selected). */
export function selectedFacesMaterial(): MaterialId | null | undefined {
  let found: MaterialId | undefined;
  for (const [obj, keys] of selectedEntries('face')) {
    for (const f of facesOf(obj.mesh, keys)) {
      if (found === undefined) found = f.material;
      else if (found !== f.material) return null;
    }
  }
  return found;
}

function plural(mode: ComponentMode): string {
  return mode === 'vertex' ? 'Vertices' : mode === 'edge' ? 'Edges' : 'Faces';
}
