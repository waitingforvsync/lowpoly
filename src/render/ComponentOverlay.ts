import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Document, ObjectId } from '../core/document';
import { triangulateFace } from '../core/triangulate';
import { edgeOf, faceOf, vertexOf } from '../editor/components';
import type { ComponentMode, ComponentRef, ComponentSet } from '../editor/selection';
import { COLORS } from './colors';
import { transformToMatrix } from './transformMath';

export interface OverlayState {
  mode: ComponentMode;
  editIds: ReadonlySet<ObjectId>;
  selection: ComponentSet;
  hover: ComponentRef | null;
  xray: boolean;
}

/**
 * Component-mode overlays: vertex dots, selected/hovered edges (thick lines) and selected/hovered
 * face fills, all in world space. Rebuilt whenever the document, selection or hover changes.
 */
export class ComponentOverlay {
  readonly root = new THREE.Group();
  private readonly pointMats = {
    normal: pointMaterial(COLORS.vertex, 6),
    selected: pointMaterial(COLORS.componentSelection, 8),
    hover: pointMaterial(COLORS.hover, 9),
  };
  private readonly lineMats = {
    selected: new LineMaterial({ color: COLORS.componentSelection, linewidth: 3 }),
    hover: new LineMaterial({ color: COLORS.hover, linewidth: 3 }),
  };
  private readonly fillMats = {
    selected: fillMaterial(COLORS.componentSelection, 0.4),
    hover: fillMaterial(COLORS.hover, 0.2),
  };

  constructor() {
    this.root.name = 'component-overlay';
  }

  setResolution(width: number, height: number): void {
    for (const m of Object.values(this.lineMats)) m.resolution.set(width, height);
  }

  update(doc: Document, state: OverlayState | null): void {
    this.clear();
    if (!state) return;
    const depthTest = !state.xray;
    for (const m of [...Object.values(this.pointMats), ...Object.values(this.lineMats), ...Object.values(this.fillMats)]) {
      m.depthTest = depthTest;
    }

    const hover = state.hover;
    for (const id of state.editIds) {
      const obj = doc.findObject(id);
      if (!obj || !obj.visible) continue;
      const m = transformToMatrix(obj.transform);
      const mesh = obj.mesh;
      const sel = state.selection.get(id) ?? new Set();
      const hoverKey = hover?.objectId === id ? hover.key : undefined;
      const world = (p: readonly number[]) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m);

      if (state.mode === 'vertex') {
        const normal: THREE.Vector3[] = [];
        const selected: THREE.Vector3[] = [];
        for (const v of mesh.verts.values()) (sel.has(v.id) ? selected : normal).push(world(v.pos));
        this.addPoints(normal, this.pointMats.normal, 5);
        this.addPoints(selected, this.pointMats.selected, 6);
        const hv = hoverKey !== undefined ? vertexOf(mesh, hoverKey) : undefined;
        if (hv) this.addPoints([world(hv.pos)], this.pointMats.hover, 7);
      } else if (state.mode === 'edge') {
        const seg: number[] = [];
        for (const key of sel) {
          const e = edgeOf(mesh, key);
          if (e) seg.push(...world(e.verts[0].pos).toArray(), ...world(e.verts[1].pos).toArray());
        }
        this.addLines(seg, this.lineMats.selected, 6);
        const he = hoverKey !== undefined ? edgeOf(mesh, hoverKey) : undefined;
        if (he) this.addLines([...world(he.verts[0].pos).toArray(), ...world(he.verts[1].pos).toArray()], this.lineMats.hover, 7);
      } else {
        const tris: number[] = [];
        for (const key of sel) {
          const f = faceOf(mesh, key);
          if (f) pushFace(tris, f, world);
        }
        this.addFill(tris, this.fillMats.selected, 6);
        const hf = hoverKey !== undefined ? faceOf(mesh, hoverKey) : undefined;
        if (hf && !sel.has(hf.id)) {
          const h: number[] = [];
          pushFace(h, hf, world);
          this.addFill(h, this.fillMats.hover, 7);
        }
      }
    }
  }

  dispose(): void {
    this.clear();
    for (const m of [...Object.values(this.pointMats), ...Object.values(this.lineMats), ...Object.values(this.fillMats)]) {
      m.dispose();
    }
  }

  private clear(): void {
    for (const child of [...this.root.children]) {
      this.root.remove(child);
      (child as THREE.Mesh).geometry.dispose();
    }
  }

  private addPoints(points: THREE.Vector3[], mat: THREE.PointsMaterial, order: number): void {
    if (!points.length) return;
    const p = new THREE.Points(new THREE.BufferGeometry().setFromPoints(points), mat);
    p.renderOrder = order;
    p.raycast = () => {};
    this.root.add(p);
  }

  private addLines(positions: number[], mat: LineMaterial, order: number): void {
    if (!positions.length) return;
    const g = new LineSegmentsGeometry().setPositions(positions);
    const l = new LineSegments2(g, mat);
    l.renderOrder = order;
    l.raycast = () => {};
    this.root.add(l);
  }

  private addFill(positions: number[], mat: THREE.MeshBasicMaterial, order: number): void {
    if (!positions.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = order;
    mesh.raycast = () => {};
    this.root.add(mesh);
  }
}

function pushFace(
  out: number[],
  f: Parameters<typeof triangulateFace>[0],
  world: (p: readonly number[]) => THREE.Vector3,
): void {
  const { corners, indices } = triangulateFace(f);
  for (const i of indices) out.push(...world(corners[i]!.origin.pos).toArray());
}

function pointMaterial(color: number, size: number): THREE.PointsMaterial {
  return new THREE.PointsMaterial({ color, size, sizeAttenuation: false });
}

function fillMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    opacity,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
