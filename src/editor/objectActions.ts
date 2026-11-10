import * as THREE from 'three';
import { cloneTransform, type ObjectId, SceneObject, type Transform } from '../core/document';
import { fromMeshData, toMeshData } from '../core/halfedge/convert';
import type { Vec3 } from '../core/math/vec';
import { deleteFaces } from '../core/ops/delete';
import { flipNormals, shells } from '../core/ops/normals';
import { type Affine, extractFaces, meshBounds, mergeMeshData, transformMeshData, translateMeshData } from '../core/ops/object';
import { planarizeAround } from '../core/ops/planarize';
import { transformToMatrix } from '../render/transformMath';
import { type Command, CompositeCommand } from '../history/history';
import { selectedIds } from './actions';
import { AddObjectsCommand, ReplaceMeshCommand, RemoveObjectsCommand, SetTransformsCommand } from './commands';
import { editMeshes, selectedEntries } from './componentActions';
import { convertSelection, facesOf, verticesOf } from './components';
import { editor } from './editor';
import { isComponentMode } from './modes';
import { activeObject, componentSelection, editObjects, setComponents, setSelection, type ComponentMode } from './selection';
import { gridStep, selectionMode, showStatus } from './state';
import { snapVec3 } from './snap';
import { inverseTransformPoint, transformPoint } from './transformPoints';

/**
 * Object operations (M8): Join, Separate, Apply Rotation & Scale, Set Origin, Mirror, Snap to
 * Grid. Geometry changes are baked into the mesh through `core/ops/object.ts`; each operation is one
 * undo step.
 */

/** A Three.js matrix as the core's row-major 3×4 affine. */
function toAffine(m: THREE.Matrix4): Affine {
  const e = m.elements;
  return [e[0]!, e[4]!, e[8]!, e[12]!, e[1]!, e[5]!, e[9]!, e[13]!, e[2]!, e[6]!, e[10]!, e[14]!];
}

const selectedObjs = () => selectedIds().map((id) => editor.doc.object(id));
const ctx = () => editor.ctx;

/** Merge the selected objects into the active one (or the first selected). */
export function joinObjects(): void {
  const objs = selectedObjs();
  if (objs.length < 2) return showStatus('Join: select two or more objects', 'error');
  const active = activeObject.peek();
  const target = objs.find((o) => o.id === active) ?? objs[0]!;
  const others = objs.filter((o) => o !== target);
  const toTarget = transformToMatrix(target.transform).invert();
  let data = toMeshData(target.mesh);
  for (const o of others) {
    // Other object's local space → world → target's local space.
    const m = toTarget.clone().multiply(transformToMatrix(o.transform));
    data = mergeMeshData(data, transformMeshData(toMeshData(o.mesh), toAffine(m)));
  }
  const cmds: Command[] = [
    new ReplaceMeshCommand(ctx(), target.id, ReplaceMeshCommand.capture(target), { mesh: data, source: null }, 'Join'),
    new RemoveObjectsCommand(ctx(), others.map((o) => o.id), 'Join'),
  ];
  editor.execute(new CompositeCommand('Join Objects', cmds), () => setSelection([target.id], target.id));
}

/**
 * Move the selected faces (in vertex or edge mode: faces whose corners/edges are all selected)
 * into new objects, one per source object, with the same transform.
 */
