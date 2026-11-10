import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { effect } from '@preact/signals';
import { AxesIndicator } from './AxesIndicator';
import { COLORS } from './colors';
import { ComponentOverlay } from './ComponentOverlay';
import { Gizmo, type GizmoTargets } from './Gizmo';
import { LineTool, LoopCutTool, RectangleTool, type ToolHost, type ViewTool } from './DrawTools';
import { type FaceDrag, InsetDrag, localFaceHit, PushPullDrag } from './FaceDrag';
import { infer } from './Inference';
import { ToolOverlay } from './ToolOverlay';
import { createGrid } from './grid';
import { boxComponents, boxObjects, pickComponent, type PickEnv, type Rect } from './Picker';
import { SceneSync } from './SceneSync';
import { transformToMatrix } from './transformMath';
import type { ObjectId } from '../core/document';
import type { Vec3 } from '../core/math/vec';
import { measureTyped } from '../editor/measure';
import type { ToolId } from '../editor/tools';
import { editor } from '../editor/editor';
import { paintFaces, sampleMaterial } from '../editor/materialActions';
import { isComponentMode } from '../editor/modes';
import {
  addToSelection,
  applyComponents,
  clearComponents,
  clearSelection,
  componentSelection,
  type ComponentRef,
  editObjects,
  type SelectOp,
  selectedObjects,
  selectOnly,
  setSelection,
  toggleSelection,
} from '../editor/selection';
import {
  activeTool,
  cursorWorld,
  gridStep,
  projection,
  rotationStep,
  selectionMode,
  showTextures,
  snapEnabled,
  snapInvertHeld,
  transformSpace,
  xray,
  type Projection,
} from '../editor/state';
import { isSnapActive, snapScalar, snapVec3 } from '../editor/snap';

export type StandardView = 'top' | 'front' | 'right' | 'iso';

const FOV_DEG = 45;
const TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2);
/** The orthographic camera sits this far from the target, so the scene isn't clipped. */
const ORTHO_CAMERA_DISTANCE = 500;
/** A press that moves less than this many pixels counts as a click; more starts a box select. */
const CLICK_SLOP_PX = 4;

// Directions from the orbit target to the camera. 'top' is nudged off-axis so the orbit
// controls keep a well-defined up direction (screen-up = +Y).
const VIEW_DIRECTIONS: Record<StandardView, THREE.Vector3> = {
  top: new THREE.Vector3(0, -1e-4, 1).normalize(),
  front: new THREE.Vector3(0, -1, 0),
  right: new THREE.Vector3(1, 0, 0),
  iso: new THREE.Vector3(1, -1, 0.8).normalize(),
};

interface Press {
  x: number;
  y: number;
  boxing: boolean;
}

/**
 * The 3D viewport. The document and editor are Z-up, and Three.js renders Z-up directly by
 * setting every camera's up vector to +Z. No coordinate conversion happens here.
 *
 * Navigation: middle-drag orbits, Shift+middle or right-drag pans, the wheel zooms toward the
 * cursor. The left button belongs to tools: click to select, drag for a box selection (left to
 * right: window; right to left: crossing), or drag the gizmo.
 */
