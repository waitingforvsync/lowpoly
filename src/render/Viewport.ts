import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { effect } from '@preact/signals';
import { AxesIndicator } from './AxesIndicator';
import { COLORS } from './colors';
import { Gizmo } from './Gizmo';
import { createGrid } from './grid';
import { SceneSync } from './SceneSync';
import type { ObjectId } from '../core/document';
import type { Vec3 } from '../core/math/vec';
import { editor } from '../editor/editor';
import {
  addToSelection,
  clearSelection,
  selectedObjects,
  selectOnly,
  toggleSelection,
} from '../editor/selection';
import {
  activeTool,
  cursorWorld,
  gridStep,
  projection,
  rotationStep,
  snapEnabled,
  snapInvertHeld,
  transformSpace,
  type Projection,
} from '../editor/state';
import { isSnapActive, snapScalar, snapVec3 } from '../editor/snap';

export type StandardView = 'top' | 'front' | 'right' | 'iso';

const FOV_DEG = 45;
const TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2);
/** The orthographic camera sits this far from the target, so the scene isn't clipped. */
const ORTHO_CAMERA_DISTANCE = 500;
/** A press that moves less than this many pixels counts as a click. */
const CLICK_SLOP_PX = 4;

// Directions from the orbit target to the camera. 'top' is nudged off-axis so the orbit
// controls keep a well-defined up direction (screen-up = +Y).
const VIEW_DIRECTIONS: Record<StandardView, THREE.Vector3> = {
  top: new THREE.Vector3(0, -1e-4, 1).normalize(),
  front: new THREE.Vector3(0, -1, 0),
  right: new THREE.Vector3(1, 0, 0),
  iso: new THREE.Vector3(1, -1, 0.8).normalize(),
};

/**
 * The 3D viewport. The document and editor are Z-up, and Three.js renders Z-up directly by
 * setting every camera's up vector to +Z. No coordinate conversion happens here.
 *
 * Navigation: middle-drag orbits, Shift+middle or right-drag pans, the wheel zooms toward the
 * cursor. The left button belongs to tools: click to select, or drag the gizmo.
 */
export class Viewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly perspCamera: THREE.PerspectiveCamera;
  private readonly orthoCamera: THREE.OrthographicCamera;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private readonly controls: OrbitControls;
  private readonly axes = new AxesIndicator();
  private readonly sync = new SceneSync();
  private readonly gizmo: Gizmo;
  private readonly cursorMarker: THREE.Points;
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
  /** Left-button press in progress that may become a click (null if it grabbed the gizmo). */
  private press: { x: number; y: number } | null = null;

  constructor(private readonly container: HTMLElement) {
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(COLORS.background);
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);
    const canvas = this.renderer.domElement;

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

    // Created before our own pointer listeners, so it sees each press first.
    this.gizmo = new Gizmo(this.camera, canvas, this.scene, (dragging) => {
      this.controls.enabled = !dragging;
    });
    this.gizmo.controls.addEventListener('change', this.requestRender);

    this.cursorMarker = makeCursorMarker();
    this.scene.add(this.cursorMarker);

    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    this.disposers.push(() => {
      canvas.removeEventListener('pointermove', this.onPointerMove);
      canvas.removeEventListener('pointerleave', this.onPointerLeave);
      canvas.removeEventListener('pointerdown', this.onPointerDown);
      canvas.removeEventListener('pointerup', this.onPointerUp);
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.disposers.push(effect(() => this.applyProjection(projection.value)));
    this.disposers.push(
      effect(() => {
        void editor.docVersion.value;
        const selected = selectedObjects.value;
        this.sync.sync(editor.doc, selected);
        this.gizmo.update(selected, {
          tool: activeTool.value,
          space: transformSpace.value,
          snap: isSnapActive(snapEnabled.value, snapInvertHeld.value),
          gridStep: gridStep.value,
          rotationStepDeg: rotationStep.value,
        });
        this.requestRender();
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
    const box = this.sync.bounds(list);
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
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Line || obj instanceof THREE.Points) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
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

  // --- Pointer handling --------------------------------------------------------------------------

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.lastPointer = this.localPoint(e);
    this.updateCursor();
  };

  private readonly onPointerLeave = (): void => {
    this.lastPointer = null;
    this.updateCursor();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    // The gizmo handles the press first; if it grabbed a handle, this isn't a selection click.
    this.press = this.gizmo.dragging ? null : this.localPoint(e);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.press) return;
    const p = this.localPoint(e);
    const moved = Math.hypot(p.x - this.press.x, p.y - this.press.y);
    this.press = null;
    if (moved > CLICK_SLOP_PX) return;

    const id = this.pickObject(p.x, p.y);
    const additive = e.shiftKey;
    const toggle = e.ctrlKey || e.metaKey;
    if (id === null) {
      if (!additive && !toggle) clearSelection();
    } else if (toggle) {
      toggleSelection(id);
    } else if (additive) {
      addToSelection(id);
    } else {
      selectOnly(id);
    }
  };

  private ndc(x: number, y: number): THREE.Vector2 {
    return new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
  }

  private pickObject(x: number, y: number): ObjectId | null {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const hit = this.raycaster.intersectObjects(this.sync.pickables(editor.doc), false)[0];
    return hit ? (hit.object.userData.objectId as ObjectId) : null;
  }

  /** Project the pointer onto the ground plane, snap it to the grid and publish it. */
  private updateCursor(): void {
    const hit = this.lastPointer ? this.groundHit(this.lastPointer.x, this.lastPointer.y) : null;
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
