import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { cloneTransform, type ObjectId, type Transform } from '../core/document';
import type { Vec3 } from '../core/math/vec';
import type { VertId } from '../core/meshdata';
import { setTransforms } from '../editor/actions';
import { commitVertexMoves } from '../editor/componentActions';
import { verticesOf } from '../editor/components';
import { editor } from '../editor/editor';
import type { ComponentMode, ComponentSet } from '../editor/selection';
import type { ToolId } from '../editor/tools';
import { applyTransform, matrixToTransform, transformToMatrix } from './transformMath';

export type TransformSpace = 'world' | 'local';

export interface GizmoSettings {
  tool: ToolId;
  space: TransformSpace;
  snap: boolean;
  gridStep: number;
  rotationStepDeg: number;
}

/** What the gizmo moves: whole objects, or the selected components of the edit objects. */
export type GizmoTargets =
  | { kind: 'objects'; ids: ReadonlySet<ObjectId> }
  | { kind: 'components'; mode: ComponentMode; selection: ComponentSet };

const TOOL_MODES: Partial<Record<ToolId, 'translate' | 'rotate' | 'scale'>> = {
  move: 'translate',
  rotate: 'rotate',
  scale: 'scale',
};

const VERBS = { translate: 'Move', rotate: 'Rotate', scale: 'Scale' } as const;
const NOUNS: Record<ComponentMode, string> = { vertex: 'Vertices', edge: 'Edges', face: 'Faces' };

interface ObjectDrag {
  kind: 'objects';
  objects: { id: ObjectId; matrix: THREE.Matrix4; before: Transform }[];
}

interface VertexDrag {
  kind: 'components';
  mode: ComponentMode;
  objects: {
    id: ObjectId;
    world: THREE.Matrix4;
    inverse: THREE.Matrix4;
    ids: VertId[];
    local: THREE.Vector3[];
    before: Vec3[];
  }[];
}

type DragState = (ObjectDrag | VertexDrag) & { pivotInverse: THREE.Matrix4 };

/**
 * Move/rotate/scale gizmo. Three's TransformControls drives a hidden pivot. Each drag frame,
 * the pivot's change since the drag started is applied to the targets as a live preview. On
 * release, one undoable command records the change.
 */
export class Gizmo {
  readonly controls: TransformControls;
  private readonly pivot = new THREE.Object3D();
  private drag: DragState | null = null;
  private targets: GizmoTargets = { kind: 'objects', ids: new Set() };

  constructor(camera: THREE.Camera, dom: HTMLElement, scene: THREE.Scene, onDraggingChanged: (d: boolean) => void) {
    this.pivot.name = 'gizmo-pivot';
    scene.add(this.pivot);
    this.controls = new TransformControls(camera, dom);
    this.controls.setSize(0.9);
    scene.add(this.controls.getHelper());

    this.controls.addEventListener('dragging-changed', (e) => onDraggingChanged(e.value as boolean));
    this.controls.addEventListener('mouseDown', () => this.beginDrag());
    this.controls.addEventListener('objectChange', () => this.updateDrag());
    this.controls.addEventListener('mouseUp', () => this.endDrag());
  }

  get dragging(): boolean {
    return this.controls.dragging;
  }

  setCamera(camera: THREE.Camera): void {
    this.controls.camera = camera;
  }

  /** Re-target the gizmo after any document or selection change (ignored mid-drag). */
  update(targets: GizmoTargets, settings: GizmoSettings): void {
    this.controls.translationSnap = settings.snap ? settings.gridStep : null;
    this.controls.rotationSnap = settings.snap ? THREE.MathUtils.degToRad(settings.rotationStepDeg) : null;
    this.controls.scaleSnap = settings.snap ? 0.1 : null;
    if (this.drag) return;
    this.targets = targets;

    const mode = TOOL_MODES[settings.tool];
    const frame = mode ? this.pivotFrame(targets, settings.space) : null;
    if (!mode || !frame) {
      this.controls.detach();
      return;
    }
    this.controls.setMode(mode);
    this.controls.setSpace(frame.single ? settings.space : 'world');
    this.pivot.position.copy(frame.position);
    this.pivot.quaternion.copy(frame.rotation);
    this.pivot.scale.set(1, 1, 1);
    this.pivot.updateMatrixWorld(true);
    this.controls.attach(this.pivot);
  }

  dispose(): void {
    this.controls.detach();
    this.controls.getHelper().removeFromParent();
    this.controls.dispose();
    this.pivot.removeFromParent();
  }

