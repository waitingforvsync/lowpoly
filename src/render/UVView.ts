import type { ObjectId, SceneObject } from '../core/document';
import { fromMeshData, toMeshData } from '../core/halfedge/convert';
import type { HalfEdgeMesh } from '../core/halfedge/mesh';
import { pointInPolygon2D, type Vec2 } from '../core/math/vec';
import { ReplaceMeshCommand, type MeshState } from '../editor/commands';
import { editor } from '../editor/editor';
import { isComponentMode } from '../editor/modes';
import { componentSelection, editObjects, selectedObjects } from '../editor/selection';
import { gridStep, selectionMode, showStatus, snapEnabled, snapInvertHeld } from '../editor/state';
import { isSnapActive, snapScalar } from '../editor/snap';
import { type Command, CompositeCommand } from '../history/history';
import { tileSize } from '../io/obj';
import { loadImage } from '../io/texture';
import { COLORS } from './colors';

/**
 * The UV editor: a 2D view of face UVs, in texture repeats (a face's world-unit UVs divided by its
 * material's tile size), over the tiled texture. In face mode it shows the selected faces, which
 * can be dragged to move their UVs; otherwise every face of the objects being edited or selected,
 * for reference. Wheel zooms, middle or right drag pans.
 */

interface ShownFace {
  objectId: ObjectId;
  faceId: number;
  /** Outline (and holes) in texture repeats. */
  loops: Vec2[][];
  material: number;
  editable: boolean;
}

