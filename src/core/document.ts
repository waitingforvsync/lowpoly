import type { Vec2, Vec3 } from './math/vec';
import type { MaterialId, MeshData } from './meshdata';
import { fromMeshData, toMeshData } from './halfedge/convert';
import type { HalfEdgeMesh } from './halfedge/mesh';
import type { PrimitiveSource } from './primitives';

export type ObjectId = number;

/** Object transform. Rotation is XYZ Euler angles in degrees, applied X then Y then Z. */
export interface Transform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export function identityTransform(): Transform {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}

export function cloneTransform(t: Transform): Transform {
  return { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] };
}

export function transformsEqual(a: Transform, b: Transform): boolean {
  const eq = (x: Vec3, y: Vec3) => x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
  return eq(a.position, b.position) && eq(a.rotation, b.rotation) && eq(a.scale, b.scale);
}

export class SceneObject {
  /** Bumped whenever `mesh` is replaced or edited, so renderers know to rebuild geometry. */
  meshRev = 0;

  constructor(
    readonly id: ObjectId,
    public name: string,
    public mesh: HalfEdgeMesh,
    public transform: Transform = identityTransform(),
    public visible = true,
    public locked = false,
    /** Set while the mesh is still an unedited primitive, so its parameters stay editable. */
    public source: PrimitiveSource | null = null,
  ) {}

  setMesh(mesh: HalfEdgeMesh): void {
    this.mesh = mesh;
    this.meshRev++;
  }
}

export type TextureId = number;

/** An image embedded in the document (as a data URL), used by materials. */
export interface TextureAsset {
  id: TextureId;
  name: string;
  mime: string;
  /** `data:` URL of the image. */
  data: string;
  width: number;
  height: number;
}

export interface Material {
  id: MaterialId;
  name: string;
  /** sRGB, each component 0..1. Shown when the material has no texture (or textures are off). */
  color: Vec3;
  /** Image texture, if any. */
  texture?: TextureId | null;
  /**
   * World size of one repeat of the texture, [width, height]. UVs are in world units, so this
   * is how big the image appears on faces. Defaults to 1 × 1.
   */
  textureSize?: Vec2;
}

export const DEFAULT_TEXTURE_SIZE: Vec2 = [1, 1];

export function cloneMaterial(m: Material): Material {
  const out: Material = { id: m.id, name: m.name, color: [...m.color] };
  if (m.texture != null) out.texture = m.texture;
  if (m.textureSize) out.textureSize = [...m.textureSize];
  return out;
}

export const DEFAULT_MATERIAL_ID: MaterialId = 0;

export function defaultMaterial(): Material {
  return { id: DEFAULT_MATERIAL_ID, name: 'Default', color: [0.85, 0.85, 0.85] };
}

export class Document {
  /** Objects in outliner order. */
  readonly objects: SceneObject[] = [];
  /** Materials in outliner order. Always contains the default material. */
  readonly materials: Material[] = [defaultMaterial()];
  /** Texture images. Kept while unused (undo may need them); saving keeps only used ones. */
  readonly textures: TextureAsset[] = [];
  nextObjectId: ObjectId = 0;
  nextMaterialId: MaterialId = 1;
  nextTextureId: TextureId = 0;

  findObject(id: ObjectId): SceneObject | undefined {
    return this.objects.find((o) => o.id === id);
  }

  object(id: ObjectId): SceneObject {
    const o = this.findObject(id);
    if (!o) throw new Error(`No object with id ${id}`);
    return o;
  }

  objectIndex(id: ObjectId): number {
    return this.objects.findIndex((o) => o.id === id);
  }

  insertObject(obj: SceneObject, index = this.objects.length): void {
    if (this.findObject(obj.id)) throw new Error(`Object id ${obj.id} already in use`);
    this.objects.splice(index, 0, obj);
    this.nextObjectId = Math.max(this.nextObjectId, obj.id + 1);
  }

  removeObject(id: ObjectId): { obj: SceneObject; index: number } {
    const index = this.objectIndex(id);
    if (index < 0) throw new Error(`No object with id ${id}`);
    const [obj] = this.objects.splice(index, 1);
    return { obj: obj!, index };
  }

  findMaterial(id: MaterialId): Material | undefined {
    return this.materials.find((m) => m.id === id);
  }

  insertMaterial(mat: Material, index = this.materials.length): void {
    if (this.findMaterial(mat.id)) throw new Error(`Material id ${mat.id} already in use`);
    this.materials.splice(index, 0, mat);
    this.nextMaterialId = Math.max(this.nextMaterialId, mat.id + 1);
  }

