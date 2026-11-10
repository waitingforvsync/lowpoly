import * as THREE from 'three';
import type { ObjectId } from '../core/document';
import type { Vec3 } from '../core/math/vec';
import { edgeOf } from '../editor/components';
import { editor } from '../editor/editor';
import { snapScalar, snapVec3 } from '../editor/snap';
import { COLORS } from './colors';
import { localFaceHit } from './FaceDrag';
import { pickComponent, type PickEnv } from './Picker';
import { transformToMatrix } from './transformMath';

/**
 * Inference snapping (SketchUp style): what the pointer is "on". In priority order: an endpoint
 * (a vertex, or a point of the shape being drawn), the midpoint of an edge, a point on an edge,
 * a point on an axis line through the last point placed, a point on a face, and finally the
 * ground (or a given drawing plane), snapped to the grid. All positions are in world space.
 */

export type InferenceKind = 'endpoint' | 'midpoint' | 'edge' | 'axis' | 'face' | 'plane' | 'ground' | 'locked';

export interface FaceContext {
  objectId: ObjectId;
  faceId: number;
  /** World-space unit normal. */
  normal: Vec3;
  /** Where the pointer ray meets the face. */
  hit: Vec3;
}

export interface Inference {
  point: Vec3;
  kind: InferenceKind;
  /** Tooltip text: 'Endpoint', 'On Edge', 'On Blue Axis'... */
  label: string;
  color: number;
  /** The face under the pointer, if any (whatever the kind). */
  face: FaceContext | null;
  /** The object the point belongs to, if any. */
  objectId: ObjectId | null;
  /** For edge and midpoint inferences: the edge's direction (unit), for locking to it. */
  edgeDir?: Vec3;
  /** For axis and locked inferences: the line's direction, for the guide line. */
  axis?: Vec3;
}

export interface InferOptions {
  /** The last point placed: enables axis inferences and length snapping. */
  from?: Vec3 | null;
  /** Locked direction (unit) through `from`: the point is kept on that line. */
  lock?: Vec3 | null;
  /** Points of the shape being drawn, which can be snapped to like vertices. */
  points?: readonly Vec3[];
  /** Draw on this plane instead of the ground; snaps are projected onto it. */
  plane?: { point: Vec3; normal: Vec3 } | null;
}

export interface InferenceEnv {
  pick: PickEnv;
  ray: THREE.Ray;
  x: number;
  y: number;
  snap: boolean;
  gridStep: number;
}

export const AXES: { dir: Vec3; name: string; color: number }[] = [
  { dir: [1, 0, 0], name: 'Red', color: COLORS.axisX },
  { dir: [0, 1, 0], name: 'Green', color: COLORS.axisY },
  { dir: [0, 0, 1], name: 'Blue', color: COLORS.axisZ },
];

export const INFERENCE_COLORS = {
  endpoint: 0x3fd46b,
  midpoint: 0x3fd1d9,
  edge: 0xff5b5b,
  face: 0x5b8cff,
  ground: COLORS.cursor,
  locked: 0xff63e1,
} as const;

const POINT_RADIUS_PX = 10;
const AXIS_RADIUS_PX = 8;

const v3 = (p: readonly number[]) => new THREE.Vector3(p[0], p[1], p[2]);
const arr = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

function screen(env: InferenceEnv, p: THREE.Vector3): { x: number; y: number; ok: boolean } {
  const v = p.clone().project(env.pick.camera);
  return { x: ((v.x + 1) / 2) * env.pick.width, y: ((1 - v.y) / 2) * env.pick.height, ok: v.z >= -1 && v.z <= 1 };
}

function screenDist(env: InferenceEnv, p: THREE.Vector3): number {
  const s = screen(env, p);
  return s.ok ? Math.hypot(s.x - env.x, s.y - env.y) : Infinity;
}

