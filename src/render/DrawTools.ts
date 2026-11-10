import * as THREE from 'three';
import type { ObjectId } from '../core/document';
import { add, dot, length, normalize, scale, sub, type Vec3 } from '../core/math/vec';
import type { VertId } from '../core/meshdata';
import { edgeRing, loopCutSegments } from '../core/ops/loopcut';
import { edgeOf } from '../editor/components';
import { drawShape, loopCutEdge } from '../editor/drawActions';
import { editor } from '../editor/editor';
import { type MeasureHandler, offerMeasure, offerReplace, parseNumbers, withdrawMeasure } from '../editor/measure';
import type { ComponentRef } from '../editor/selection';
import { cursorWorld, measurement } from '../editor/state';
import { snapScalar } from '../editor/snap';
import { COLORS } from './colors';
import { AXES, type Inference, type InferOptions, lineRayParam } from './Inference';
import type { ToolOverlay } from './ToolOverlay';
import { transformToMatrix } from './transformMath';

/**
 * Viewport tools that place points with inference snapping (Line, Rectangle) or cut on hover
 * (Loop Cut). The viewport hands them the pointer and keys; they draw previews on the overlay and
 * commit through the editor's draw actions.
 */

export interface ToolHost {
  infer(x: number, y: number, opts?: InferOptions): Inference | null;
  worldRay(x: number, y: number): THREE.Ray;
  /** An edge of a visible, unlocked object under the pointer. */
  pickEdge(x: number, y: number): ComponentRef | null;
  /** Unit vector from the scene toward the viewer. */
  towardCamera(): Vec3;
  snap(): boolean;
  gridStep(): number;
  readonly overlay: ToolOverlay;
  requestRender(): void;
}

export interface ViewTool {
  move(x: number, y: number): void;
  down(x: number, y: number): void;
  /** Returns true if the key was used (the viewport then stops it reaching other shortcuts). */
  key(e: KeyboardEvent): boolean;
  keyUp(e: KeyboardEvent): void;
  /** Abandon whatever is in progress and clear the overlay. */
  dispose(): void;
}

const EPS = 1e-9;
const round = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
const roundV = (p: Vec3): Vec3 => [round(p[0]), round(p[1]), round(p[2])];
const fmt = (x: number) => (Math.round(x * 1000) / 1000).toString();

const ARROW_AXES: Record<string, Vec3> = {
  ArrowRight: AXES[0]!.dir,
  ArrowLeft: AXES[1]!.dir,
  ArrowUp: AXES[2]!.dir,
};

const sameLine = (a: Vec3, b: Vec3) => Math.abs(Math.abs(dot(a, b)) - 1) < 1e-9;

/**
 * Line: click to place points. A line from the edge of a face to its edge splits the face; a
 * closed loop makes a face (a hole filled by a new face, if drawn on a face). Arrow keys lock
 * the direction (→ X, ← Y, ↑ Z, ↓ the edge or axis being inferred); holding Shift locks the
 * current inference. Typing a length (or an x,y,z offset) places the next point exactly.
 */
export class LineTool implements ViewTool {
  private pts: Vec3[] = [];
  private cur: Inference | null = null;
  private lock: Vec3 | null = null;
  private shiftLock = false;
  private startObject: ObjectId | null = null;
  private pointer: { x: number; y: number } | null = null;
  private readonly handler: MeasureHandler = {
    label: 'Length',
    valid: () => this.pts.length > 0,
    apply: (text) => this.typed(text),
  };

  constructor(private readonly host: ToolHost) {}

  private last(): Vec3 | null {
    return this.pts[this.pts.length - 1] ?? null;
  }

  move(x: number, y: number): void {
    this.pointer = { x, y };
    this.update();
  }

  down(x: number, y: number): void {
    this.move(x, y);
    if (this.cur) this.place(this.cur.point, this.cur);
  }

