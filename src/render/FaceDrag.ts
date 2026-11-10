import * as THREE from 'three';
import type { SceneObject } from '../core/document';
import { fromMeshData, toMeshData } from '../core/halfedge/convert';
import type { HalfEdgeMesh } from '../core/halfedge/mesh';
import type { FaceId } from '../core/meshdata';
import { insetFaces } from '../core/ops/inset';
import { pushPull } from '../core/ops/pushpull';
import { ReplaceMeshCommand, type MeshState } from '../editor/commands';
import { editor } from '../editor/editor';
import { setComponents } from '../editor/selection';
import { offerReplace, parseOne } from '../editor/measure';
import { insetMode, measurement, selectionMode, showStatus, textureLock } from '../editor/state';
import { snapScalar } from '../editor/snap';
import { transformToMatrix } from './transformMath';

/**
 * Interactive face tools (Push/Pull, Inset). A drag starts on a face; each pointer move re-runs
 * the operation on a fresh copy of the original mesh and shows the result as a live preview.
 * Releasing restores the original and records the final result as one undo step.
 */

export interface DragInput {
  /** The pointer ray in world space. */
  ray: THREE.Ray;
  snap: boolean;
  gridStep: number;
}

export interface FaceDrag {
  move(input: DragInput): void;
  finish(): void;
  cancel(): void;
}

abstract class PreviewDrag implements FaceDrag {
  protected readonly original: HalfEdgeMesh;
  protected readonly before: MeshState;
  protected readonly inverse: THREE.Matrix4;
  private result: { mesh: HalfEdgeMesh; faces: FaceId[] } | null = null;
  private lastValue = 0;

  constructor(
    protected readonly obj: SceneObject,
    protected readonly faces: FaceId[],
    private readonly label: string,
    /** The measurement box's name for the value. */
    private readonly valueName: string,
  ) {
    this.original = obj.mesh;
    this.before = ReplaceMeshCommand.capture(obj);
    this.inverse = transformToMatrix(obj.transform).invert();
  }

  /** The operation's parameter for the current pointer (local units), or null to keep the last. */
  protected abstract value(localRay: THREE.Ray, input: DragInput): number | null;
  protected abstract run(mesh: HalfEdgeMesh, value: number): { mesh: HalfEdgeMesh; faces: FaceId[] };
  protected abstract describe(value: number): string;

  move(input: DragInput): void {
    const raw = this.value(input.ray.clone().applyMatrix4(this.inverse), input);
    if (raw === null) return;
    const v = input.snap ? snapScalar(raw, input.gridStep) : raw;
    if (v === this.lastValue && this.result) return;
    this.lastValue = v;
    measurement.value = this.describe(v);
    try {
      this.result = v === 0 ? null : this.run(fromMeshData(this.before.mesh), v);
      this.obj.setMesh(this.result?.mesh ?? this.original);
    } catch (e) {
      // Keep showing the last good preview; say why this one failed.
      showStatus(`${this.label}: ${(e as Error).message}`, 'error');
    }
    editor.notifyPreview();
  }

  finish(): void {
    const result = this.result;
    this.restore();
    if (result) this.commit(result);
  }

  /** The value typed after a drag: is it acceptable? */
  protected check(v: number): string | null {
    return v === 0 ? 'The value must not be zero' : null;
  }

  private commit(result: { mesh: HalfEdgeMesh; faces: FaceId[] }): void {
    const cmd = new ReplaceMeshCommand(editor.ctx, this.obj.id, this.before, { mesh: toMeshData(result.mesh), source: null }, this.label);
    editor.execute(cmd, () => {
      if (selectionMode.peek() === 'face') setComponents('face', new Map([[this.obj.id, new Set(result.faces)]]));
    });
    // Typing a value next redoes the operation with it.
    offerReplace(
      this.valueName,
      (text) => {
        const v = parseOne(text, `a ${this.valueName.toLowerCase()}`);
        return typeof v === 'number' ? (this.check(v) ?? v) : v;
      },
      (v) => {
        try {
          this.commit(this.run(fromMeshData(this.before.mesh), v));
        } catch (e) {
          showStatus(`${this.label}: ${(e as Error).message}`, 'error');
        }
      },
    );
  }

  cancel(): void {
    this.restore();
  }

  private restore(): void {
    measurement.value = null;
    this.obj.setMesh(this.original);
    editor.notifyPreview();
  }
}

/**
 * Push/Pull: the distance is how far along the face normal the pointer ray passes closest to
 * the line through the pressed point.
 */
export class PushPullDrag extends PreviewDrag {
  private readonly origin: THREE.Vector3;
  private readonly normal: THREE.Vector3;

  constructor(obj: SceneObject, faces: FaceId[], pressed: FaceId, localHit: THREE.Vector3) {
    super(obj, faces, 'Push/Pull', 'Distance');
    this.origin = localHit.clone();
    this.normal = new THREE.Vector3(...obj.mesh.face(pressed).normal());
  }

  protected value(ray: THREE.Ray): number | null {
    // Closest point between the line origin + t·normal and the ray.
    const d = ray.direction;
    const w = this.origin.clone().sub(ray.origin);
    const b = this.normal.dot(d);
    const c = d.dot(d);
    const denom = c - b * b;
    if (denom < 1e-9) return null; // looking straight down the normal
    return (b * d.dot(w) - c * this.normal.dot(w)) / denom;
  }

  protected run(mesh: HalfEdgeMesh, distance: number) {
    return pushPull(mesh, this.faces, distance, { textureLock: textureLock.peek() });
  }

  protected describe(v: number): string {
    return v.toFixed(3);
  }
}

/** Inset: the amount is how far the pointer has moved across the face's plane from the press. */
export class InsetDrag extends PreviewDrag {
  private readonly plane: THREE.Plane;

  constructor(
    obj: SceneObject,
    faces: FaceId[],
    pressed: FaceId,
    private readonly localHit: THREE.Vector3,
  ) {
    super(obj, faces, 'Inset Faces', 'Inset');
    const n = new THREE.Vector3(...obj.mesh.face(pressed).normal());
    this.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, localHit);
  }

  protected value(ray: THREE.Ray): number | null {
    const p = ray.intersectPlane(this.plane, new THREE.Vector3());
    return p ? p.distanceTo(this.localHit) : null;
  }

  protected run(mesh: HalfEdgeMesh, amount: number) {
    return insetFaces(mesh, this.faces, amount, insetMode.peek());
  }

  protected override check(v: number): string | null {
    return v > 0 ? null : 'The inset must be more than zero';
  }

  protected describe(v: number): string {
    return v.toFixed(3);
  }
}

/** The pressed point on a face, in the object's local space, from a world-space ray. */
export function localFaceHit(obj: SceneObject, face: FaceId, worldRay: THREE.Ray): THREE.Vector3 | null {
  const f = obj.mesh.faces.get(face);
  if (!f) return null;
  const local = worldRay.clone().applyMatrix4(transformToMatrix(obj.transform).invert());
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    new THREE.Vector3(...f.normal()),
    new THREE.Vector3(...f.outer.he.origin.pos),
  );
  return local.intersectPlane(plane, new THREE.Vector3());
}