export function separateSelection(): void {
  const mode = selectionMode.peek();
  if (!isComponentMode(mode)) return showStatus('Separate: select faces in a component mode', 'error');
  const doc = editor.doc;
  const faceSel = convertSelection(doc, componentSelection[mode].peek(), mode, 'face');
  const cmds: Command[] = [];
  const made: SceneObject[] = [];
  let nextId = doc.nextObjectId;
  const names = new Set(doc.objects.map((o) => o.name));
  for (const [id, keys] of faceSel) {
    const obj = doc.object(id);
    const faces = facesOf(obj.mesh, keys);
    if (!faces.length) continue;
    if (faces.length === obj.mesh.faces.size) {
      showStatus(`Separate: that's all of ${obj.name}; nothing would be left`, 'error');
      continue;
    }
    const part = extractFaces(obj.mesh, faces.map((f) => f.id));
    const rest = fromMeshData(toMeshData(obj.mesh));
    deleteFaces(rest, faces.map((f) => rest.face(f.id)));
    let name = `${obj.name} part`;
    for (let i = 2; names.has(name); i++) name = `${obj.name} part ${i}`;
    names.add(name);
    made.push(new SceneObject(nextId++, name, fromMeshData(part), cloneTransform(obj.transform)));
    cmds.push(new ReplaceMeshCommand(ctx(), id, ReplaceMeshCommand.capture(obj), { mesh: toMeshData(rest), source: null }, 'Separate'));
  }
  if (!made.length) return;
  cmds.push(new AddObjectsCommand(ctx(), made, 'Separate'));
  editor.execute(new CompositeCommand('Separate', cmds), () => {
    // Keep editing: the new objects join the edit set, with nothing selected.
    editObjects.value = new Set([...editObjects.peek(), ...made.map((o) => o.id)]);
    setComponents(mode, new Map());
  });
  showStatus(`Separated into ${made.map((o) => o.name).join(', ')}`);
}

/** Bake each selected object's rotation and scale into its mesh (its position stays). */
export function applyRotationScale(): void {
  const cmds: Command[] = [];
  for (const obj of selectedObjs()) {
    const t = obj.transform;
    if (t.rotation.every((r) => r === 0) && t.scale.every((s) => s === 1)) continue;
    const rs = transformToMatrix({ position: [0, 0, 0], rotation: t.rotation, scale: t.scale });
    const after: Transform = { position: [...t.position], rotation: [0, 0, 0], scale: [1, 1, 1] };
    cmds.push(
      new ReplaceMeshCommand(ctx(), obj.id, ReplaceMeshCommand.capture(obj), { mesh: transformMeshData(toMeshData(obj.mesh), toAffine(rs)), source: null }, 'Apply'),
      new SetTransformsCommand(ctx(), [{ id: obj.id, before: cloneTransform(t), after }], 'Apply'),
    );
  }
  if (!cmds.length) return showStatus('Apply: the selected objects have no rotation or scale');
  editor.execute(new CompositeCommand('Apply Rotation & Scale', cmds));
}

export type OriginTarget = 'centre' | 'base' | 'world';

/**
 * Move each selected object's origin without moving its geometry: to the centre of its bounding
 * box, the centre of its base, or the world origin.
 */
export function setOrigin(target: OriginTarget): void {
  const cmds: Command[] = [];
  for (const obj of selectedObjs()) {
    const data = toMeshData(obj.mesh);
    const b = meshBounds(data);
    if (!b) continue;
    let o: Vec3; // the new origin, in the object's current local space
    if (target === 'world') o = inverseTransformPoint(obj.transform, [0, 0, 0]);
    else {
      o = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, target === 'base' ? b.min[2] : (b.min[2] + b.max[2]) / 2];
    }
    o = o.map((x) => Math.round(x * 1e6) / 1e6 + 0) as Vec3;
    if (o.every((x) => Math.abs(x) < 1e-9)) continue;
    const t = obj.transform;
    const position = transformPoint(t, o).map((x) => Math.round(x * 1e6) / 1e6 + 0) as Vec3;
    cmds.push(
      new ReplaceMeshCommand(ctx(), obj.id, ReplaceMeshCommand.capture(obj), { mesh: translateMeshData(data, [-o[0], -o[1], -o[2]]), source: null }, 'Set Origin'),
      new SetTransformsCommand(ctx(), [{ id: obj.id, before: cloneTransform(t), after: { ...cloneTransform(t), position } }], 'Set Origin'),
    );
  }
  if (cmds.length) editor.execute(new CompositeCommand('Set Origin', cmds));
}