export class Viewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly perspCamera: THREE.PerspectiveCamera;
  private readonly orthoCamera: THREE.OrthographicCamera;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private readonly controls: OrbitControls;
  private readonly axes = new AxesIndicator();
  private readonly sync = new SceneSync(() => this.requestRender());
  private readonly overlay = new ComponentOverlay();
  private readonly gizmo: Gizmo;
  private readonly cursorMarker: THREE.Points;
  private readonly boxEl: HTMLDivElement;
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly resizeObserver: ResizeObserver;
  private readonly disposers: (() => void)[] = [];

  private width = 1;
  private height = 1;
  /** Half the visible height of the ortho view at zoom 1. */
  private orthoHalfHeight = 10;
  private renderQueued = false;
  private lastPointer: { x: number; y: number } | null = null;
  /** Left-button press in progress (null if none, or if it grabbed the gizmo). */
  private press: Press | null = null;
  private hover: ComponentRef | null = null;
  /** Push/Pull or Inset drag in progress. */
  private faceDrag: FaceDrag | null = null;
  /** The Line, Rectangle or Loop Cut tool, when active. */
  private viewTool: ViewTool | null = null;
  private readonly toolOverlay: ToolOverlay;
  private readonly toolHost: ToolHost;

  constructor(private readonly container: HTMLElement) {
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(COLORS.background);
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);
    const canvas = this.renderer.domElement;

    this.boxEl = document.createElement('div');
    this.boxEl.className = 'select-box';
    this.boxEl.hidden = true;
    container.appendChild(this.boxEl);

    this.perspCamera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.01, 2000);
    this.perspCamera.up.set(0, 0, 1);
    this.perspCamera.position.set(4, -5, 3.5);
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, ORTHO_CAMERA_DISTANCE * 4);
    this.orthoCamera.up.set(0, 0, 1);
    this.camera = this.perspCamera;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.ROTATE, // Shift+middle pans (built into OrbitControls)
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.1;
    this.controls.maxDistance = 1000;
    this.controls.target.set(0, 0, 0.5);
    this.controls.update();
    this.controls.addEventListener('change', this.requestRender);

    this.scene.add(createGrid());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x50555c, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(3, -5, 8);
    this.scene.add(sun);
    this.scene.add(this.sync.root);
    this.scene.add(this.overlay.root);

    // Created before our own pointer listeners, so it sees each press first.
    this.gizmo = new Gizmo(this.camera, canvas, this.scene, (dragging) => {
      this.controls.enabled = !dragging;
    });
    this.gizmo.controls.addEventListener('change', this.requestRender);

    this.cursorMarker = makeCursorMarker();
    this.scene.add(this.cursorMarker);
    this.toolOverlay = new ToolOverlay(container);
    this.scene.add(this.toolOverlay.root);
    this.toolHost = this.makeToolHost();

    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    // Capture phase, so Esc cancels a drag before the global shortcuts see it.
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    this.disposers.push(() => {
      window.removeEventListener('keydown', this.onKeyDown, true);
      window.removeEventListener('keyup', this.onKeyUp, true);
    });
    this.disposers.push(() => {
      canvas.removeEventListener('pointermove', this.onPointerMove);
      canvas.removeEventListener('pointerleave', this.onPointerLeave);
      canvas.removeEventListener('pointerdown', this.onPointerDown);
      canvas.removeEventListener('pointerup', this.onPointerUp);
      canvas.removeEventListener('pointercancel', this.onPointerCancel);
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.disposers.push(effect(() => this.applyProjection(projection.value)));
    this.disposers.push(effect(() => this.setViewTool(activeTool.value)));
    this.disposers.push(() => this.viewTool?.dispose());
    this.disposers.push(
      effect(() => {
        void editor.docVersion.value;
        const mode = selectionMode.value;
        const comp = isComponentMode(mode);
        const xr = xray.value;
        this.sync.sync(editor.doc, comp ? new Set() : selectedObjects.value, xr, showTextures.value);
        const targets: GizmoTargets = comp
          ? { kind: 'components', mode, selection: componentSelection[mode].value }
          : { kind: 'objects', ids: selectedObjects.value };
        this.gizmo.update(targets, {
          tool: activeTool.value,
          space: transformSpace.value,
          snap: isSnapActive(snapEnabled.value, snapInvertHeld.value),
          gridStep: gridStep.value,
          rotationStepDeg: rotationStep.value,
        });
        void editObjects.value;
        if (!comp) this.hover = null;
        this.refreshOverlay();
      }),
    );
    this.disposers.push(
      effect(() => {
        // Re-snap the cursor when snap settings change.
        void snapEnabled.value;
        void snapInvertHeld.value;
        void gridStep.value;
        this.updateCursor();
      }),
    );
  }

  setStandardView(view: StandardView): void {
    const target = this.controls.target;
    const distance = this.camera.position.distanceTo(target);
    this.camera.position.copy(target).addScaledVector(VIEW_DIRECTIONS[view], distance);
    this.camera.lookAt(target);
    this.controls.update();
    this.requestRender();
  }

  /** Fit the view to the given objects, or to everything when the list is empty. */
  frameObjects(ids: ObjectId[]): void {
    const list = ids.length ? ids : editor.doc.objects.map((o) => o.id);
    this.frameBox(this.sync.bounds(list));
  }

  /** Fit the view to a set of world-space points. */
  framePoints(points: Vec3[]): void {
    this.frameBox(new THREE.Box3().setFromPoints(points.map((p) => new THREE.Vector3(...p))));
  }

  private frameBox(box: THREE.Box3): void {
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.25);
    const target = this.controls.target;
    const dir = this.camera.position.clone().sub(target).normalize();

    target.copy(sphere.center);
    if (this.camera === this.perspCamera) {
      const distance = (radius * 1.2) / Math.sin(THREE.MathUtils.degToRad(FOV_DEG) / 2);
      this.camera.position.copy(target).addScaledVector(dir, distance);
    } else {
      this.camera.position.copy(target).addScaledVector(dir, ORTHO_CAMERA_DISTANCE);
      this.orthoCamera.zoom = this.orthoHalfHeight / (radius * 1.2);
      this.orthoCamera.updateProjectionMatrix();
    }
    this.controls.update();
    this.requestRender();
  }

  /** Canvas pixel position of a world-space point (also used by browser tests). */
  worldToScreen(p: Vec3): { x: number; y: number } {
    const v = new THREE.Vector3(...p).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  /** Where new objects appear: the orbit target dropped onto the ground, snapped to the grid. */
  spawnPoint(): Vec3 {
    const t = this.controls.target;
    const step = gridStep.peek();
    return snapEnabled.peek() ? [snapScalar(t.x, step), snapScalar(t.y, step), 0] : [t.x, t.y, 0];
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.resizeObserver.disconnect();
    this.gizmo.dispose();
    this.controls.dispose();
    this.axes.dispose();
    this.sync.dispose();
    this.overlay.dispose();
    this.toolOverlay.dispose();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Line || obj instanceof THREE.Points) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.boxEl.remove();
  }

  private readonly requestRender = (): void => {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(this.render);
  };

  private readonly render = (): void => {
    this.renderQueued = false;
    const r = this.renderer;
    r.setViewport(0, 0, this.width, this.height);
    r.clear();
    r.render(this.scene, this.camera);
    this.axes.render(r, this.camera);
  };

  private resize(): void {
    this.width = Math.max(1, this.container.clientWidth);
    this.height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(this.width, this.height);
    this.perspCamera.aspect = this.width / this.height;
    this.perspCamera.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.overlay.setResolution(this.width, this.height);
    this.toolOverlay?.setResolution(this.width, this.height);
    this.render(); // render synchronously so the canvas never shows a cleared frame
  }

  private updateOrthoFrustum(): void {
    const aspect = this.width / this.height;
    const h = this.orthoHalfHeight;
    this.orthoCamera.left = -h * aspect;
    this.orthoCamera.right = h * aspect;
    this.orthoCamera.top = h;
    this.orthoCamera.bottom = -h;
    this.orthoCamera.updateProjectionMatrix();
  }

  /** Switch camera type while keeping the view direction and the apparent size at the target. */
  private applyProjection(p: Projection): void {
    const target = this.controls.target;
    const dir = this.camera.position.clone().sub(target).normalize();

    if (p === 'orthographic' && this.camera === this.perspCamera) {
      const distance = this.perspCamera.position.distanceTo(target);
      this.orthoHalfHeight = distance * TAN_HALF_FOV;
      this.orthoCamera.zoom = 1;
      this.updateOrthoFrustum();
      this.orthoCamera.position.copy(target).addScaledVector(dir, ORTHO_CAMERA_DISTANCE);
      this.orthoCamera.quaternion.copy(this.perspCamera.quaternion);
      this.camera = this.orthoCamera;
    } else if (p === 'perspective' && this.camera === this.orthoCamera) {
      const visibleHalfHeight = this.orthoHalfHeight / this.orthoCamera.zoom;
      const distance = visibleHalfHeight / TAN_HALF_FOV;
      this.perspCamera.position.copy(target).addScaledVector(dir, distance);
      this.perspCamera.quaternion.copy(this.orthoCamera.quaternion);
      this.camera = this.perspCamera;
    } else {
      return;
    }

    this.controls.object = this.camera;
    this.gizmo.setCamera(this.camera);
    this.controls.update();
    this.requestRender();
  }

  private refreshOverlay(): void {
    const mode = selectionMode.peek();
    this.overlay.update(
      editor.doc,
      isComponentMode(mode)
        ? {
            mode,
            editIds: editObjects.peek(),
            selection: componentSelection[mode].peek(),
            hover: this.hover,
            xray: xray.peek(),
          }
        : null,
    );
    this.requestRender();
  }

  // --- Picking -----------------------------------------------------------------------------------

  // --- Drawing tools -------------------------------------------------------------------------------

  private makeToolHost(): ToolHost {
    const snap = () => isSnapActive(snapEnabled.peek(), snapInvertHeld.peek());
    return {
      infer: (x, y, opts) =>
        infer({ pick: this.allPickEnv(), ray: this.worldRay(x, y), x, y, snap: snap(), gridStep: gridStep.peek() }, opts),
      worldRay: (x, y) => this.worldRay(x, y),
      pickEdge: (x, y) => pickComponent(this.allPickEnv(true), 'edge', x, y),
      towardCamera: () => {
        const d = this.camera.getWorldDirection(new THREE.Vector3()).negate();
        return [d.x, d.y, d.z];
      },
      snap,
      gridStep: () => gridStep.peek(),
      overlay: this.toolOverlay,
      requestRender: () => this.requestRender(),
    };
  }

  private setViewTool(tool: ToolId): void {
    this.viewTool?.dispose();
    this.viewTool =
      tool === 'line'
        ? new LineTool(this.toolHost)
        : tool === 'rectangle'
          ? new RectangleTool(this.toolHost)
          : tool === 'loopcut'
            ? new LoopCutTool(this.toolHost)
            : null;
    this.hover = null;
    this.refreshOverlay();
    this.updateCursor();
  }

  /** Every visible object, for inference and the drawing tools (`unlocked`: only editable ones). */
  private allPickEnv(unlocked = false): PickEnv {
    const env = this.pickEnv();
    const targets = editor.doc.objects
      .filter((o) => o.visible && (!unlocked || !o.locked))
      .map((obj) => ({ obj, matrix: transformToMatrix(obj.transform), mesh: this.sync.meshOf(obj.id)! }))
      .filter((t) => t.mesh);
    return { ...env, targets };
  }

  private pickEnv(): PickEnv {
    const doc = editor.doc;
    const mode = selectionMode.peek();
    const ids = isComponentMode(mode)
      ? [...editObjects.peek()]
      : doc.objects.filter((o) => o.visible && !o.locked).map((o) => o.id);
    this.sync.root.updateMatrixWorld(true);
    const targets = ids
      .map((id) => doc.findObject(id))
      .filter((o) => o && o.visible)
      .map((obj) => ({ obj: obj!, matrix: transformToMatrix(obj!.transform), mesh: this.sync.meshOf(obj!.id)! }))
      .filter((t) => t.mesh);
    const occluders = doc.objects
      .filter((o) => o.visible)
      .map((o) => this.sync.meshOf(o.id))
      .filter((m): m is THREE.Mesh => !!m);
    return { camera: this.camera, width: this.width, height: this.height, targets, occluders, xray: xray.peek() };
  }

  private pickObject(x: number, y: number): ObjectId | null {
    this.sync.root.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const hit = this.raycaster.intersectObjects(this.sync.pickables(editor.doc), false)[0];
    return hit ? (hit.object.userData.objectId as ObjectId) : null;
  }

  private updateHover(): void {
    const mode = selectionMode.peek();
    let next: ComponentRef | null = null;
    if (isComponentMode(mode) && this.lastPointer && !this.press && !this.faceDrag && !this.gizmo.dragging) {
      next = pickComponent(this.pickEnv(), mode, this.lastPointer.x, this.lastPointer.y);
    }
    if (next?.objectId !== this.hover?.objectId || next?.key !== this.hover?.key) {
      this.hover = next;
      this.refreshOverlay();
    }
  }

  // --- Pointer handling --------------------------------------------------------------------------

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.lastPointer = this.localPoint(e);
    this.updateCursor();

    if (this.viewTool) {
      this.viewTool.move(this.lastPointer.x, this.lastPointer.y);
      return;
    }

    if (this.faceDrag) {
      this.faceDrag.move({
        ray: this.worldRay(this.lastPointer.x, this.lastPointer.y),
        snap: isSnapActive(snapEnabled.peek(), snapInvertHeld.peek()),
        gridStep: gridStep.peek(),
      });
      return;
    }

    const press = this.press;
    if (press) {
      const p = this.lastPointer;
      if (!press.boxing && Math.hypot(p.x - press.x, p.y - press.y) > CLICK_SLOP_PX) press.boxing = true;
      if (press.boxing) this.drawBox(press, p);
      return;
    }
    this.updateHover();
  };

  private readonly onPointerLeave = (): void => {
    this.lastPointer = null;
    this.toolOverlay.setTip(null);
    this.updateCursor();
    if (!this.press) this.updateHover();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    // The gizmo handles the press first; if it grabbed a handle, this isn't a selection.
    if (this.gizmo.dragging) {
      this.press = null;
      return;
    }
    const p = this.localPoint(e);
    if (this.viewTool) {
      this.viewTool.down(p.x, p.y);
      return;
    }
    this.renderer.domElement.setPointerCapture(e.pointerId);
    if (this.paint(p.x, p.y, e)) return;
    if (this.startFaceDrag(p.x, p.y)) return;
    this.press = { x: p.x, y: p.y, boxing: false };
  };

  private readonly onPointerCancel = (): void => {
    this.press = null;
    this.boxEl.hidden = true;
    this.faceDrag?.cancel();
    this.faceDrag = null;
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isTextEntry(e.target)) return;
    // Esc while typing a value abandons the value, not the tool.
    if (e.key === 'Escape' && measureTyped.peek() !== null) return;
    let used = false;
    if (e.key === 'Escape' && this.faceDrag) {
      this.faceDrag.cancel();
      this.faceDrag = null;
      used = true;
    } else if (this.viewTool && !e.ctrlKey && !e.metaKey && !e.altKey) {
      used = this.viewTool.key(e);
    }
    if (used) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.viewTool?.keyUp(e);
  };

  /**
   * With the Push/Pull or Inset tool, a press on a face starts a drag. If the face is part of
   * the face selection, the whole selection (on that object) is used.
   */
  private startFaceDrag(x: number, y: number): boolean {
    const tool = activeTool.peek();
    if (tool !== 'pushpull' && tool !== 'inset') return false;
    const ref = pickComponent(this.pickEnv(), 'face', x, y);
    if (!ref) return false;
    const obj = editor.doc.findObject(ref.objectId);
    const pressed = ref.key as number;
    const hit = obj && localFaceHit(obj, pressed, this.worldRay(x, y));
    if (!obj || !hit) return false;
    const selected = selectionMode.peek() === 'face' ? componentSelection.face.peek().get(obj.id) : undefined;
    const faces = selected?.has(pressed) ? [...selected].map(Number) : [pressed];
    this.faceDrag = tool === 'pushpull' ? new PushPullDrag(obj, faces, pressed, hit) : new InsetDrag(obj, faces, pressed, hit);
    this.hover = null;
    this.refreshOverlay();
    return true;
  }

  /**
   * Paint tool: click a face to apply the active material; with the face selected, the whole face
   * selection. Ctrl: connected faces of the same material. Shift: every face of the object with
   * that material. Alt: sample the face's material instead. A click off the model does nothing.
   */
  private paint(x: number, y: number, e: PointerEvent): boolean {
    if (activeTool.peek() !== 'paint') return false;
    const ref = pickComponent(this.pickEnv(), 'face', x, y);
    if (!ref) return true;
    const face = ref.key as number;
    if (e.altKey) {
      sampleMaterial(ref.objectId, face);
      return true;
    }
    const selected = selectionMode.peek() === 'face' ? componentSelection.face.peek().get(ref.objectId) : undefined;
    if (!e.ctrlKey && !e.shiftKey && selected?.has(face)) paintFaces(ref.objectId, [...selected].map(Number), 'face');
    else paintFaces(ref.objectId, [face], e.ctrlKey || e.metaKey ? 'connected' : e.shiftKey ? 'same' : 'face');
    return true;
  }

  private worldRay(x: number, y: number): THREE.Ray {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    return this.raycaster.ray.clone();
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.button === 0 && this.faceDrag) {
      const drag = this.faceDrag;
      this.faceDrag = null;
      drag.finish();
      this.updateHover();
      return;
    }
    const press = this.press;
    if (e.button !== 0 || !press) return;
    this.press = null;
    this.boxEl.hidden = true;
    const p = this.localPoint(e);
    const op: SelectOp = e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace';

    if (press.boxing) {
      const rect: Rect = {
        x0: Math.min(press.x, p.x),
        y0: Math.min(press.y, p.y),
        x1: Math.max(press.x, p.x),
        y1: Math.max(press.y, p.y),
      };
      // Dragging right-to-left selects anything touched (crossing), as in SketchUp.
      this.boxSelect(rect, p.x < press.x, op === 'toggle' ? 'remove' : op);
    } else {
      this.clickSelect(p.x, p.y, op);
    }
    this.updateHover();
  };

  private clickSelect(x: number, y: number, op: SelectOp): void {
    const mode = selectionMode.peek();
    if (isComponentMode(mode)) {
      const ref = pickComponent(this.pickEnv(), mode, x, y);
      if (ref) applyComponents(mode, [ref], op);
      else if (op === 'replace') clearComponents(mode);
      return;
    }
    const id = this.pickObject(x, y);
    if (id === null) {
      if (op === 'replace') clearSelection();
    } else if (op === 'toggle') toggleSelection(id);
    else if (op === 'add') addToSelection(id);
    else selectOnly(id);
  }

  private boxSelect(rect: Rect, crossing: boolean, op: 'replace' | 'add' | 'remove'): void {
    const mode = selectionMode.peek();
    const env = this.pickEnv();
    if (isComponentMode(mode)) {
      applyComponents(mode, boxComponents(env, mode, rect, crossing), op);
      return;
    }
    const ids = boxObjects(env, rect, crossing);
    const current = selectedObjects.peek();
    if (op === 'replace') setSelection(ids);
    else if (op === 'add') setSelection([...current, ...ids]);
    else setSelection([...current].filter((id) => !ids.includes(id)));
  }

  private drawBox(press: Press, p: { x: number; y: number }): void {
    const el = this.boxEl;
    el.hidden = false;
    el.classList.toggle('crossing', p.x < press.x);
    el.style.left = `${Math.min(press.x, p.x)}px`;
    el.style.top = `${Math.min(press.y, p.y)}px`;
    el.style.width = `${Math.abs(p.x - press.x)}px`;
    el.style.height = `${Math.abs(p.y - press.y)}px`;
  }

  private ndc(x: number, y: number): THREE.Vector2 {
    return new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
  }

  /** Project the pointer onto the ground plane, snap it to the grid and publish it. */
  private updateCursor(): void {
    // The drawing tools show their own inference marker.
    const hit = this.lastPointer && !this.viewTool ? this.groundHit(this.lastPointer.x, this.lastPointer.y) : null;
    if (!hit) {
      cursorWorld.value = null;
      if (this.cursorMarker.visible) {
        this.cursorMarker.visible = false;
        this.requestRender();
      }
      return;
    }

    const raw: [number, number, number] = [hit.x, hit.y, hit.z];
    const pos = isSnapActive(snapEnabled.peek(), snapInvertHeld.peek()) ? snapVec3(raw, gridStep.peek()) : raw;
    cursorWorld.value = pos;
    this.cursorMarker.position.set(pos[0], pos[1], pos[2]);
    this.cursorMarker.visible = true;
    this.requestRender();
  }

  private groundHit(x: number, y: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    return this.raycaster.ray.intersectPlane(this.groundPlane, new THREE.Vector3());
  }
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function makeCursorMarker(): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const material = new THREE.PointsMaterial({
    color: COLORS.cursor,
    size: 7,
    sizeAttenuation: false,
    depthTest: false,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 10;
  points.visible = false;
  return points;
}