interface UVDrag {
  startX: number;
  startY: number;
  objects: { obj: SceneObject; before: MeshState; original: HalfEdgeMesh; faces: Set<number> }[];
  offset: Vec2;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export class UVView {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  /** View centre, in texture repeats. */
  private cx = 0.5;
  private cy = 0.5;
  /** Pixels per texture repeat. */
  private zoom = 200;
  private width = 1;
  private height = 1;
  private faces: ShownFace[] = [];
  private image: HTMLImageElement | null = null;
  private imageSrc = '';
  private pan: { x: number; y: number; cx: number; cy: number } | null = null;
  private drag: UVDrag | null = null;
  private framedOnce = false;
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly container: HTMLElement) {
    this.ctx = this.canvas.getContext('2d')!;
    container.appendChild(this.canvas);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onCancel);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKey, true);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  dispose(): void {
    this.onCancel();
    this.resizeObserver.disconnect();
    window.removeEventListener('keydown', this.onKey, true);
    this.canvas.remove();
  }

  /** Re-read the faces to show (after any document, selection or mode change). */
  update(showTextures: boolean): void {
    if (!this.drag) this.faces = collectFaces();
    const first = this.faces.find((f) => f.editable) ?? this.faces[0];
    const mat = first ? editor.doc.findMaterial(first.material) : undefined;
    const tex = showTextures && mat ? editor.doc.materialTexture(mat) : undefined;
    const src = tex?.data ?? '';
    if (src !== this.imageSrc) {
      this.imageSrc = src;
      this.image = null;
      if (src) {
        void loadImage(src)
          .then((img) => {
            if (this.imageSrc === src) {
              this.image = img;
              this.draw();
            }
          })
          .catch(() => {});
      }
    }
    if (!this.framedOnce && this.faces.length) {
      this.framedOnce = true;
      this.fit();
    }
    this.draw();
  }

  /** Frame the shown UVs (or the first texture repeat when there are none). */
  fit(): void {
    const pts = this.faces.flatMap((f) => f.loops.flat());
    let [x0, y0, x1, y1] = [0, 0, 1, 1];
    if (pts.length) {
      x0 = Math.min(...pts.map((p) => p[0]));
      x1 = Math.max(...pts.map((p) => p[0]));
      y0 = Math.min(...pts.map((p) => p[1]));
      y1 = Math.max(...pts.map((p) => p[1]));
    }
    this.cx = (x0 + x1) / 2;
    this.cy = (y0 + y1) / 2;
    const span = Math.max(x1 - x0, y1 - y0, 0.05);
    this.zoom = (Math.min(this.width, this.height) * 0.8) / span;
    this.draw();
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.width = Math.max(1, this.container.clientWidth);
    this.height = Math.max(1, this.container.clientHeight);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  // Texture repeats ↔ canvas pixels (V points up).
  private sx = (u: number) => this.width / 2 + (u - this.cx) * this.zoom;
  private sy = (v: number) => this.height / 2 - (v - this.cy) * this.zoom;
  private ux = (x: number) => this.cx + (x - this.width / 2) / this.zoom;
  private vy = (y: number) => this.cy - (y - this.height / 2) / this.zoom;

  private draw(): void {
    const g = this.ctx;
    const { width: w, height: h } = this;
    g.fillStyle = hex(COLORS.background);
    g.fillRect(0, 0, w, h);
    const u0 = Math.floor(this.ux(0));
    const u1 = Math.ceil(this.ux(w));
    const v0 = Math.floor(this.vy(h));
    const v1 = Math.ceil(this.vy(0));

    // The texture, repeated, with the first repeat (0..1) brighter.
    if (this.image && (u1 - u0) * (v1 - v0) <= 900) {
      for (let i = u0; i < u1; i++) {
        for (let j = v0; j < v1; j++) {
          g.globalAlpha = i === 0 && j === 0 ? 0.85 : 0.45;
          g.drawImage(this.image, this.sx(i), this.sy(j + 1), this.zoom, this.zoom);
        }
      }
      g.globalAlpha = 1;
    }

    // Grid: quarter repeats when zoomed in, repeat borders always.
    g.lineWidth = 1;
    const lines = (step: number, color: string) => {
      g.strokeStyle = color;
      g.beginPath();
      for (let u = Math.floor(u0 / step) * step; u <= u1; u += step) {
        const x = Math.round(this.sx(u)) + 0.5;
        g.moveTo(x, 0);
        g.lineTo(x, h);
      }
      for (let v = Math.floor(v0 / step) * step; v <= v1; v += step) {
        const y = Math.round(this.sy(v)) + 0.5;
        g.moveTo(0, y);
        g.lineTo(w, y);
      }
      g.stroke();
    };
    if (this.zoom > 80 && u1 - u0 < 200) lines(0.25, hex(COLORS.gridMinor));
    if (u1 - u0 < 400) lines(1, hex(COLORS.gridMajor));
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.strokeRect(this.sx(0) + 0.5, this.sy(1) + 0.5, this.zoom, this.zoom);

    // Faces: reference ones dim, editable (selected) ones highlighted.
    for (const f of this.faces) {
      g.beginPath();
      for (const loop of f.loops) {
        loop.forEach((p, i) => (i ? g.lineTo(this.sx(p[0]), this.sy(p[1])) : g.moveTo(this.sx(p[0]), this.sy(p[1]))));
        g.closePath();
      }
      if (f.editable) {
        g.fillStyle = 'rgba(255,154,46,0.18)';
        g.fill('evenodd');
        g.strokeStyle = hex(COLORS.componentSelection);
        g.lineWidth = 1.5;
      } else {
        g.strokeStyle = 'rgba(215,217,221,0.55)';
        g.lineWidth = 1;
      }
      g.stroke();
    }
    if (!this.faces.length) {
      g.fillStyle = '#8b9099';
      g.font = '12px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('Select faces (or an object) to see their UVs', w / 2, h / 2);
    }
  }

  // --- Input ---------------------------------------------------------------------------------------

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    const u = this.ux(p.x);
    const v = this.vy(p.y);
    this.zoom = Math.min(1e5, Math.max(2, this.zoom * Math.exp(-e.deltaY * 0.0015)));
    // Keep the point under the cursor fixed.
    this.cx = u - (p.x - this.width / 2) / this.zoom;
    this.cy = v + (p.y - this.height / 2) / this.zoom;
    this.draw();
  };

  private readonly onDown = (e: PointerEvent): void => {
    const p = this.local(e);
    this.canvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2) {
      this.pan = { x: p.x, y: p.y, cx: this.cx, cy: this.cy };
      return;
    }
    if (e.button !== 0) return;
    const uv: Vec2 = [this.ux(p.x), this.vy(p.y)];
    const hit = this.faces.some((f) => f.editable && pointInPolygon2D(uv, f.loops[0]!));
    if (!hit) return;
    // Move every editable face, per object.
    const byObject = new Map<ObjectId, Set<number>>();
    for (const f of this.faces) if (f.editable) (byObject.get(f.objectId) ?? byObject.set(f.objectId, new Set()).get(f.objectId)!).add(f.faceId);
    this.drag = {
      startX: p.x,
      startY: p.y,
      offset: [0, 0],
      objects: [...byObject].map(([id, faces]) => {
        const obj = editor.doc.object(id);
        return { obj, before: ReplaceMeshCommand.capture(obj), original: obj.mesh, faces };
      }),
    };
  };

  private readonly onMove = (e: PointerEvent): void => {
    const p = this.local(e);
    if (this.pan) {
      this.cx = this.pan.cx - (p.x - this.pan.x) / this.zoom;
      this.cy = this.pan.cy + (p.y - this.pan.y) / this.zoom;
      this.draw();
      return;
    }
    const d = this.drag;
    if (!d) return;
    let du = (p.x - d.startX) / this.zoom;
    let dv = -(p.y - d.startY) / this.zoom;
    if (isSnapActive(snapEnabled.peek(), snapInvertHeld.peek())) {
      // Snap to the grid step in texture repeats (a quarter repeat at the default 0.25).
      const step = gridStep.peek();
      du = snapScalar(du, step);
      dv = snapScalar(dv, step);
    }
    if (du === d.offset[0] && dv === d.offset[1]) return;
    d.offset = [du, dv];
    for (const o of d.objects) {
      const m = fromMeshData(o.before.mesh);
      for (const id of o.faces) {
        const f = m.faces.get(id);
        if (!f) continue;
        const [sx, sy] = tileSize(editor.doc.findMaterial(f.material));
        for (const h of f.halfEdges()) h.uv = [round(h.uv[0] + du * sx), round(h.uv[1] + dv * sy)];
      }
      o.obj.setMesh(m);
    }
    editor.notifyPreview();
    this.faces = collectFaces();
    this.draw();
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (this.pan && (e.button === 1 || e.button === 2)) {
      this.pan = null;
      return;
    }
    const d = this.drag;
    if (!d || e.button !== 0) return;
    this.drag = null;
    const cmds: Command[] = [];
    for (const o of d.objects) {
      const after = toMeshData(o.obj.mesh);
      o.obj.setMesh(o.original);
      if (d.offset[0] || d.offset[1]) cmds.push(new ReplaceMeshCommand(editor.ctx, o.obj.id, o.before, { mesh: after, source: null }, 'Move UVs'));
    }
    editor.notifyPreview();
    if (cmds.length) {
      editor.execute(cmds.length === 1 ? cmds[0]! : new CompositeCommand('Move UVs', cmds));
      showStatus(`Moved UVs by ${fmt(d.offset[0])}, ${fmt(d.offset[1])} repeats`);
    }
  };

  private readonly onCancel = (): void => {
    this.pan = null;
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    for (const o of d.objects) o.obj.setMesh(o.original);
    editor.notifyPreview();
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.drag) {
      this.onCancel();
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
}