  /**
   * Where the pivot sits and how it is oriented. Local space follows the object's rotation when
   * exactly one object is involved.
   */
  private pivotFrame(
    targets: GizmoTargets,
    space: TransformSpace,
  ): { position: THREE.Vector3; rotation: THREE.Quaternion; single: boolean } | null {
    const doc = editor.doc;
    const rotationOf = (t: Transform) => {
      const p = new THREE.Object3D();
      applyTransform(p, t);
      return p.quaternion.clone();
    };

    if (targets.kind === 'objects') {
      const objs = doc.objects.filter((o) => targets.ids.has(o.id) && o.visible && !o.locked);
      if (!objs.length) return null;
      const c = new THREE.Vector3();
      for (const o of objs) c.add(new THREE.Vector3(...o.transform.position));
      c.divideScalar(objs.length);
      const single = objs.length === 1;
      const rotation = single && space === 'local' ? rotationOf(objs[0]!.transform) : new THREE.Quaternion();
      return { position: c, rotation, single };
    }

    const c = new THREE.Vector3();
    let n = 0;
    const objectIds: ObjectId[] = [];
    for (const [id, keys] of targets.selection) {
      const obj = doc.findObject(id);
      if (!obj || !obj.visible) continue;
      const m = transformToMatrix(obj.transform);
      const verts = verticesOf(obj.mesh, targets.mode, keys);
      if (verts.length) objectIds.push(id);
      for (const v of verts) {
        c.add(new THREE.Vector3(...v.pos).applyMatrix4(m));
        n++;
      }
    }
    if (!n) return null;
    c.divideScalar(n);
    const single = objectIds.length === 1;
    const rotation = single && space === 'local' ? rotationOf(doc.object(objectIds[0]!).transform) : new THREE.Quaternion();
    return { position: c, rotation, single };
  }

  private beginDrag(): void {
    this.pivot.updateMatrixWorld(true);
    const pivotInverse = this.pivot.matrixWorld.clone().invert();
    const doc = editor.doc;
    const t = this.targets;

    if (t.kind === 'objects') {
      const ids = doc.objects.filter((o) => t.ids.has(o.id) && o.visible && !o.locked).map((o) => o.id);
      this.drag = {
        kind: 'objects',
        pivotInverse,
        objects: ids.map((id) => {
          const tr = doc.object(id).transform;
          return { id, matrix: transformToMatrix(tr), before: cloneTransform(tr) };
        }),
      };
      return;
    }

    this.drag = {
      kind: 'components',
      mode: t.mode,
      pivotInverse,
      objects: [...t.selection]
        .map(([id, keys]) => {
          const obj = doc.object(id);
          const world = transformToMatrix(obj.transform);
          const verts = verticesOf(obj.mesh, t.mode, keys);
          return {
            id,
            world,
            inverse: world.clone().invert(),
            ids: verts.map((v) => v.id),
            local: verts.map((v) => new THREE.Vector3(...v.pos)),
            before: verts.map((v) => [...v.pos] as Vec3),
          };
        })
        .filter((o) => o.ids.length > 0),
    };
  }

  private updateDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.pivot.updateMatrixWorld(true);
    const delta = this.pivot.matrixWorld.clone().multiply(drag.pivotInverse);
    const doc = editor.doc;

    if (drag.kind === 'objects') {
      for (const o of drag.objects) doc.object(o.id).transform = matrixToTransform(delta.clone().multiply(o.matrix));
    } else {
      for (const o of drag.objects) {
        const m = o.inverse.clone().multiply(delta).multiply(o.world);
        const obj = doc.object(o.id);
        o.ids.forEach((vid, i) => {
          const p = o.local[i]!.clone().applyMatrix4(m);
          obj.mesh.vertex(vid).pos = [round(p.x), round(p.y), round(p.z)];
        });
        obj.meshRev++;
      }
    }
    editor.notifyPreview();
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    const doc = editor.doc;
    const verb = VERBS[this.controls.mode];

    if (drag.kind === 'objects') {
      const changes = drag.objects.map((o) => ({
        id: o.id,
        before: o.before,
        after: cloneTransform(doc.object(o.id).transform),
      }));
      // Put the pre-drag values back, so the command applies the change itself.
      for (const c of changes) doc.object(c.id).transform = cloneTransform(c.before);
      setTransforms(changes, `${verb} ${changes.length === 1 ? 'Object' : 'Objects'}`);
    } else {
      const moves = drag.objects.map((o) => {
        const obj = doc.object(o.id);
        const after = o.ids.map((vid) => [...obj.mesh.vertex(vid).pos] as Vec3);
        o.ids.forEach((vid, i) => (obj.mesh.vertex(vid).pos = [...o.before[i]!]));
        obj.meshRev++;
        return { objectId: o.id, ids: o.ids, before: o.before, after };
      });
      const changed = moves.some((m) => m.after.some((p, i) => p.some((x, k) => x !== m.before[i]![k])));
      // Folds any faces the drag bent out of plane.
      if (changed) commitVertexMoves(moves, `${verb} ${NOUNS[drag.mode]}`);
    }
    editor.notifyPreview();
  }
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6 + 0;
}
