import {
  cloneMaterial,
  cloneTransform,
  DEFAULT_MATERIAL_ID,
  type Document,
  type Material,
  type TextureAsset,
  type TextureId,
  type ObjectId,
  type SceneObject,
  type Transform,
} from '../core/document';
import { fromMeshData, toMeshData } from '../core/halfedge/convert';
import type { Vec2, Vec3 } from '../core/math/vec';
import type { MaterialId, MeshData, VertId } from '../core/meshdata';
import type { PrimitiveSource } from '../core/primitives';
import { type Command, CompositeCommand, FnCommand } from '../history/history';

/** What commands may touch besides the document: they can set the selection they produce. */
export interface CommandContext {
  doc: Document;
  selectObjects(ids: ObjectId[]): void;
}

/** Insert objects at the end of the outliner and select them. */
export class AddObjectsCommand implements Command {
  constructor(
    private readonly ctx: CommandContext,
    private readonly objs: SceneObject[],
    readonly label: string,
  ) {}

  apply(): void {
    for (const o of this.objs) this.ctx.doc.insertObject(o);
    this.ctx.selectObjects(this.objs.map((o) => o.id));
  }

  revert(): void {
    for (const o of this.objs) this.ctx.doc.removeObject(o.id);
  }
}

export class RemoveObjectsCommand implements Command {
  private readonly removed: { obj: SceneObject; index: number }[];

  constructor(
    private readonly ctx: CommandContext,
    ids: ObjectId[],
    readonly label = ids.length === 1 ? 'Delete Object' : 'Delete Objects',
  ) {
    this.removed = ids
      .map((id) => ({ obj: ctx.doc.object(id), index: ctx.doc.objectIndex(id) }))
      .sort((a, b) => a.index - b.index);
  }

  apply(): void {
    for (const { obj } of [...this.removed].reverse()) this.ctx.doc.removeObject(obj.id);
    this.ctx.selectObjects([]);
  }

  revert(): void {
    for (const { obj, index } of this.removed) this.ctx.doc.insertObject(obj, index);
  }
}

export interface TransformChange {
  id: ObjectId;
  before: Transform;
  after: Transform;
}

export class SetTransformsCommand implements Command {
  constructor(
    private readonly ctx: CommandContext,
    private readonly changes: TransformChange[],
    readonly label: string,
  ) {}

  apply(): void {
    for (const c of this.changes) this.ctx.doc.object(c.id).transform = cloneTransform(c.after);
  }

  revert(): void {
    for (const c of this.changes) this.ctx.doc.object(c.id).transform = cloneTransform(c.before);
  }
}

export interface ObjectProps {
  name: string;
  visible: boolean;
  locked: boolean;
}

export class SetObjectPropsCommand implements Command {
  private readonly before: Partial<ObjectProps>[];

  constructor(
    private readonly ctx: CommandContext,
    private readonly ids: ObjectId[],
    private readonly after: Partial<ObjectProps>,
    readonly label: string,
  ) {
    this.before = ids.map((id) => {
      const o = ctx.doc.object(id);
      const b: Partial<ObjectProps> = {};
      for (const k of Object.keys(after) as (keyof ObjectProps)[]) (b as Record<string, unknown>)[k] = o[k];
      return b;
    });
  }

  apply(): void {
    for (const id of this.ids) Object.assign(this.ctx.doc.object(id), this.after);
  }

  revert(): void {
    this.ids.forEach((id, i) => Object.assign(this.ctx.doc.object(id), this.before[i]));
  }
}

export interface MeshState {
  mesh: MeshData;
  source: PrimitiveSource | null;
}

/** Replace an object's mesh, storing full before/after snapshots. Used by all mesh edits. */
export class ReplaceMeshCommand implements Command {
  constructor(
    private readonly ctx: CommandContext,
    private readonly id: ObjectId,
    private readonly before: MeshState,
    private readonly after: MeshState,
    readonly label: string,
  ) {}

  static capture(obj: SceneObject): MeshState {
    return { mesh: toMeshData(obj.mesh), source: obj.source ? structuredClone(obj.source) : null };
  }

  apply(): void {
    this.set(this.after);
  }

  revert(): void {
    this.set(this.before);
  }

  private set(s: MeshState): void {
    const obj = this.ctx.doc.object(this.id);
    obj.setMesh(fromMeshData(s.mesh));
    obj.source = s.source ? structuredClone(s.source) : null;
  }
}

export interface VertexMove {
  objectId: ObjectId;
  ids: VertId[];
  before: Vec3[];
  after: Vec3[];
}

/**
 * Move vertices without changing topology. Cheaper than a full mesh snapshot. Any edit turns a
 * parametric primitive into a plain mesh, so `source` is cleared (and restored on undo).
 */
export class MoveVertsCommand implements Command {
  private readonly sources: (PrimitiveSource | null)[];

