import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { cloneTransform, type ObjectId, type Transform } from '../core/document';
import type { Vec3 } from '../core/math/vec';
import type { VertId } from '../core/meshdata';
import { setTransforms } from '../editor/actions';
import { commitVertexMoves, type EditOutcome } from '../editor/componentActions';
import { ReplaceMeshCommand, type MeshState } from '../editor/commands';
import { extrudeMesh } from '../editor/modelActions';
import { offerReplace, parseNumbers } from '../editor/measure';
import { measurement, showStatus } from '../editor/state';
import { fromMeshData, toMeshData } from '../core/halfedge/convert';
import type { HalfEdgeMesh } from '../core/halfedge/mesh';
import { type Command, CompositeCommand } from '../history/history';
import { verticesOf } from '../editor/components';
import { editor } from '../editor/editor';
import { type ComponentMode, type ComponentSet, type ElementKey, setComponents } from '../editor/selection';
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
  extrude: 'translate',
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

/** Extrude tool: the selection is extruded and the copies follow the gizmo. */
interface ExtrudeDrag {
  kind: 'extrude';
  mode: ComponentMode;
  /** The selection before the drag; the preview selects the copies instead. */
  selection: ComponentSet;
  objects: {
    id: ObjectId;
    world: THREE.Matrix4;
    inverse: THREE.Matrix4;
    keys: ReadonlySet<ElementKey>;
    original: HalfEdgeMesh;
    before: MeshState;
    result: Required<EditOutcome> | null;
  }[];
}

type GizmoMode = 'translate' | 'rotate' | 'scale';

