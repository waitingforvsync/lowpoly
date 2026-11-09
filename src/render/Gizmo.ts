import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { cloneTransform, type ObjectId, type Transform } from '../core/document';
import { setTransforms } from '../editor/actions';
import { editor } from '../editor/editor';
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

const TOOL_MODES: Partial<Record<ToolId, 'translate' | 'rotate' | 'scale'>> = {
  move: 'translate',
  rotate: 'rotate',
  scale: 'scale',
};

const LABELS = { translate: 'Move', rotate: 'Rotate', scale: 'Scale' } as const;

interface DragState {
  pivotInverse: THREE.Matrix4;
  objects: { id: ObjectId; matrix: THREE.Matrix4; before: Transform }[];
}

/**
 * Move/rotate/scale gizmo for selected objects. Three's TransformControls drives a hidden pivot.
 * Each drag frame, the pivot's change since the drag started is applied to every selected
 * object as a live preview. On release, one undoable command records the change.
 */
export class Gizmo {
  readonly controls: TransformControls;
  private readonly pivot = new THREE.Object3D();
  private drag: DragState | null = null;
  private targets: ObjectId[] = [];

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
  update(selected: ReadonlySet<ObjectId>, settings: GizmoSettings): void {
    const mode = TOOL_MODES[settings.tool];
    this.controls.translationSnap = settings.snap ? settings.gridStep : null;
    this.controls.rotationSnap = settings.snap ? THREE.MathUtils.degToRad(settings.rotationStepDeg) : null;
    this.controls.scaleSnap = settings.snap ? 0.1 : null;
    if (this.drag) return;

    const doc = editor.doc;
    this.targets = doc.objects.filter((o) => selected.has(o.id) && o.visible && !o.locked).map((o) => o.id);
    if (!mode || this.targets.length === 0) {
      this.controls.detach();
      return;
    }

    this.controls.setMode(mode);
    // Local space only makes sense for a single object; several objects use world axes.
    this.controls.setSpace(this.targets.length === 1 ? settings.space : 'world');

    if (this.targets.length === 1) {
      const t = doc.object(this.targets[0]!).transform;
      applyTransform(this.pivot, { ...t, scale: [1, 1, 1] });
    } else {
      const c = new THREE.Vector3();
      for (const id of this.targets) c.add(new THREE.Vector3(...doc.object(id).transform.position));
      c.divideScalar(this.targets.length);
      this.pivot.position.copy(c);
      this.pivot.rotation.set(0, 0, 0);
      this.pivot.scale.set(1, 1, 1);
    }
    this.pivot.updateMatrixWorld(true);
    this.controls.attach(this.pivot);
  }

  dispose(): void {
    this.controls.detach();
    this.controls.getHelper().removeFromParent();
    this.controls.dispose();
    this.pivot.removeFromParent();
  }

  private beginDrag(): void {
    this.pivot.updateMatrixWorld(true);
    this.drag = {
      pivotInverse: this.pivot.matrixWorld.clone().invert(),
      objects: this.targets.map((id) => {
        const t = editor.doc.object(id).transform;
        return { id, matrix: transformToMatrix(t), before: cloneTransform(t) };
      }),
    };
  }

  private updateDrag(): void {
    if (!this.drag) return;
    this.pivot.updateMatrixWorld(true);
    const delta = this.pivot.matrixWorld.clone().multiply(this.drag.pivotInverse);
    for (const o of this.drag.objects) {
      editor.doc.object(o.id).transform = matrixToTransform(delta.clone().multiply(o.matrix));
    }
    editor.notifyPreview();
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    const changes = drag.objects.map((o) => ({
      id: o.id,
      before: o.before,
      after: cloneTransform(editor.doc.object(o.id).transform),
    }));
    // Put the pre-drag values back, so the command applies the change itself.
    for (const c of changes) editor.doc.object(c.id).transform = cloneTransform(c.before);
    setTransforms(changes, `${LABELS[this.controls.mode]} ${changes.length === 1 ? 'Object' : 'Objects'}`);
    editor.notifyPreview();
  }
}