  removeMaterial(id: MaterialId): { mat: Material; index: number } {
    if (id === DEFAULT_MATERIAL_ID) throw new Error('The default material cannot be removed');
    const index = this.materials.findIndex((m) => m.id === id);
    if (index < 0) throw new Error(`No material with id ${id}`);
    const [mat] = this.materials.splice(index, 1);
    return { mat: mat!, index };
  }

  findTexture(id: TextureId): TextureAsset | undefined {
    return this.textures.find((t) => t.id === id);
  }

  insertTexture(tex: TextureAsset): void {
    if (this.findTexture(tex.id)) throw new Error(`Texture id ${tex.id} already in use`);
    this.textures.push(tex);
    this.nextTextureId = Math.max(this.nextTextureId, tex.id + 1);
  }

  removeTexture(id: TextureId): void {
    const i = this.textures.findIndex((t) => t.id === id);
    if (i >= 0) this.textures.splice(i, 1);
  }

  /** The texture a material shows, if it has one and it exists. */
  materialTexture(m: Material): TextureAsset | undefined {
    return m.texture != null ? this.findTexture(m.texture) : undefined;
  }

  /** A name not used by any object, built from `base` ("Box", "Box 2", "Box 3", ...). */
  uniqueObjectName(base: string): string {
    const names = new Set(this.objects.map((o) => o.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }
}

// -------------------------------------------------------------------------------------------------
// Serialization
// -------------------------------------------------------------------------------------------------

export interface ObjectData {
  id: ObjectId;
  name: string;
  transform: Transform;
  visible: boolean;
  locked: boolean;
  source: PrimitiveSource | null;
  mesh: MeshData;
}

export interface DocumentData {
  format: 'lowpoly';
  version: 1;
  objects: ObjectData[];
  materials: Material[];
  /** Added after the first release of the format; absent in older files. */
  textures?: TextureAsset[];
  nextObjectId: ObjectId;
  nextMaterialId: MaterialId;
  nextTextureId?: TextureId;
}

export function objectToData(o: SceneObject): ObjectData {
  return {
    id: o.id,
    name: o.name,
    transform: cloneTransform(o.transform),
    visible: o.visible,
    locked: o.locked,
    source: o.source ? structuredClone(o.source) : null,
    mesh: toMeshData(o.mesh),
  };
}

export function objectFromData(d: ObjectData): SceneObject {
  return new SceneObject(
    d.id,
    d.name,
    fromMeshData(d.mesh),
    cloneTransform(d.transform),
    d.visible,
    d.locked,
    d.source ? structuredClone(d.source) : null,
  );
}

export function serializeDocument(doc: Document): DocumentData {
  return {
    format: 'lowpoly',
    version: 1,
    objects: doc.objects.map(objectToData),
    materials: doc.materials.map(cloneMaterial),
    // Only textures some material uses.
    textures: doc.textures.filter((t) => doc.materials.some((m) => m.texture === t.id)).map((t) => ({ ...t })),
    nextObjectId: doc.nextObjectId,
    nextMaterialId: doc.nextMaterialId,
    nextTextureId: doc.nextTextureId,
  };
}

export class DocumentFormatError extends Error {
  override name = 'DocumentFormatError';
}

/** Rebuild a document from saved data. Throws DocumentFormatError or MeshError on bad input. */
export function deserializeDocument(data: unknown): Document {
  const d = data as Partial<DocumentData> | null;
  if (!d || typeof d !== 'object' || d.format !== 'lowpoly') {
    throw new DocumentFormatError('Not a lowpoly document');
  }
  if (d.version !== 1) throw new DocumentFormatError(`Unsupported document version ${String(d.version)}`);
  if (!Array.isArray(d.objects) || !Array.isArray(d.materials)) {
    throw new DocumentFormatError('Document is missing objects or materials');
  }

  const doc = new Document();
  doc.materials.length = 0;
  for (const t of d.textures ?? []) doc.insertTexture({ ...t });
  for (const m of d.materials) {
    const mat = cloneMaterial(m);
    if (mat.texture != null && !doc.findTexture(mat.texture)) delete mat.texture; // missing image
    doc.insertMaterial(mat);
  }
  if (!doc.findMaterial(DEFAULT_MATERIAL_ID)) doc.insertMaterial(defaultMaterial(), 0);

  for (const o of d.objects) {
    try {
      doc.insertObject(objectFromData(o));
    } catch (e) {
      throw new DocumentFormatError(`Object "${o.name}" (${o.id}): ${(e as Error).message}`);
    }
  }
  doc.nextObjectId = Math.max(doc.nextObjectId, d.nextObjectId ?? 0);
  doc.nextMaterialId = Math.max(doc.nextMaterialId, d.nextMaterialId ?? 0);
  doc.nextTextureId = Math.max(doc.nextTextureId, d.nextTextureId ?? 0);
  return doc;
}