type DragState = (ObjectDrag | VertexDrag | ExtrudeDrag) & {
  pivotInverse: THREE.Matrix4;
  /** The gizmo mode the drag was made in. */
  gizmoMode: GizmoMode;
  /** The change applied so far (world space). */
  delta?: THREE.Matrix4;
};

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
  private tool: ToolId = 'select';

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
    this.tool = settings.tool;

    const mode = TOOL_MODES[settings.tool];
    // Extrude works on components only.
    const usable = mode && !(settings.tool === 'extrude' && targets.kind === 'objects');
    const frame = usable ? this.pivotFrame(targets, settings.space) : null;
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
    const gizmoMode = this.controls.mode as GizmoMode;
    const doc = editor.doc;
    const t = this.targets;

    if (t.kind === 'objects') {
      const ids = doc.objects.filter((o) => t.ids.has(o.id) && o.visible && !o.locked).map((o) => o.id);
      this.drag = {
        kind: 'objects',
        pivotInverse,
        gizmoMode,
        objects: ids.map((id) => {
          const tr = doc.object(id).transform;
          return { id, matrix: transformToMatrix(tr), before: cloneTransform(tr) };
        }),
      };
      return;
    }

    if (this.tool === 'extrude') {
      this.drag = {
        kind: 'extrude',
        mode: t.mode,
        selection: t.selection,
        pivotInverse,
        gizmoMode,
        objects: [...t.selection]
          .filter(([id, keys]) => keys.size > 0 && doc.findObject(id))
          .map(([id, keys]) => {
            const obj = doc.object(id);
            const world = transformToMatrix(obj.transform);
            return {
              id,
              world,
              inverse: world.clone().invert(),
              keys,
              original: obj.mesh,
              before: ReplaceMeshCommand.capture(obj),
              result: null,
            };
          }),
      };
      measurement.value = '0.000';
      return;
    }

    this.drag = {
      kind: 'components',
      mode: t.mode,
      pivotInverse,
      gizmoMode,
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
    this.applyDelta(drag, this.pivot.matrixWorld.clone().multiply(drag.pivotInverse));
  }

  /** Preview the drag's targets changed by `delta` (a world-space transform). */
  private applyDelta(drag: DragState, delta: THREE.Matrix4): void {
    drag.delta = delta;
    const doc = editor.doc;
    if (drag.kind !== 'extrude') measurement.value = describeDelta(drag.gizmoMode, delta, drag.pivotInverse);

    if (drag.kind === 'objects') {
      for (const o of drag.objects) doc.object(o.id).transform = matrixToTransform(delta.clone().multiply(o.matrix));
    } else if (drag.kind === 'extrude') {
      measurement.value = new THREE.Vector3().setFromMatrixPosition(delta).length().toFixed(3);
      for (const o of drag.objects) {
        // A translation in world space is a translation in local space too.
        const offset = new THREE.Vector3().setFromMatrixPosition(o.inverse.clone().multiply(delta).multiply(o.world));
        const obj = doc.object(o.id);
        if (offset.length() < 1e-9) {
          o.result = null;
          obj.setMesh(o.original);
          continue;
        }
        try {
          o.result = extrudeMesh(fromMeshData(o.before.mesh), drag.mode, o.keys, [round(offset.x), round(offset.y), round(offset.z)]);
          obj.setMesh(o.result.mesh);
        } catch (e) {
          showStatus(`Extrude: ${(e as Error).message}`, 'error');
        }
      }
      // Highlight the moving copies rather than the originals left behind.
      const preview = new Map<ObjectId, ReadonlySet<ElementKey>>();
      for (const o of drag.objects) preview.set(o.id, o.result ? new Set(o.result.select) : o.keys);
      setComponents(drag.mode, preview);
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
    const verb = VERBS[drag.gizmoMode];
    const lastBefore = editor.history.lastCommand;
    measurement.value = null;

    if (drag.kind === 'objects') {
      const changes = drag.objects.map((o) => ({
        id: o.id,
        before: o.before,
        after: cloneTransform(doc.object(o.id).transform),
      }));
      // Put the pre-drag values back, so the command applies the change itself.
      for (const c of changes) doc.object(c.id).transform = cloneTransform(c.before);
      setTransforms(changes, `${verb} ${changes.length === 1 ? 'Object' : 'Objects'}`);
    } else if (drag.kind === 'extrude') {
      measurement.value = null;
      // Back to the pre-drag selection, so undo returns to it.
      setComponents(drag.mode, drag.selection);
      const cmds: Command[] = [];
      const selection = new Map<ObjectId, Set<ElementKey>>();
      for (const o of drag.objects) {
        doc.object(o.id).setMesh(o.original);
        if (!o.result) continue;
        const label = `Extrude ${NOUNS[drag.mode]}`;
        cmds.push(new ReplaceMeshCommand(editor.ctx, o.id, o.before, { mesh: toMeshData(o.result.mesh), source: null }, label));
        selection.set(o.id, new Set(o.result.select));
      }
      const mode = drag.mode;
      if (cmds.length) {
        editor.execute(cmds.length === 1 ? cmds[0]! : new CompositeCommand(`Extrude ${NOUNS[mode]}`, cmds), () =>
          setComponents(mode, selection),
        );
      }
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
    if (drag.delta && editor.history.lastCommand !== lastBefore) this.offerTyped(drag, drag.delta);
  }

  /**
   * After a drag, a typed value redoes it exactly: a distance along the direction moved (or an
   * x,y,z offset), an angle about the same axis, or a scale factor on the axes that were scaled
   * (or x,y,z factors).
   */
  private offerTyped(drag: DragState, last: THREE.Matrix4): void {
    const mode = drag.gizmoMode;
    const label = mode === 'translate' ? 'Distance' : mode === 'rotate' ? 'Angle' : 'Scale';
    offerReplace(
      label,
      (text) => typedDelta(mode, last, drag.pivotInverse, text),
      (delta) => {
        this.drag = drag;
        this.applyDelta(drag, delta);
        this.endDrag();
      },
    );
  }
}

/** What the measurement box shows during a drag. */
function describeDelta(mode: GizmoMode, delta: THREE.Matrix4, pivotInverse: THREE.Matrix4): string {
  if (mode === 'translate') return new THREE.Vector3().setFromMatrixPosition(delta).length().toFixed(3);
  if (mode === 'rotate') {
    const q = new THREE.Quaternion().setFromRotationMatrix(delta);
    return `${THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(q.w)))).toFixed(1)}°`;
  }
  const s = pivotScale(delta, pivotInverse);
  return [s.x, s.y, s.z].map((x) => x.toFixed(3)).join(', ');
}

/** The scale factors of a scale drag, in the pivot's frame. */
function pivotScale(delta: THREE.Matrix4, pivotInverse: THREE.Matrix4): THREE.Vector3 {
  const start = pivotInverse.clone().invert();
  const local = pivotInverse.clone().multiply(delta).multiply(start);
  return new THREE.Vector3(local.elements[0], local.elements[5], local.elements[10]);
}

/** The world-space change for a typed value, based on the last drag. Or an error message. */
function typedDelta(mode: GizmoMode, last: THREE.Matrix4, pivotInverse: THREE.Matrix4, text: string): THREE.Matrix4 | string {
  const nums = parseNumbers(text);
  if (!nums || (nums.length !== 1 && nums.length !== 3)) {
    return mode === 'rotate' ? 'Type an angle in degrees' : mode === 'translate' ? 'Type a distance, or an x,y,z offset' : 'Type a scale factor, or x,y,z factors';
  }
  const start = pivotInverse.clone().invert();
  const centre = new THREE.Vector3().setFromMatrixPosition(start);
  if (mode === 'translate') {
    if (nums.length === 3) return new THREE.Matrix4().makeTranslation(nums[0]!, nums[1]!, nums[2]!);
    const dir = new THREE.Vector3().setFromMatrixPosition(last);
    if (dir.lengthSq() < 1e-18) return 'Drag first to show the direction';
    dir.normalize().multiplyScalar(nums[0]!);
    return new THREE.Matrix4().makeTranslation(dir.x, dir.y, dir.z);
  }
  if (mode === 'rotate') {
    if (nums.length !== 1) return 'Type an angle in degrees';
    const q = new THREE.Quaternion().setFromRotationMatrix(last);
    const sin = Math.hypot(q.x, q.y, q.z);
    if (sin < 1e-9) return 'Drag first to show the axis';
    const axis = new THREE.Vector3(q.x, q.y, q.z).divideScalar(sin);
    const r = new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(nums[0]!));
    return new THREE.Matrix4()
      .makeTranslation(centre.x, centre.y, centre.z)
      .multiply(r)
      .multiply(new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z));
  }
  let s: THREE.Vector3;
  if (nums.length === 3) s = new THREE.Vector3(nums[0]!, nums[1]!, nums[2]!);
  else {
    const prev = pivotScale(last, pivotInverse);
    const k = nums[0]!;
    const scaled = [prev.x, prev.y, prev.z].map((x) => Math.abs(x - 1) > 1e-9);
    const any = scaled.some(Boolean);
    s = new THREE.Vector3(...scaled.map((on) => (on || !any ? k : 1)));
  }
  if (Math.abs(s.x * s.y * s.z) < 1e-12) return 'Scale factors must not be zero';
  return start.clone().multiply(new THREE.Matrix4().makeScale(s.x, s.y, s.z)).multiply(pivotInverse);
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6 + 0;
}