  private update(): void {
    const o = this.host.overlay;
    const from = this.last();
    const inf = this.pointer ? this.host.infer(this.pointer.x, this.pointer.y, { from, lock: from ? this.lock : null, points: this.pts }) : null;
    this.cur = inf;
    if (inf) {
      o.setMarker(inf.point, inf.color);
      o.setTip(inf.label, this.pointer!.x, this.pointer!.y);
      o.setGuide(from && inf.axis ? from : null, inf.point, inf.color);
      cursorWorld.value = inf.point;
    } else {
      o.setMarker(null);
      o.setTip(null);
      o.setGuide(null);
    }
    o.setPath(from && inf ? [...this.pts, inf.point] : this.pts, false);
    measurement.value = from && inf ? fmt(length(sub(inf.point, from))) : null;
    this.host.requestRender();
  }

  private place(point: Vec3, inf: Inference | null): void {
    const p = roundV(point);
    const last = this.last();
    if (last && length(sub(p, last)) < EPS) return;
    if (!last) {
      this.pts = [p];
      this.startObject = inf?.objectId ?? inf?.face?.objectId ?? null;
      offerMeasure(this.handler);
      this.update();
      return;
    }
    const up = this.host.towardCamera();
    if (this.pts.length >= 3 && length(sub(p, this.pts[0]!)) < EPS) {
      if (drawShape(this.pts, true, 'Draw Line', up, this.startObject) !== 'error') this.reset();
      return;
    }
    this.pts.push(p);
    const r = drawShape(this.pts, false, 'Draw Line', up, this.startObject);
    if (r === 'error') this.pts.pop();
    else if (r !== 'pending') {
      // The line became part of a face: carry on drawing from its end.
      this.pts = [p];
      this.startObject = inf?.objectId ?? inf?.face?.objectId ?? this.startObject;
    }
    if (!this.shiftLock) this.lock = null;
    this.update();
  }

  /** A typed length along the current direction, or an x,y,z offset from the last point. */
  private typed(text: string): string | void {
    const nums = parseNumbers(text);
    const last = this.last();
    if (!nums || !last || (nums.length !== 1 && nums.length !== 3)) return 'Type a length, or an x,y,z offset';
    if (nums.length === 3) {
      this.place(add(last, nums as Vec3), null);
      return;
    }
    const toward = this.cur ? sub(this.cur.point, last) : null;
    let dir: Vec3 | null = null;
    if (this.lock) dir = toward && dot(toward, this.lock) < 0 ? scale(this.lock, -1) : this.lock;
    else if (toward && length(toward) > EPS) dir = normalize(toward);
    if (!dir) return 'Point the way first, then type the length';
    this.place(add(last, scale(dir, nums[0]!)), null);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      if (!this.pts.length) return false;
      this.reset();
      return true;
    }
    const axis = ARROW_AXES[e.key];
    if (axis || e.key === 'ArrowDown') {
      const dir = axis ?? this.cur?.edgeDir ?? this.cur?.axis ?? null;
      if (dir) this.lock = this.lock && sameLine(this.lock, dir) ? null : dir;
      this.shiftLock = false;
      this.update();
      return true;
    }
    if (e.key === 'Shift' && !e.repeat && !this.lock && this.last()) {
      const dir = this.cur?.axis ?? this.cur?.edgeDir;
      if (dir) {
        this.lock = dir;
        this.shiftLock = true;
        this.update();
      }
    }
    return false;
  }

  keyUp(e: KeyboardEvent): void {
    if (e.key === 'Shift' && this.shiftLock) {
      this.lock = null;
      this.shiftLock = false;
      this.update();
    }
  }

  private reset(): void {
    this.pts = [];
    this.lock = null;
    this.shiftLock = false;
    this.startObject = null;
    withdrawMeasure(this.handler);
    this.update();
  }

  dispose(): void {
    this.pointer = null;
    this.reset();
    this.host.overlay.clear();
    measurement.value = null;
  }
}

interface RectFrame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
  objectId: ObjectId | null;
}

/** In-plane axes: X/Y on horizontal planes; otherwise "up the slope" and level across it. */
function rectFrame(origin: Vec3, n: Vec3, objectId: ObjectId | null): RectFrame {
  if (Math.abs(n[2]) > 0.999) {
    const u: Vec3 = [1, 0, 0];
    const v: Vec3 = n[2] > 0 ? [0, 1, 0] : [0, -1, 0];
    return { origin, u, v, n, objectId };
  }
  const v = normalize(sub([0, 0, 1], scale(n, n[2])));
  const u: Vec3 = normalize([v[1] * n[2] - v[2] * n[1], v[2] * n[0] - v[0] * n[2], v[0] * n[1] - v[1] * n[0]]);
  return { origin, u, v, n, objectId };
}

