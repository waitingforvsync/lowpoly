import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { effect } from '@preact/signals';
import { AxesIndicator } from './AxesIndicator';
import { COLORS } from './colors';
import { createGrid } from './grid';
import { cursorWorld, gridStep, projection, snapEnabled, type Projection } from '../editor/state';
import { isSnapActive, snapVec3 } from '../editor/snap';

export type StandardView = 'top' | 'front' | 'right' | 'iso';

const FOV_DEG = 45;
const TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2);
/** The orthographic camera sits this far from the target, so the scene isn't clipped. */
const ORTHO_CAMERA_DISTANCE = 500;

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
 * cursor. The left button is reserved for tools.
 */
export class Viewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly perspCamera: THREE.PerspectiveCamera;
  private readonly orthoCamera: THREE.OrthographicCamera;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private readonly controls: OrbitControls;
  private readonly axes = new AxesIndicator();
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
  private lastPointer: { x: number; y: number; ctrl: boolean } | null = null;

  constructor(private readonly container: HTMLElement) {
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(COLORS.background);
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    this.perspCamera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.01, 2000);
    this.perspCamera.up.set(0, 0, 1);
    this.perspCamera.position.set(8, -10, 7);
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, ORTHO_CAMERA_DISTANCE * 4);
    this.orthoCamera.up.set(0, 0, 1);
    this.camera = this.perspCamera;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.ROTATE, // Shift+middle pans (built into OrbitControls)
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.1;
    this.controls.maxDistance = 1000;
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.controls.addEventListener('change', this.requestRender);

    this.scene.add(createGrid());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(3, -5, 8);
    this.scene.add(sun);

    this.cursorMarker = makeCursorMarker();
    this.scene.add(this.cursorMarker);

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.disposers.push(() => {
      canvas.removeEventListener('pointermove', this.onPointerMove);
      canvas.removeEventListener('pointerleave', this.onPointerLeave);
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.disposers.push(effect(() => this.applyProjection(projection.value)));
    this.disposers.push(
      effect(() => {
        // Re-snap the cursor when snap settings change.
        void snapEnabled.value;
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

  dispose(): void {
    for (const d of this.disposers) d();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.axes.dispose();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.Points) {
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
    this.controls.update();
    this.requestRender();
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.lastPointer = { x: e.clientX - rect.left, y: e.clientY - rect.top, ctrl: e.ctrlKey };
    this.updateCursor();
  };

  private readonly onPointerLeave = (): void => {
    this.lastPointer = null;
    this.updateCursor();
  };

  /** Project the pointer onto the ground plane, snap it to the grid and publish it. */
  private updateCursor(): void {
    const hit = this.lastPointer ? this.groundHit(this.lastPointer.x, this.lastPointer.y) : null;
    if (!hit || !this.lastPointer) {
      cursorWorld.value = null;
      if (this.cursorMarker.visible) {
        this.cursorMarker.visible = false;
        this.requestRender();
      }
      return;
    }

    const raw: [number, number, number] = [hit.x, hit.y, hit.z];
    const pos = isSnapActive(snapEnabled.peek(), this.lastPointer.ctrl)
      ? snapVec3(raw, gridStep.peek())
      : raw;
    cursorWorld.value = pos;
    this.cursorMarker.position.set(pos[0], pos[1], pos[2]);
    this.cursorMarker.visible = true;
    this.requestRender();
  }

  private groundHit(x: number, y: number): THREE.Vector3 | null {
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
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