/**
 * Mirror the selection across the world axis plane through its centre. Objects: the reflection
 * is baked into their meshes (their transforms stay). Components: the selected vertices are
 * reflected, faces bent by it are folded, and shells that were entirely selected are flipped so
 * they still face out.
 */
export function mirrorSelection(axis: 0 | 1 | 2): void {
  const mode = selectionMode.peek();
  const label = `Mirror ${'XYZ'[axis]}`;
  if (isComponentMode(mode)) return mirrorComponents(mode, axis, label);
  const objs = selectedObjs();
  if (!objs.length) return;
  const centre = objs.reduce((c, o) => c + o.transform.position[axis]!, 0) / objs.length;
  // Reflection in world space: x_axis → 2c − x_axis.
  const s = new THREE.Vector3(1, 1, 1).setComponent(axis, -1);
  const t = new THREE.Vector3().setComponent(axis, 2 * centre);
  const world = new THREE.Matrix4().makeScale(s.x, s.y, s.z).setPosition(t);
  const cmds = objs.map((o) => {
    const w = transformToMatrix(o.transform);
    const local = w.clone().invert().multiply(world).multiply(w);
    return new ReplaceMeshCommand(ctx(), o.id, ReplaceMeshCommand.capture(o), { mesh: transformMeshData(toMeshData(o.mesh), toAffine(local)), source: null }, label);
  });
  editor.execute(cmds.length === 1 ? cmds[0]! : new CompositeCommand(label, cmds));
}

function mirrorComponents(mode: ComponentMode, axis: 0 | 1 | 2, label: string): void {
  const entries = selectedEntries(mode);
  let n = 0;
  let c = 0;
  for (const [obj, keys] of entries) {
    for (const v of verticesOf(obj.mesh, mode, keys)) {
      c += transformPoint(obj.transform, v.pos)[axis]!;
      n++;
    }
  }
  if (!n) return;
  c /= n;
  editMeshes(label, entries, (mesh, keys) => {
    const obj = entries.find(([, k]) => k === keys)![0];
    const verts = verticesOf(mesh, mode, keys);
    for (const v of verts) {
      const w = transformPoint(obj.transform, v.pos);
      w[axis] = 2 * c - w[axis]!;
      v.pos = inverseTransformPoint(obj.transform, w).map((x) => Math.round(x * 1e6) / 1e6 + 0) as Vec3;
    }
    planarizeAround(mesh, verts);
    const moved = new Set(verts.map((v) => v.id));
    const whole = shells(mesh).filter((s) => s.every((f) => f.outer.verts().every((v) => moved.has(v.id))));
    return whole.length ? flipNormals(mesh, whole.flat().map((f) => f.id)).mesh : mesh;
  });
}

/** Snap the selected objects' positions, or the selected vertices, to the grid. */
export function snapSelectionToGrid(): void {
  const step = gridStep.peek();
  const mode = selectionMode.peek();
  if (!isComponentMode(mode)) {
    const changes = selectedObjs()
      .map((o) => ({ id: o.id as ObjectId, before: cloneTransform(o.transform), after: { ...cloneTransform(o.transform), position: snapVec3(o.transform.position, step) } }))
      .filter((c) => c.after.position.some((x, i) => x !== c.before.position[i]));
    if (changes.length) editor.execute(new SetTransformsCommand(ctx(), changes, 'Snap to Grid'));
    return;
  }
  const entries = selectedEntries(mode);
  editMeshes('Snap to Grid', entries, (mesh, keys) => {
    const obj = entries.find(([, k]) => k === keys)![0];
    const verts = verticesOf(mesh, mode, keys);
    for (const v of verts) v.pos = inverseTransformPoint(obj.transform, snapVec3(transformPoint(obj.transform, v.pos), step)).map((x) => Math.round(x * 1e6) / 1e6 + 0) as Vec3;
    planarizeAround(mesh, verts);
  });
}
