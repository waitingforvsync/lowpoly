import * as THREE from 'three';
import type { ObjectId, SceneObject } from '../core/document';
import type { Vertex } from '../core/halfedge/mesh';
import { pointInPolygon2D } from '../core/math/vec';
import { keyOfEdge } from '../editor/components';
import type { ComponentMode, ComponentRef } from '../editor/selection';

/**
 * Screen-space picking. Vertices and edges are picked by distance to their projection, faces by
 * raycasting. Unless X-ray is on, elements hidden behind geometry are skipped.
 */

export interface PickTarget {
  obj: SceneObject;
  /** Object world matrix. */
  matrix: THREE.Matrix4;
  /** The rendered mesh, for raycasting. */
  mesh: THREE.Mesh;
}

export interface PickEnv {
  camera: THREE.Camera;
  width: number;
  height: number;
  /** Objects whose elements can be picked. */
  targets: PickTarget[];
  /** Everything that can hide something (visible meshes). */
  occluders: THREE.Mesh[];
  xray: boolean;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const VERTEX_RADIUS_PX = 10;
const EDGE_RADIUS_PX = 8;

const raycaster = new THREE.Raycaster();

interface Projected {
  world: THREE.Vector3;
  x: number;
  y: number;
  /** In front of the camera and within its depth range. */
  ok: boolean;
}

function project(env: PickEnv, world: THREE.Vector3): Projected {
  const v = world.clone().project(env.camera);
  return {
    world,
    x: ((v.x + 1) / 2) * env.width,
    y: ((1 - v.y) / 2) * env.height,
    ok: v.z >= -1 && v.z <= 1,
  };
}

function ndc(env: PickEnv, x: number, y: number): THREE.Vector2 {
  return new THREE.Vector2((x / env.width) * 2 - 1, -(y / env.height) * 2 + 1);
}

/** World-space size of one screen pixel at the given distance from the camera. */
function pixelSize(env: PickEnv, distance: number): number {
  const cam = env.camera;
  if (cam instanceof THREE.PerspectiveCamera) {
    return (2 * distance * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / env.height;
  }
  if (cam instanceof THREE.OrthographicCamera) return (cam.top - cam.bottom) / cam.zoom / env.height;
  return 1e-3;
}

const JITTER: [number, number][] = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * True if nothing lies in front of this world point. Besides the ray through the point itself,
 * rays one pixel to each side are tested: a vertex sitting exactly behind a silhouette (where
 * the centre ray only grazes edges) is then correctly seen as hidden. Depths are compared with a
 * tolerance of a few pixels' worth of world distance, so surfaces through the point don't hide it.
 */
function visible(env: PickEnv, p: Projected): boolean {
  if (env.xray) return true;
  for (const [dx, dy] of JITTER) {
    raycaster.setFromCamera(ndc(env, p.x + dx, p.y + dy), env.camera);
    const ray = raycaster.ray;
    const depth = p.world.clone().sub(ray.origin).dot(ray.direction);
    const hit = raycaster.intersectObjects(env.occluders, false)[0];
    if (hit && hit.distance < depth - 4 * pixelSize(env, depth)) return false;
  }
  return true;
}

/** World positions and screen projections of every vertex of a target. */
function projectVerts(env: PickEnv, t: PickTarget): Map<Vertex, Projected> {
  const out = new Map<Vertex, Projected>();
  for (const v of t.obj.mesh.verts.values()) {
    out.set(v, project(env, new THREE.Vector3(...v.pos).applyMatrix4(t.matrix)));
  }
  return out;
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

/** Liang–Barsky: does the segment a-b touch the rectangle? */
function segmentHitsRect(r: Rect, ax: number, ay: number, bx: number, by: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, ax - r.x0) && clip(dx, r.x1 - ax) && clip(-dy, ay - r.y0) && clip(dy, r.y1 - ay);
}

function distToSegment(px: number, py: number, a: Projected, b: Projected): { d: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
  return { d: Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)), t };
}

// --- Click picking ------------------------------------------------------------------------------

