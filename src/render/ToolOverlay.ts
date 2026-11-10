import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Vec3 } from '../core/math/vec';

/**
 * What the drawing tools show on top of the scene: the shape being drawn (thick lines), a dashed
 * guide along an axis or locked direction, the inference marker, and a tooltip naming the
 * inference. Everything draws over the model (no depth test), in world space.
 */
export class ToolOverlay {
  readonly root = new THREE.Group();
  private readonly lineMat = new LineMaterial({ color: 0xffffff, linewidth: 2, depthTest: false });
  private readonly lines = new LineSegments2(new LineSegmentsGeometry(), this.lineMat);
  private readonly guideMat = new THREE.LineDashedMaterial({ dashSize: 0.1, gapSize: 0.06, depthTest: false });
  private readonly guide = new THREE.Line(new THREE.BufferGeometry(), this.guideMat);
  private readonly markerMat = new THREE.PointsMaterial({ size: 10, sizeAttenuation: false, depthTest: false });
  private readonly marker = new THREE.Points(new THREE.BufferGeometry(), this.markerMat);
  private readonly tip: HTMLDivElement;

  constructor(container: HTMLElement) {
    this.root.name = 'tool-overlay';
    for (const o of [this.lines, this.guide, this.marker]) {
      o.renderOrder = 20;
      o.frustumCulled = false;
      o.visible = false;
      this.root.add(o);
    }
    this.marker.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    this.tip = document.createElement('div');
    this.tip.className = 'infer-tip';
    this.tip.hidden = true;
    container.appendChild(this.tip);
  }

  setResolution(width: number, height: number): void {
    this.lineMat.resolution.set(width, height);
  }

  /** Thick lines: a polyline (closed or not) or separate segments. */
  setLines(segments: [Vec3, Vec3][], color = 0xffffff): void {
    if (!segments.length) {
      this.lines.visible = false;
      return;
    }
    const geo = new LineSegmentsGeometry();
    geo.setPositions(segments.flatMap(([a, b]) => [...a, ...b]));
    this.lines.geometry.dispose();
    this.lines.geometry = geo;
    this.lineMat.color.setHex(color);
    this.lines.visible = true;
  }

  setPath(points: Vec3[], closed: boolean, color?: number): void {
    const segs: [Vec3, Vec3][] = [];
    for (let i = 0; i + 1 < points.length; i++) segs.push([points[i]!, points[i + 1]!]);
    if (closed && points.length > 2) segs.push([points[points.length - 1]!, points[0]!]);
    this.setLines(segs, color);
  }

  /** A dashed guide line, e.g. along the axis being followed. */
  setGuide(a: Vec3 | null, b?: Vec3, color = 0xffffff): void {
    if (!a || !b) {
      this.guide.visible = false;
      return;
    }
    this.guide.geometry.dispose();
    this.guide.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
    this.guide.computeLineDistances();
    // Dash length in world units: keep a handful of dashes whatever the line's length.
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    this.guideMat.dashSize = Math.max(len / 40, 1e-3);
    this.guideMat.gapSize = this.guideMat.dashSize * 0.6;
    this.guideMat.color.setHex(color);
    this.guide.visible = true;
  }

  setMarker(p: Vec3 | null, color = 0xffffff): void {
    if (!p) {
      this.marker.visible = false;
      return;
    }
    const pos = this.marker.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, p[0], p[1], p[2]);
    pos.needsUpdate = true;
    this.markerMat.color.setHex(color);
    this.marker.visible = true;
  }

  /** Tooltip near the pointer (canvas pixels). */
  setTip(text: string | null, x = 0, y = 0): void {
    if (!text) {
      this.tip.hidden = true;
      return;
    }
    this.tip.textContent = text;
    this.tip.style.left = `${x + 14}px`;
    this.tip.style.top = `${y + 14}px`;
    this.tip.hidden = false;
  }

  clear(): void {
    this.lines.visible = false;
    this.guide.visible = false;
    this.marker.visible = false;
    this.tip.hidden = true;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.lineMat.dispose();
    this.guide.geometry.dispose();
    this.guideMat.dispose();
    this.marker.geometry.dispose();
    this.markerMat.dispose();
    this.tip.remove();
  }
}