function rectCorners(f: RectFrame, w: number, h: number): Vec3[] {
  const a = f.origin;
  const b = add(a, scale(f.u, w));
  return [a, b, add(b, scale(f.v, h)), add(a, scale(f.v, h))].map(roundV);
}

function parseDims(text: string, signs: [number, number]): [number, number] | string {
  const nums = parseNumbers(text);
  if (!nums || nums.length > 2) return 'Type width,height (or one size for a square)';
  const [w, h] = [nums[0]!, nums[1] ?? nums[0]!];
  if (Math.abs(w) < EPS || Math.abs(h) < EPS) return 'The rectangle needs a width and a height';
  return [w * signs[0], h * signs[1]];
}

/** Draw the rectangle, and offer to redraw it at typed dimensions. */
function commitRect(f: RectFrame, w: number, h: number, up: Vec3): void {
  if (drawShape(rectCorners(f, w, h), true, 'Draw Rectangle', up, f.objectId) !== 'drawn') return;
  const signs: [number, number] = [Math.sign(w) || 1, Math.sign(h) || 1];
  offerReplace(
    'Dimensions',
    (t) => parseDims(t, signs),
    ([w2, h2]) => commitRect(f, w2, h2, up),
  );
}

/**
 * Rectangle: click one corner, then the opposite one. On a face it lies in the face's plane,
 * otherwise on the horizontal plane through the first corner. Typing width,height sets the size.
 */
export class RectangleTool implements ViewTool {
  private frame: RectFrame | null = null;
  private dims: [number, number] = [0, 0];
  private cur: Inference | null = null;
  private pointer: { x: number; y: number } | null = null;
  private readonly handler: MeasureHandler = {
    label: 'Dimensions',
    valid: () => this.frame !== null,
    apply: (text) => {
      const d = parseDims(text, [Math.sign(this.dims[0]) || 1, Math.sign(this.dims[1]) || 1]);
      if (typeof d === 'string') return d;
      this.finish(d);
    },
  };

  constructor(private readonly host: ToolHost) {}

  move(x: number, y: number): void {
    this.pointer = { x, y };
    this.update();
  }

  down(x: number, y: number): void {
    this.move(x, y);
    if (!this.frame) {
      if (this.cur) this.start(this.cur);
    } else if (Math.abs(this.dims[0]) > EPS && Math.abs(this.dims[1]) > EPS) {
      this.finish(this.dims);
    }
  }

  private start(inf: Inference): void {
    const p = roundV(inf.point);
    const f = inf.face;
    const onFace = f && Math.abs(dot(sub(p, f.hit), f.normal)) < 1e-6;
    this.frame = rectFrame(p, onFace ? f.normal : [0, 0, 1], onFace ? f.objectId : inf.objectId);
    offerMeasure(this.handler);
    this.update();
  }

  private finish([w, h]: [number, number]): void {
    const f = this.frame!;
    this.reset();
    commitRect(f, w, h, this.host.towardCamera());
  }

  private update(): void {
    const o = this.host.overlay;
    const f = this.frame;
    if (!this.pointer) {
      o.clear();
      this.host.requestRender();
      return;
    }
    const { x, y } = this.pointer;
    const inf = this.host.infer(x, y, f ? { plane: { point: f.origin, normal: f.n }, points: [f.origin] } : {});
    this.cur = inf;
    if (!inf) {
      o.setMarker(null);
      o.setTip(null);
      this.host.requestRender();
      return;
    }
    if (!f) {
      o.setMarker(inf.point, inf.color);
      o.setTip(inf.label, x, y);
      o.setLines([]);
      cursorWorld.value = inf.point;
      this.host.requestRender();
      return;
    }
    const d = sub(inf.point, f.origin);
    let w = dot(d, f.u);
    let h = dot(d, f.v);
    const snapped = inf.kind === 'plane' || inf.kind === 'face';
    if (snapped && this.host.snap()) {
      w = snapScalar(w, this.host.gridStep());
      h = snapScalar(h, this.host.gridStep());
    }
    this.dims = [w, h];
    const corners = rectCorners(f, w, h);
    o.setPath(corners, true);
    o.setMarker(corners[2]!, inf.color);
    const square = Math.abs(Math.abs(w) - Math.abs(h)) < EPS && Math.abs(w) > EPS;
    o.setTip(snapped ? (square ? 'Square' : null) : inf.label, x, y);
    o.setGuide(null);
    cursorWorld.value = corners[2]!;
    measurement.value = `${fmt(Math.abs(w))}, ${fmt(Math.abs(h))}`;
    this.host.requestRender();
  }

