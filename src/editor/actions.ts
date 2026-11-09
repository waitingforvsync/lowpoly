import {
  cloneTransform,
  DEFAULT_MATERIAL_ID,
  objectFromData,
  objectToData,
  type ObjectId,
  SceneObject,
  type Transform,
  transformsEqual,
} from '../core/document';
import { fromMeshData } from '../core/halfedge/convert';
import type { Vec3 } from '../core/math/vec';
import type { MaterialId } from '../core/meshdata';
import {
  buildPrimitive,
  defaultSource,
  PRIMITIVES,
  type PrimitiveSource,
  type PrimitiveType,
  sanitizeSource,
} from '../core/primitives';
import { CompositeCommand, type Command } from '../history/history';
import {
  AddMaterialCommand,
  AddObjectsCommand,
  assignObjectMaterialCommand,
  RemoveObjectsCommand,
  removeMaterialCommand,
  ReplaceMeshCommand,
  SetMaterialPropsCommand,
  SetObjectPropsCommand,
  SetTransformsCommand,
} from './commands';
import { editor } from './editor';
import { clearSelection, selectedObjects, setSelection } from './selection';

/** User-facing operations. Each builds a command and runs it through the history. */

const doc = () => editor.doc;
const ctx = () => editor.ctx;

export function selectedIds(): ObjectId[] {
  return doc()
    .objects.filter((o) => selectedObjects.value.has(o.id))
    .map((o) => o.id);
}

// --- Objects ----------------------------------------------------------------------------------

export function createPrimitive(type: PrimitiveType, position: Vec3 = [0, 0, 0]): void {
  const src = defaultSource(type);
  const d = doc();
  const obj = new SceneObject(
    d.nextObjectId,
    d.uniqueObjectName(PRIMITIVES[type].label),
    fromMeshData(buildPrimitive(src)),
    { position: [...position], rotation: [0, 0, 0], scale: [1, 1, 1] },
    true,
    false,
    src,
  );
  editor.execute(new AddObjectsCommand(ctx(), [obj], `Create ${PRIMITIVES[type].label}`));
}

export function deleteSelection(): void {
  const ids = selectedIds();
  if (ids.length) editor.execute(new RemoveObjectsCommand(ctx(), ids));
}

export function duplicateSelection(): void {
  const d = doc();
  const ids = selectedIds();
  if (!ids.length) return;
  let nextId = d.nextObjectId;
  const taken = new Set(d.objects.map((o) => o.name));
  const copies = ids.map((id) => {
    const data = objectToData(d.object(id));
    data.id = nextId++;
    data.name = uniqueName(data.name, taken);
    taken.add(data.name);
    return objectFromData(data);
  });
  editor.execute(new AddObjectsCommand(ctx(), copies, ids.length === 1 ? 'Duplicate Object' : 'Duplicate Objects'));
}

function uniqueName(name: string, taken: Set<string>): string {
  const base = name.replace(/ \d+$/, '');
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

export function setTransforms(changes: { id: ObjectId; before: Transform; after: Transform }[], label: string): void {
  const real = changes.filter((c) => !transformsEqual(c.before, c.after));
  if (real.length) editor.execute(new SetTransformsCommand(ctx(), real, label));
}

export function setObjectTransform(id: ObjectId, after: Transform, label = 'Set Transform'): void {
  const before = cloneTransform(doc().object(id).transform);
  setTransforms([{ id, before, after }], label);
}

export function renameObject(id: ObjectId, name: string): void {
  const trimmed = name.trim();
  if (!trimmed || trimmed === doc().object(id).name) return;
  editor.execute(new SetObjectPropsCommand(ctx(), [id], { name: trimmed }, 'Rename Object'));
}

export function setObjectsVisible(ids: ObjectId[], visible: boolean): void {
  if (!ids.length) return;
  editor.execute(new SetObjectPropsCommand(ctx(), ids, { visible }, visible ? 'Show' : 'Hide'));
}

export function setObjectsLocked(ids: ObjectId[], locked: boolean): void {
  if (ids.length) editor.execute(new SetObjectPropsCommand(ctx(), ids, { locked }, locked ? 'Lock' : 'Unlock'));
}

/** Change an unedited primitive's parameters, regenerating its mesh. */
export function setPrimitiveSource(id: ObjectId, src: PrimitiveSource): void {
  const obj = doc().object(id);
  const clean = sanitizeSource(src);
  if (JSON.stringify(clean) === JSON.stringify(obj.source)) return;
  const before = ReplaceMeshCommand.capture(obj);
  const material = before.mesh.faces[0]?.material ?? DEFAULT_MATERIAL_ID;
  const after = { mesh: buildPrimitive(clean, material), source: clean };
  editor.execute(new ReplaceMeshCommand(ctx(), id, before, after, `Edit ${PRIMITIVES[clean.type].label}`));
}

// --- Selection (not undoable) -----------------------------------------------------------------

const selectable = () => doc().objects.filter((o) => o.visible && !o.locked);

export function selectAll(): void {
  setSelection(selectable().map((o) => o.id));
}

export function selectNone(): void {
  clearSelection();
}

export function invertSelection(): void {
  setSelection(
    selectable()
      .filter((o) => !selectedObjects.value.has(o.id))
      .map((o) => o.id),
  );
}

// --- Materials --------------------------------------------------------------------------------

const PALETTE: Vec3[] = [
  [0.85, 0.33, 0.27],
  [0.95, 0.66, 0.25],
  [0.42, 0.7, 0.36],
  [0.27, 0.55, 0.85],
  [0.6, 0.42, 0.8],
  [0.55, 0.42, 0.3],
];

export function addMaterial(): MaterialId {
  const d = doc();
  const id = d.nextMaterialId;
  const color = PALETTE[(d.materials.length - 1) % PALETTE.length]!;
  editor.execute(new AddMaterialCommand(ctx(), { id, name: `Material ${id}`, color: [...color] }));
  return id;
}

/** Live colour preview while a picker is open (no history entry). */
export function previewMaterialColor(id: MaterialId, color: Vec3): void {
  const m = doc().findMaterial(id);
  if (!m) return;
  m.color = [...color];
  editor.notifyPreview();
}

export function commitMaterialColor(id: MaterialId, color: Vec3, before: Vec3): void {
  const m = doc().findMaterial(id);
  if (!m) return;
  if (before.every((c, i) => c === color[i])) return;
  editor.execute(
    new SetMaterialPropsCommand(ctx(), id, { color: [...color] }, 'Material Colour', { name: m.name, color: before }),
  );
}

export function renameMaterial(id: MaterialId, name: string): void {
  const m = doc().findMaterial(id);
  const trimmed = name.trim();
  if (!m || !trimmed || trimmed === m.name) return;
  editor.execute(new SetMaterialPropsCommand(ctx(), id, { name: trimmed }, 'Rename Material'));
}

export function deleteMaterial(id: MaterialId): void {
  if (id !== DEFAULT_MATERIAL_ID) editor.execute(removeMaterialCommand(ctx(), id));
}

export function assignMaterial(ids: ObjectId[], material: MaterialId): void {
  const cmds = ids
    .map((id) => assignObjectMaterialCommand(ctx(), doc().object(id), material))
    .filter((c): c is Command => c !== null);
  if (cmds.length) editor.execute(new CompositeCommand('Assign Material', cmds));
}

/** The single material used by every face of the object, or null when mixed. */
export function objectMaterial(id: ObjectId): MaterialId | null {
  let found: MaterialId | null = null;
  for (const f of doc().object(id).mesh.faces.values()) {
    if (found === null) found = f.material;
    else if (found !== f.material) return null;
  }
  return found;
}