  constructor(
    private readonly ctx: CommandContext,
    private readonly moves: VertexMove[],
    readonly label: string,
  ) {
    this.sources = moves.map((m) => ctx.doc.object(m.objectId).source);
  }

  apply(): void {
    for (const m of this.moves) this.set(m, m.after, null);
  }

  revert(): void {
    this.moves.forEach((m, i) => this.set(m, m.before, this.sources[i] ?? null));
  }

  private set(m: VertexMove, positions: Vec3[], source: PrimitiveSource | null): void {
    const obj = this.ctx.doc.object(m.objectId);
    m.ids.forEach((id, i) => {
      const p = positions[i]!;
      obj.mesh.vertex(id).pos = [p[0], p[1], p[2]];
    });
    obj.source = source ? structuredClone(source) : null;
    obj.meshRev++;
  }
}

export class AddMaterialCommand implements Command {
  readonly label = 'Add Material';
  constructor(
    private readonly ctx: CommandContext,
    private readonly mat: Material,
  ) {}
  apply(): void {
    this.ctx.doc.insertMaterial(cloneMaterial(this.mat));
  }
  revert(): void {
    this.ctx.doc.removeMaterial(this.mat.id);
  }
}

/** The editable properties of a material. `null` unsets an optional one. */
export interface MaterialProps {
  name: string;
  color: Vec3;
  texture: TextureId | null;
  textureSize: Vec2 | null;
}

function materialProps(m: Material): MaterialProps {
  const { name, color, texture, textureSize } = cloneMaterial(m);
  return { name, color, texture: texture ?? null, textureSize: textureSize ?? null };
}

export class SetMaterialPropsCommand implements Command {
  private readonly before: MaterialProps;
  constructor(
    private readonly ctx: CommandContext,
    private readonly id: MaterialId,
    private readonly after: Partial<MaterialProps>,
    readonly label: string,
    /** Values to restore on undo, when the caller already applied a live preview. */
    before?: Partial<MaterialProps>,
  ) {
    const m = ctx.doc.findMaterial(id);
    if (!m) throw new Error(`No material with id ${id}`);
    this.before = { ...materialProps(m), ...before };
  }
  apply(): void {
    this.set(this.after);
  }
  revert(): void {
    this.set(this.before);
  }
  private set(p: Partial<MaterialProps>): void {
    const m = this.ctx.doc.findMaterial(this.id)!;
    if (p.name !== undefined) m.name = p.name;
    if (p.color !== undefined) m.color = [...p.color];
    if (p.texture !== undefined) {
      if (p.texture === null) delete m.texture;
      else m.texture = p.texture;
    }
    if (p.textureSize !== undefined) {
      if (p.textureSize === null) delete m.textureSize;
      else m.textureSize = [...p.textureSize];
    }
  }
}

/** Add a texture image to the document. */
export class AddTextureCommand implements Command {
  readonly label = 'Add Texture';
  constructor(
    private readonly ctx: CommandContext,
    private readonly tex: TextureAsset,
  ) {}
  apply(): void {
    this.ctx.doc.insertTexture({ ...this.tex });
  }
  revert(): void {
    this.ctx.doc.removeTexture(this.tex.id);
  }
}

/** Set the material of every face of an object. Returns null when nothing would change. */
export function assignObjectMaterialCommand(ctx: CommandContext, obj: SceneObject, material: MaterialId): Command | null {
  const before = ReplaceMeshCommand.capture(obj);
  if (before.mesh.faces.every((f) => f.material === material)) return null;
  const after: MeshState = {
    mesh: { ...before.mesh, faces: before.mesh.faces.map((f) => ({ ...f, material })) },
    source: before.source,
  };
  return new ReplaceMeshCommand(ctx, obj.id, before, after, 'Assign Material');
}

/** Remove a material. Faces using it fall back to the default material. */
export function removeMaterialCommand(ctx: CommandContext, id: MaterialId): Command {
  if (id === DEFAULT_MATERIAL_ID) throw new Error('The default material cannot be removed');
  const cmds: Command[] = [];
  for (const obj of ctx.doc.objects) {
    const before = ReplaceMeshCommand.capture(obj);
    if (!before.mesh.faces.some((f) => f.material === id)) continue;
    const after: MeshState = {
      mesh: {
        ...before.mesh,
        faces: before.mesh.faces.map((f) => (f.material === id ? { ...f, material: DEFAULT_MATERIAL_ID } : f)),
      },
      source: before.source,
    };
    cmds.push(new ReplaceMeshCommand(ctx, obj.id, before, after, 'Reassign Faces'));
  }
  let removed: { mat: Material; index: number } | null = null;
  cmds.push(
    new FnCommand(
      'Remove Material',
      () => (removed = ctx.doc.removeMaterial(id)),
      () => removed && ctx.doc.insertMaterial(removed.mat, removed.index),
    ),
  );
  return new CompositeCommand('Delete Material', cmds);
}
