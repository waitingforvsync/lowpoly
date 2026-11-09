import { describe, expect, it } from 'vitest';
import { Document, identityTransform, SceneObject, serializeDocument } from '../core/document';
import { fromMeshData } from '../core/halfedge/convert';
import { buildPrimitive, defaultSource } from '../core/primitives';
import {
  AddMaterialCommand,
  AddObjectsCommand,
  assignObjectMaterialCommand,
  type CommandContext,
  RemoveObjectsCommand,
  removeMaterialCommand,
  ReplaceMeshCommand,
  SetMaterialPropsCommand,
  SetObjectPropsCommand,
  SetTransformsCommand,
} from './commands';

function setup(n = 3) {
  const doc = new Document();
  let selected: number[] = [];
  const ctx: CommandContext = { doc, selectObjects: (ids) => (selected = ids) };
  for (let i = 0; i < n; i++) {
    doc.insertObject(new SceneObject(i, `Box ${i}`, fromMeshData(buildPrimitive(defaultSource('box')))));
  }
  return { doc, ctx, selected: () => selected };
}

/**
 * Apply then revert, checking the document returns to exactly its original serialized state.
 * Id counters are excluded: they only ever grow, so undone ids are never reused.
 */
function roundTrip(doc: Document, cmd: { apply(): void; revert(): void }) {
  const state = () => {
    const { nextObjectId: _o, nextMaterialId: _m, ...rest } = serializeDocument(doc);
    return rest;
  };
  const before = state();
  cmd.apply();
  const after = state();
  expect(after).not.toEqual(before);
  cmd.revert();
  expect(state()).toEqual(before);
  cmd.apply();
  expect(state()).toEqual(after);
}

describe('object commands', () => {
  it('AddObjectsCommand inserts and selects', () => {
    const { doc, ctx, selected } = setup(1);
    const obj = new SceneObject(7, 'New', fromMeshData(buildPrimitive(defaultSource('cone'))));
    roundTrip(doc, new AddObjectsCommand(ctx, [obj], 'Add'));
    expect(doc.objects.map((o) => o.id)).toEqual([0, 7]);
    expect(selected()).toEqual([7]);
  });

  it('RemoveObjectsCommand restores the original order', () => {
    const { doc, ctx } = setup(4);
    roundTrip(doc, new RemoveObjectsCommand(ctx, [2, 0]));
    expect(doc.objects.map((o) => o.id)).toEqual([1, 3]);
  });

  it('SetTransformsCommand', () => {
    const { doc, ctx } = setup();
    const after = identityTransform();
    after.position = [1, 2, 3];
    after.rotation = [0, 0, 45];
    roundTrip(doc, new SetTransformsCommand(ctx, [{ id: 1, before: identityTransform(), after }], 'Move'));
    expect(doc.object(1).transform.position).toEqual([1, 2, 3]);
  });

  it('SetObjectPropsCommand only touches the given props', () => {
    const { doc, ctx } = setup();
    roundTrip(doc, new SetObjectPropsCommand(ctx, [0, 2], { visible: false }, 'Hide'));
    expect(doc.objects.map((o) => o.visible)).toEqual([false, true, false]);
    expect(doc.object(0).name).toBe('Box 0');
  });

  it('ReplaceMeshCommand swaps meshes and bumps the revision', () => {
    const { doc, ctx } = setup(1);
    const obj = doc.object(0);
    const before = ReplaceMeshCommand.capture(obj);
    const cyl = defaultSource('cylinder');
    const after = { mesh: buildPrimitive(cyl), source: cyl };
    const rev = obj.meshRev;
    roundTrip(doc, new ReplaceMeshCommand(ctx, 0, before, after, 'Edit'));
    expect(obj.meshRev).toBeGreaterThan(rev);
    expect(obj.mesh.faces.size).toBe(10);
    expect(obj.source).toEqual(cyl);
  });
});

describe('material commands', () => {
  it('AddMaterialCommand and SetMaterialPropsCommand', () => {
    const { doc, ctx } = setup(0);
    roundTrip(doc, new AddMaterialCommand(ctx, { id: 5, name: 'Red', color: [1, 0, 0] }));
    roundTrip(doc, new SetMaterialPropsCommand(ctx, 5, { color: [0, 1, 0] }, 'Colour'));
    expect(doc.findMaterial(5)!.color).toEqual([0, 1, 0]);
  });

  it('SetMaterialPropsCommand can restore an explicit pre-preview value', () => {
    const { doc, ctx } = setup(0);
    const m = doc.findMaterial(0)!;
    const original = { name: m.name, color: [...m.color] as [number, number, number] };
    m.color = [0.5, 0.5, 0.5]; // live preview already applied
    const cmd = new SetMaterialPropsCommand(ctx, 0, { color: [0.5, 0.5, 0.5] }, 'Colour', original);
    cmd.apply();
    cmd.revert();
    expect(m.color).toEqual(original.color);
  });

  it('assignObjectMaterialCommand sets every face, and is null when nothing changes', () => {
    const { doc, ctx } = setup(1);
    expect(assignObjectMaterialCommand(ctx, doc.object(0), 0)).toBeNull();
    doc.insertMaterial({ id: 1, name: 'Blue', color: [0, 0, 1] });
    roundTrip(doc, assignObjectMaterialCommand(ctx, doc.object(0), 1)!);
    expect([...doc.object(0).mesh.faces.values()].every((f) => f.material === 1)).toBe(true);
  });

  it('removeMaterialCommand reassigns faces to the default and restores them on undo', () => {
    const { doc, ctx } = setup(2);
    doc.insertMaterial({ id: 1, name: 'Blue', color: [0, 0, 1] });
    assignObjectMaterialCommand(ctx, doc.object(1), 1)!.apply();
    const cmd = removeMaterialCommand(ctx, 1);
    roundTrip(doc, cmd);
    expect(doc.findMaterial(1)).toBeUndefined();
    expect([...doc.object(1).mesh.faces.values()].every((f) => f.material === 0)).toBe(true);
  });

  it('refuses to remove the default material', () => {
    const { ctx } = setup(0);
    expect(() => removeMaterialCommand(ctx, 0)).toThrow(/default/);
  });
});