/** Parameter along the line a + s·d closest to the ray (unclamped; null if parallel). */
export function lineRayParam(a: THREE.Vector3, d: THREE.Vector3, ray: THREE.Ray): number | null {
  const r = a.clone().sub(ray.origin);
  const aa = d.dot(d);
  const b = d.dot(ray.direction);
  const c = ray.direction.dot(ray.direction);
  const e = d.dot(r);
  const f = ray.direction.dot(r);
  const denom = aa * c - b * b;
  if (denom < 1e-12 * aa * c) return null;
  return (b * f - c * e) / denom;
}

/** Project a point onto a plane. */
function ontoPlane(p: THREE.Vector3, plane: { point: Vec3; normal: Vec3 }): THREE.Vector3 {
  const n = v3(plane.normal);
  return p.clone().addScaledVector(n, -p.clone().sub(v3(plane.point)).dot(n));
}

function axisName(dir: Vec3): string | null {
  for (const a of AXES) if (Math.abs(Math.abs(dir[0] * a.dir[0] + dir[1] * a.dir[1] + dir[2] * a.dir[2]) - 1) < 1e-9) return a.name;
  return null;
}

function faceUnderPointer(env: InferenceEnv): { ctx: FaceContext; point: THREE.Vector3 } | null {
  const ref = pickComponent(env.pick, 'face', env.x, env.y);
  if (!ref) return null;
  const obj = editor.doc.findObject(ref.objectId);
  if (!obj) return null;
  const m = transformToMatrix(obj.transform);
  const local = localFaceHit(obj, ref.key as number, env.ray);
  if (!local) return null;
  const n = v3(obj.mesh.face(ref.key as number).normal())
    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(m))
    .normalize();
  const point = local.applyMatrix4(m);
  return { ctx: { objectId: obj.id, faceId: ref.key as number, normal: arr(n), hit: arr(point) }, point };
}

/** World positions of an edge picked under the pointer. */
function edgeUnderPointer(env: InferenceEnv): { a: THREE.Vector3; b: THREE.Vector3; objectId: ObjectId } | null {
  const ref = pickComponent(env.pick, 'edge', env.x, env.y);
  if (!ref) return null;
  const obj = editor.doc.findObject(ref.objectId);
  const e = obj && edgeOf(obj.mesh, ref.key);
  if (!obj || !e) return null;
  const m = transformToMatrix(obj.transform);
  return { a: v3(e.verts[0].pos).applyMatrix4(m), b: v3(e.verts[1].pos).applyMatrix4(m), objectId: obj.id };
}

