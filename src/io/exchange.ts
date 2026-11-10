import { DEFAULT_MATERIAL_ID, type Material, SceneObject, type TextureAsset } from '../core/document';
import { fromMeshData } from '../core/halfedge/convert';
import { AddMaterialCommand, AddObjectsCommand, AddTextureCommand } from '../editor/commands';
import { editor } from '../editor/editor';
import { selectedObjects } from '../editor/selection';
import { showStatus } from '../editor/state';
import { type Command, CompositeCommand } from '../history/history';
import { documentImages, exportGLB, type GlbImage } from './gltf';
import { exportOBJ, parseMTL, parseOBJ, safeName } from './obj';
import { downloadBlob } from './file';
import { loadImage, readTexture } from './texture';
import { zip } from './zip';

/** File menu: OBJ import, OBJ/GLB export (browser side: file pickers, downloads, images). */

/** The selected objects, or every visible object when nothing is selected. */
function exportObjects(): SceneObject[] {
  const doc = editor.doc;
  const sel = doc.objects.filter((o) => selectedObjects.peek().has(o.id));
  return sel.length ? sel : doc.objects.filter((o) => o.visible);
}

const baseName = () => safeName(editor.fileName.value, 'model');

/** OBJ + MTL + textures, as one ZIP download. */
export function exportOBJFile(): void {
  const objs = exportObjects();
  if (!objs.length) return showStatus('Nothing to export', 'error');
  const files = exportOBJ(editor.doc, objs, baseName());
  downloadBlob(`${baseName()}.zip`, zip(files), 'application/zip');
  showStatus(`Exported ${objs.length} object${objs.length === 1 ? '' : 's'} as OBJ (${files.length} files, zipped)`);
}

/** Binary glTF. Textures that aren't PNG or JPEG are converted to PNG first. */
export async function exportGLBFile(): Promise<void> {
  const objs = exportObjects();
  if (!objs.length) return showStatus('Nothing to export', 'error');
  const doc = editor.doc;
  const images = documentImages(doc);
  for (const t of doc.textures) {
    if (images.has(t.id)) continue;
    try {
      images.set(t.id, await toPNG(t));
    } catch {
      // Leave it out; the material keeps its colour.
    }
  }
  downloadBlob(`${baseName()}.glb`, exportGLB(doc, objs, images), 'model/gltf-binary');
  showStatus(`Exported ${objs.length} object${objs.length === 1 ? '' : 's'} as GLB`);
}

async function toPNG(t: TextureAsset): Promise<GlbImage> {
  const img = await loadImage(t.data);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not convert image');
  return { mime: 'image/png', bytes: new Uint8Array(await blob.arrayBuffer()) };
}

function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = accept;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

const fileKey = (path: string) => path.replace(/\\/g, '/').split('/').pop()!.toLowerCase();

/**
 * Import OBJ files. Pick the .obj together with its .mtl and texture images (browsers can't read
 * neighbouring files by themselves); missing ones just leave materials plain. One undo step.
 */
export async function importOBJFiles(files?: File[]): Promise<void> {
  const picked = files ?? (await pickFiles('.obj,.mtl,image/png,image/jpeg,image/webp,image/gif'));
  const objFiles = picked.filter((f) => /\.obj$/i.test(f.name));
  if (!picked.length) return;
  if (!objFiles.length) return showStatus('Import: choose an .obj file (with its .mtl and images, if any)', 'error');
  const byName = new Map(picked.map((f) => [fileKey(f.name), f]));
  const doc = editor.doc;
  const cmds: Command[] = [];
  const objects: SceneObject[] = [];
  const warnings: string[] = [];
  let nextMat = doc.nextMaterialId;
  let nextTex = doc.nextTextureId;
  let nextObj = doc.nextObjectId;
  const usedNames = new Set(doc.objects.map((o) => o.name));
  const uniqueName = (n: string) => {
    let name = n;
    for (let i = 2; usedNames.has(name); i++) name = `${n} ${i}`;
    usedNames.add(name);
    return name;
  };
  const textures = new Map<string, number>();

  for (const file of objFiles) {
    const parsed = parseOBJ(await file.text(), file.name.replace(/\.obj$/i, ''));
    warnings.push(...parsed.warnings);
    const mtlFiles = parsed.mtllibs.map((n) => byName.get(fileKey(n))).filter((f): f is File => !!f);
    if (!mtlFiles.length) mtlFiles.push(...picked.filter((f) => /\.mtl$/i.test(f.name)));
    const mtl = (await Promise.all(mtlFiles.map((f) => f.text()))).flatMap(parseMTL);

    // One new material per slot used (slot 0, "no material", is the default).
    const slotMaterial = new Map<number, number>([[0, DEFAULT_MATERIAL_ID]]);
    for (let s = 1; s < parsed.slots.length; s++) {
      const name = parsed.slots[s]!;
      const def = mtl.find((m) => m.name === name);
      const mat: Material = { id: nextMat++, name, color: def?.color ?? [0.8, 0.8, 0.8] };
      if (def?.texture) {
        const key = fileKey(def.texture);
        let texId = textures.get(key);
        const img = byName.get(key);
        if (texId === undefined && img) {
          try {
            const asset = await readTexture(img);
            texId = nextTex++;
            textures.set(key, texId);
            cmds.push(new AddTextureCommand(editor.ctx, { ...asset, id: texId }));
          } catch {
            warnings.push(`could not read ${img.name}`);
          }
        } else if (!img) warnings.push(`texture ${def.texture} wasn't chosen`);
        if (texId !== undefined) mat.texture = texId;
      }
      cmds.push(new AddMaterialCommand(editor.ctx, mat));
      slotMaterial.set(s, mat.id);
    }

    for (const o of parsed.objects) {
      for (const f of o.data.faces) f.material = slotMaterial.get(f.material) ?? DEFAULT_MATERIAL_ID;
      objects.push(
        new SceneObject(nextObj++, uniqueName(o.name), fromMeshData(o.data), {
          position: o.origin,
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        }),
      );
    }
  }
  if (!objects.length) return showStatus('Import: no faces found', 'error');
  cmds.push(new AddObjectsCommand(editor.ctx, objects, 'Import OBJ'));
  editor.execute(new CompositeCommand('Import OBJ', cmds));
  const note = [...new Set(warnings)];
  showStatus(
    `Imported ${objects.length} object${objects.length === 1 ? '' : 's'}${note.length ? ` (${note.join('; ')})` : ''}`,
    note.length ? 'error' : 'info',
  );
}