const round = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
const fmt = (x: number) => String(Math.round(x * 1000) / 1000);

/** The faces the UV view shows for the current mode and selection. */
function collectFaces(): ShownFace[] {
  const doc = editor.doc;
  const mode = selectionMode.peek();
  const out: ShownFace[] = [];
  const add = (obj: SceneObject, ids: Iterable<number> | null, editable: boolean) => {
    const faces = ids ? [...ids].map((id) => obj.mesh.faces.get(id)).filter((f) => !!f) : [...obj.mesh.faces.values()];
    for (const f of faces) {
      const [sx, sy] = tileSize(doc.findMaterial(f.material));
      out.push({
        objectId: obj.id,
        faceId: f.id,
        material: f.material,
        editable,
        loops: f.loops.map((l) => Array.from(l.halfEdges(), (h) => [h.uv[0] / sx, h.uv[1] / sy] as Vec2)),
      });
    }
  };
  if (mode === 'face') {
    for (const [id, keys] of componentSelection.face.peek()) {
      const obj = doc.findObject(id);
      if (obj && keys.size) add(obj, [...keys].filter((k): k is number => typeof k === 'number'), true);
    }
    if (out.length) return out;
  }
  const ids = isComponentMode(mode) ? editObjects.peek() : selectedObjects.peek();
  for (const id of ids) {
    const obj = doc.findObject(id);
    if (obj?.visible) add(obj, null, false);
  }
  return out;
}