export function infer(env: InferenceEnv, opts: InferOptions = {}): Inference | null {
  const from = opts.from ? v3(opts.from) : null;
  const faceHit = faceUnderPointer(env);
  const face = faceHit?.ctx ?? null;
  const base = { face, objectId: face?.objectId ?? null };
  const plane = opts.plane ?? null;
  const fix = (p: THREE.Vector3) => (plane ? ontoPlane(p, plane) : p);

  // Point candidates: endpoints first, then midpoints.
  let point: { p: THREE.Vector3; kind: 'endpoint' | 'midpoint'; objectId: ObjectId | null; dir?: Vec3 } | null = null;
  let best = POINT_RADIUS_PX;
  for (const q of opts.points ?? []) {
    const d = screenDist(env, v3(q));
    if (d <= best) {
      best = d;
      point = { p: v3(q), kind: 'endpoint', objectId: null };
    }
  }
  if (!point) {
    const ref = pickComponent(env.pick, 'vertex', env.x, env.y);
    const obj = ref && editor.doc.findObject(ref.objectId);
    const v = obj?.mesh.verts.get(ref!.key as number);
    if (obj && v) point = { p: v3(v.pos).applyMatrix4(transformToMatrix(obj.transform)), kind: 'endpoint', objectId: obj.id };
  }
  const edge = point ? null : edgeUnderPointer(env);
  const edgeDir = edge ? arr(edge.b.clone().sub(edge.a).normalize()) : undefined;
  if (edge) {
    const mid = edge.a.clone().lerp(edge.b, 0.5);
    if (screenDist(env, mid) <= POINT_RADIUS_PX) point = { p: mid, kind: 'midpoint', objectId: edge.objectId, dir: edgeDir };
  }

  // Locked direction: stay on the line; a point candidate is projected onto it.
  if (from && opts.lock) {
    const d = v3(opts.lock);
    let s = point ? point.p.clone().sub(from).dot(d) : lineRayParam(from, d, env.ray);
    if (s === null) return null;
    if (!point && env.snap) s = snapScalar(s, env.gridStep);
    const name = axisName(opts.lock);
    return {
      ...base,
      point: arr(from.clone().addScaledVector(d, s)),
      kind: 'locked',
      label: point ? `Locked ${name ?? 'direction'} · from ${point.kind === 'endpoint' ? 'Endpoint' : 'Midpoint'}` : `Locked to ${name ? `${name} Axis` : 'direction'}`,
      color: name ? AXES.find((a) => a.name === name)!.color : INFERENCE_COLORS.locked,
      axis: opts.lock,
    };
  }

  if (point) {
    return {
      ...base,
      point: arr(fix(point.p)),
      kind: point.kind,
      label: point.kind === 'endpoint' ? 'Endpoint' : 'Midpoint',
      color: INFERENCE_COLORS[point.kind],
      objectId: point.objectId ?? base.objectId,
      edgeDir: point.dir,
    };
  }

  if (edge) {
    const d = edge.b.clone().sub(edge.a);
    const s = Math.min(1, Math.max(0, lineRayParam(edge.a, d, env.ray) ?? 0));
    return {
      ...base,
      point: arr(fix(edge.a.clone().addScaledVector(d, s))),
      kind: 'edge',
      label: 'On Edge',
      color: INFERENCE_COLORS.edge,
      objectId: edge.objectId,
      edgeDir,
    };
  }

  // Axis lines through the last point (not when drawing on a fixed plane).
  if (from && !plane) {
    let axisBest: { p: THREE.Vector3; axis: (typeof AXES)[number] } | null = null;
    let bestD = AXIS_RADIUS_PX;
    for (const axis of AXES) {
      const d = v3(axis.dir);
      // An axis pointing at the viewer collapses to a point on screen: no line to snap to.
      const a = screen(env, from);
      const b = screen(env, from.clone().add(d));
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1) continue;
      let s = lineRayParam(from, d, env.ray);
      if (s === null) continue;
      if (env.snap) s = snapScalar(s, env.gridStep);
      const p = from.clone().addScaledVector(d, s);
      const sd = screenDist(env, p);
      if (sd <= bestD && Math.abs(s) > 1e-9) {
        bestD = sd;
        axisBest = { p, axis };
      }
    }
    if (axisBest) {
      return {
        ...base,
        point: arr(axisBest.p),
        kind: 'axis',
        label: `On ${axisBest.axis.name} Axis`,
        color: axisBest.axis.color,
        axis: axisBest.axis.dir,
      };
    }
  }

  if (faceHit && !plane) {
    let p = faceHit.point;
    // Snap the length from the last point when it lies in the same plane.
    if (from && env.snap) {
      const n = v3(faceHit.ctx.normal);
      const off = p.clone().sub(from);
      if (Math.abs(off.dot(n)) < 1e-6 && off.length() > 1e-9) {
        const len = snapScalar(off.length(), env.gridStep);
        if (len > 0) p = from.clone().addScaledVector(off.normalize(), len);
      }
    }
    return { ...base, point: arr(p), kind: 'face', label: 'On Face', color: INFERENCE_COLORS.face };
  }

  const ground = plane ?? { point: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 };
  const hit = env.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(v3(ground.normal), v3(ground.point)), new THREE.Vector3());
  if (!hit) return null;
  const p: Vec3 = !plane && env.snap ? snapVec3([hit.x, hit.y, 0], env.gridStep) : arr(hit);
  return {
    ...base,
    point: p,
    kind: plane ? 'plane' : 'ground',
    label: plane ? 'On Plane' : 'On Ground',
    color: INFERENCE_COLORS.ground,
  };
}
