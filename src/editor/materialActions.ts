import { DEFAULT_MATERIAL_ID, type ObjectId } from '../core/document';
import type { Face } from '../core/halfedge/mesh';
import { type PaintScope, paintTargets } from '../core/ops/paint';

export type { PaintScope };
import type { Vec2 } from '../core/math/vec';
import type { FaceId, MaterialId } from '../core/meshdata';
import { pickImageFile, readTexture } from '../io/texture';
import { CompositeCommand } from '../history/history';
import { AddTextureCommand, SetMaterialPropsCommand } from './commands';
import { editMeshes } from './componentActions';
import { editor } from './editor';
import { activeMaterial, showStatus } from './state';

/** Material textures and the Paint tool (M5). */

/** Ask for an image and give it to the material, as one undo step. */
export async function loadMaterialTexture(id: MaterialId): Promise<void> {
  const file = await pickImageFile();
  if (!file) return;
  await setMaterialTextureFromFile(id, file);
}

/** Embed an image file as a texture of the material (also used for drag-and-drop and tests). */
export async function setMaterialTextureFromFile(id: MaterialId, file: Blob & { name?: string }): Promise<void> {
  let asset;
  try {
    asset = await readTexture(file);
  } catch (e) {
    showStatus(`Load texture: ${(e as Error).message}`, 'error');
    return;
  }
  const doc = editor.doc;
  if (!doc.findMaterial(id)) return;
  const tex = { ...asset, id: doc.nextTextureId };
  editor.execute(
    new CompositeCommand('Load Texture', [
      new AddTextureCommand(editor.ctx, tex),
      new SetMaterialPropsCommand(editor.ctx, id, { texture: tex.id }, 'Set Texture'),
    ]),
  );
}

export function clearMaterialTexture(id: MaterialId): void {
  const m = editor.doc.findMaterial(id);
  if (m?.texture == null) return;
  editor.execute(new SetMaterialPropsCommand(editor.ctx, id, { texture: null }, 'Clear Texture'));
}

export function setMaterialTextureSize(id: MaterialId, size: Vec2): void {
  const m = editor.doc.findMaterial(id);
  if (!m || !(size[0] > 0 && size[1] > 0)) return;
  const cur = m.textureSize ?? [1, 1];
  if (cur[0] === size[0] && cur[1] === size[1]) return;
  editor.execute(new SetMaterialPropsCommand(editor.ctx, id, { textureSize: [...size] }, 'Texture Size'));
}

/** The material to paint with, falling back to the default if it was deleted. */
export function paintMaterial(): MaterialId {
  const id = activeMaterial.peek();
  return editor.doc.findMaterial(id) ? id : DEFAULT_MATERIAL_ID;
}

/** Paint faces with the active material, as one undo step. */
export function paintFaces(objectId: ObjectId, faceIds: FaceId[], scope: PaintScope): void {
  const obj = editor.doc.findObject(objectId);
  if (!obj || !faceIds.length) return;
  const material = paintMaterial();
  editMeshes('Paint', [[obj, new Set(faceIds)]], (mesh, keys) => {
    const clicked = [...keys].map((k) => mesh.faces.get(k as number)).filter((f): f is Face => !!f);
    const ids = scope === 'face' || clicked.length !== 1 ? clicked.map((f) => f.id) : paintTargets(mesh.faces.values(), clicked[0]!, scope);
    for (const id of ids) mesh.face(id).material = material;
  });
}

/** Alt+click with the Paint tool: make the face's material the active one. */
export function sampleMaterial(objectId: ObjectId, faceId: FaceId): void {
  const f = editor.doc.findObject(objectId)?.mesh.faces.get(faceId);
  if (!f) return;
  activeMaterial.value = f.material;
  showStatus(`Paint material: ${editor.doc.findMaterial(f.material)?.name ?? 'Default'}`);
}
