import { describe, expect, it } from 'vitest';
import { deserializeDocument, Document, SceneObject, serializeDocument } from './document';
import { fromMeshData } from './halfedge/convert';
import { buildPrimitive, defaultSource } from './primitives';

function sampleDoc(): Document {
  const doc = new Document();
  doc.insertMaterial({ id: 3, name: 'Brick', color: [0.6, 0.2, 0.1] });
  const box = new SceneObject(0, 'Box', fromMeshData(buildPrimitive(defaultSource('box'), 3)));
  box.transform.position = [1, 2, 0];
  box.source = defaultSource('box');
  const cone = new SceneObject(4, 'Cone', fromMeshData(buildPrimitive(defaultSource('cone'))));
  cone.visible = false;
  cone.locked = true;
  doc.insertObject(box);
  doc.insertObject(cone);
  return doc;
}

describe('Document', () => {
  it('round-trips through JSON', () => {
    const doc = sampleDoc();
    const json = JSON.stringify(serializeDocument(doc));
    const restored = deserializeDocument(JSON.parse(json));
    expect(serializeDocument(restored)).toEqual(serializeDocument(doc));
    expect(restored.nextObjectId).toBe(5);
    expect(restored.nextMaterialId).toBe(4);
  });

  it('saves textures that materials use, and drops unused ones', () => {
    const doc = sampleDoc();
    const png = (id: number) => ({ id, name: `t${id}.png`, mime: 'image/png', data: 'data:image/png;base64,AAAA', width: 4, height: 4 });
    doc.insertTexture(png(0));
    doc.insertTexture(png(1));
    doc.findMaterial(3)!.texture = 1;
    doc.findMaterial(3)!.textureSize = [2, 0.5];
    const data = serializeDocument(doc);
    expect(data.textures!.map((t) => t.id)).toEqual([1]);
    const restored = deserializeDocument(JSON.parse(JSON.stringify(data)));
    expect(restored.materialTexture(restored.findMaterial(3)!)?.name).toBe('t1.png');
    expect(restored.findMaterial(3)!.textureSize).toEqual([2, 0.5]);
    expect(restored.nextTextureId).toBe(2);
  });

  it('loads files from before textures existed, and ignores missing images', () => {
    const data = serializeDocument(sampleDoc());
    delete data.textures;
    delete data.nextTextureId;
    data.materials[1]!.texture = 7;
    const restored = deserializeDocument(JSON.parse(JSON.stringify(data)));
    expect(restored.findMaterial(3)!.texture).toBeUndefined();
  });

  it('always has the default material', () => {
    const data = serializeDocument(sampleDoc());
    data.materials = data.materials.filter((m) => m.id !== 0);
    const doc = deserializeDocument(data);
    expect(doc.findMaterial(0)?.name).toBe('Default');
  });

  it('rejects non-documents and unknown versions', () => {
    expect(() => deserializeDocument({ hello: 1 })).toThrow(/Not a lowpoly document/);
    expect(() => deserializeDocument({ ...serializeDocument(sampleDoc()), version: 2 })).toThrow(/version/);
  });

  it('reports which object has bad mesh data', () => {
    const data = serializeDocument(sampleDoc());
    data.objects[1]!.mesh.faces[0]!.loops[0]![0]!.v = 999;
    expect(() => deserializeDocument(data)).toThrow(/Cone.*999/);
  });

  it('generates unique names', () => {
    const doc = sampleDoc();
    expect(doc.uniqueObjectName('Sphere')).toBe('Sphere');
    expect(doc.uniqueObjectName('Box')).toBe('Box 2');
  });

  it('refuses to remove the default material', () => {
    expect(() => new Document().removeMaterial(0)).toThrow(/default/);
  });
});