export function pickComponent(env: PickEnv, mode: ComponentMode, x: number, y: number): ComponentRef | null {
  if (mode === 'face') return pickFace(env, x, y);

  const candidates: { ref: ComponentRef; d: number; at: () => Projected }[] = [];
  for (const t of env.targets) {
    const proj = projectVerts(env, t);
    if (mode === 'vertex') {
      for (const [v, p] of proj) {
        if (!p.ok) continue;
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= VERTEX_RADIUS_PX) candidates.push({ ref: { objectId: t.obj.id, key: v.id }, d, at: () => p });
      }
    } else {
      for (const e of t.obj.mesh.edges()) {
        const a = proj.get(e.verts[0])!;
        const b = proj.get(e.verts[1])!;
        if (!a.ok || !b.ok) continue;
        const { d, t: s } = distToSegment(x, y, a, b);
        if (d > EDGE_RADIUS_PX) continue;
        candidates.push({
          ref: { objectId: t.obj.id, key: keyOfEdge(e) },
          d,
          at: () => project(env, a.world.clone().lerp(b.world, s)),
        });
      }
    }
  }
  candidates.sort((p, q) => p.d - q.d);
  for (const c of candidates) if (visible(env, c.at())) return c.ref;
  return null;
}

function pickFace(env: PickEnv, x: number, y: number): ComponentRef | null {
  raycaster.setFromCamera(ndc(env, x, y), env.camera);
  const meshes = env.xray ? env.targets.map((t) => t.mesh) : env.occluders;
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (!hit || hit.faceIndex == null) return null;
  const target = env.targets.find((t) => t.mesh === hit.object);
  if (!target) return null; // hidden behind an object that isn't being edited
  const triFaces = target.mesh.userData.triFaces as Int32Array | undefined;
  const faceId = triFaces?.[hit.faceIndex];
  return faceId === undefined ? null : { objectId: target.obj.id, key: faceId };
}

// --- Box selection ------------------------------------------------------------------------------

/**
 * Window (crossing = false): elements entirely inside the rectangle.
 * Crossing: elements the rectangle touches.
 */
export function boxComponents(env: PickEnv, mode: ComponentMode, r: Rect, crossing: boolean): ComponentRef[] {
  const out: ComponentRef[] = [];
  const center: [number, number] = [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];

  for (const t of env.targets) {
    const proj = projectVerts(env, t);
    const id = t.obj.id;

    if (mode === 'vertex') {
      for (const [v, p] of proj) if (p.ok && inRect(r, p.x, p.y) && visible(env, p)) out.push({ objectId: id, key: v.id });
    } else if (mode === 'edge') {
      for (const e of t.obj.mesh.edges()) {
        const a = proj.get(e.verts[0])!;
        const b = proj.get(e.verts[1])!;
        if (!a.ok || !b.ok) continue;
        const hit = crossing
          ? segmentHitsRect(r, a.x, a.y, b.x, b.y)
          : inRect(r, a.x, a.y) && inRect(r, b.x, b.y);
        if (hit && visible(env, project(env, a.world.clone().lerp(b.world, 0.5)))) out.push({ objectId: id, key: keyOfEdge(e) });
      }
    } else {
      for (const f of t.obj.mesh.faces.values()) {
        const pts = f.outer.verts().map((v) => proj.get(v)!);
        if (pts.some((p) => !p.ok)) continue;
        let hit: boolean;
        if (!crossing) {
          hit = pts.every((p) => inRect(r, p.x, p.y));
        } else {
          hit =
            pts.some((p) => inRect(r, p.x, p.y)) ||
            pts.some((p, i) => {
              const q = pts[(i + 1) % pts.length]!;
              return segmentHitsRect(r, p.x, p.y, q.x, q.y);
            }) ||
            pointInPolygon2D(center, pts.map((p) => [p.x, p.y]));
        }
        if (hit && faceVisible(env, pts)) out.push({ objectId: id, key: f.id });
      }
    }
  }
  return out;
}

/** A face counts as visible if its centre or any corner (nudged inward) is unobstructed. */
function faceVisible(env: PickEnv, pts: Projected[]): boolean {
  if (env.xray) return true;
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p.world);
  c.divideScalar(pts.length);
  if (visible(env, project(env, c))) return true;
  return pts.some((p) => visible(env, project(env, p.world.clone().lerp(c, 0.05))));
}

/** Object box selection. Occlusion is ignored, as in SketchUp. */
export function boxObjects(env: PickEnv, r: Rect, crossing: boolean): ObjectId[] {
  const out: ObjectId[] = [];
  for (const t of env.targets) {
    const pv = projectVerts(env, t);
    const proj = [...pv.values()];
    if (!proj.length || proj.some((p) => !p.ok)) continue;
    if (!crossing) {
      if (proj.every((p) => inRect(r, p.x, p.y))) out.push(t.obj.id);
      continue;
    }
    const touches =
      proj.some((p) => inRect(r, p.x, p.y)) ||
      [...t.obj.mesh.edges()].some((e) => {
        const a = pv.get(e.verts[0])!;
        const b = pv.get(e.verts[1])!;
        return segmentHitsRect(r, a.x, a.y, b.x, b.y);
      });
    if (touches) out.push(t.obj.id);
  }
  return out;
}