  key(e: KeyboardEvent): boolean {
    if (e.key !== 'Escape' || !this.frame) return false;
    this.reset();
    return true;
  }

  keyUp(): void {}

  private reset(): void {
    this.frame = null;
    this.dims = [0, 0];
    withdrawMeasure(this.handler);
    measurement.value = null;
    this.host.overlay.setLines([]);
    this.update();
  }

  dispose(): void {
    this.pointer = null;
    this.reset();
    this.host.overlay.clear();
  }
}

/**
 * Loop Cut: hovering an edge previews a cut across the ring of quads through it, at the pointer
 * (snapped to the grid along the edge). Click to cut; then type a number to make that many evenly
 * spaced cuts instead.
 */
export class LoopCutTool implements ViewTool {
  private hover: { objectId: ObjectId; key: string; t: number; from: VertId } | null = null;
  private pointer: { x: number; y: number } | null = null;

  constructor(private readonly host: ToolHost) {}

  move(x: number, y: number): void {
    this.pointer = { x, y };
    this.update();
  }

  private update(): void {
    const o = this.host.overlay;
    this.hover = null;
    const ref = this.pointer && this.host.pickEdge(this.pointer.x, this.pointer.y);
    const obj = ref && editor.doc.findObject(ref.objectId);
    const e = obj && edgeOf(obj.mesh, ref!.key);
    if (!obj || !e) {
      o.clear();
      this.host.requestRender();
      return;
    }
    const m = transformToMatrix(obj.transform);
    const world = (p: readonly number[]): Vec3 => {
      const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m);
      return [v.x, v.y, v.z];
    };
    const ring = edgeRing(e);
    if (!ring.faces.length) {
      o.setLines([]);
      o.setTip('No quads to cut across', this.pointer!.x, this.pointer!.y);
      this.host.requestRender();
      return;
    }
    const a = new THREE.Vector3(...world(e.he.origin.pos));
    const b = new THREE.Vector3(...world(e.he.dest.pos));
    const len = a.distanceTo(b);
    let t = Math.min(0.999, Math.max(0.001, lineRayParam(a, b.clone().sub(a), this.host.worldRay(this.pointer!.x, this.pointer!.y)) ?? 0.5));
    if (this.host.snap()) {
      const d = snapScalar(t * len, this.host.gridStep());
      if (d > EPS && d < len - EPS) t = d / len;
    }
    this.hover = { objectId: obj.id, key: ref!.key as string, t, from: e.he.origin.id };
    o.setLines(
      loopCutSegments(ring, [t]).map(([p, q]) => [world(p), world(q)]),
      COLORS.componentSelection,
    );
    // The distance from the edge's end, beside the pointer (the measurement box is for typing a
    // number of cuts).
    o.setTip(fmt(t * len), this.pointer!.x, this.pointer!.y);
    o.setMarker(null);
    this.host.requestRender();
  }

  down(x: number, y: number): void {
    this.move(x, y);
    const h = this.hover;
    if (!h || !loopCutEdge(h.objectId, h.key, { t: h.t, from: h.from })) return;
    this.offerCuts(h.objectId, h.key);
    this.update();
  }

  private offerCuts(objectId: ObjectId, key: string): void {
    offerReplace(
      'Cuts',
      (text) => {
        const n = parseNumbers(text);
        return n && n.length === 1 && Number.isInteger(n[0]) && n[0]! >= 1 && n[0]! <= 100 ? n[0]! : 'Type a number of cuts (1–100)';
      },
      (cuts) => {
        if (loopCutEdge(objectId, key, { cuts })) this.offerCuts(objectId, key);
      },
    );
  }

  key(): boolean {
    return false;
  }

  keyUp(): void {}

  dispose(): void {
    this.pointer = null;
    this.hover = null;
    this.host.overlay.clear();
  }
}
