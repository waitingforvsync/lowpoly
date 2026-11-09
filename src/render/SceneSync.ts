import * as THREE from 'three';
import type { Document, ObjectId, SceneObject } from '../core/document';
import { DEFAULT_MATERIAL_ID } from '../core/document';
import type { MaterialId } from '../core/meshdata';
import { applyTransform } from './transformMath';
import { buildMeshBuffers } from './meshBuffers';
import { COLORS } from './colors';

interface Entry {
  group: THREE.Group;
  mesh: THREE.Mesh;
  lines: THREE.LineSegments;
  softLines: THREE.LineSegments;
  meshRev: number;
  /** Material id per geometry group. */
  groupMaterials: MaterialId[];
}

/**
 * Mirrors the document into a Three.js scene graph. Rebuilds an object's geometry only when its
 * meshRev changes; transforms, visibility, selection and material colours sync every time.
 */
export class SceneSync {
  readonly root = new THREE.Group();
  private readonly entries = new Map<ObjectId, Entry>();
  private readonly materials = new Map<MaterialId, THREE.MeshStandardMaterial>();
  private readonly edgeMaterial = new THREE.LineBasicMaterial({ color: COLORS.edge });
  private readonly selectedEdgeMaterial = new THREE.LineBasicMaterial({ color: COLORS.selection });
  /** Soft edges: drawn faintly, so smooth surfaces read as smooth. */
  private readonly softEdgeMaterial = new THREE.LineBasicMaterial({ color: COLORS.edge, transparent: true, opacity: 0.25 });
  private readonly selectedSoftEdgeMaterial = new THREE.LineBasicMaterial({
    color: COLORS.selection,
    transparent: true,
    opacity: 0.4,
  });

  constructor() {
    this.root.name = 'document';
  }

  /** Mesh for an object, if it has been synced. */
  meshOf(id: ObjectId): THREE.Mesh | undefined {
    return this.entries.get(id)?.mesh;
  }

  /**
   * @param selected objects drawn with highlighted edges
   * @param xray draw faces translucent so hidden geometry shows through
   */
  sync(doc: Document, selected: ReadonlySet<ObjectId>, xray = false): void {
    this.syncMaterials(doc, xray);

    const live = new Set<ObjectId>();
    for (const obj of doc.objects) {
      live.add(obj.id);
      let entry = this.entries.get(obj.id);
      if (!entry) {
        entry = this.createEntry(obj);
        this.entries.set(obj.id, entry);
        this.root.add(entry.group);
      }
      if (entry.meshRev !== obj.meshRev) this.rebuildGeometry(entry, obj);

      applyTransform(entry.group, obj.transform);
      entry.group.visible = obj.visible;
      const sel = selected.has(obj.id);
      entry.lines.material = sel ? this.selectedEdgeMaterial : this.edgeMaterial;
      entry.softLines.material = sel ? this.selectedSoftEdgeMaterial : this.softEdgeMaterial;
      entry.mesh.material = entry.groupMaterials.map(
        (id) => this.materials.get(id) ?? this.materials.get(DEFAULT_MATERIAL_ID)!,
      );
    }

    for (const [id, entry] of this.entries) {
      if (live.has(id)) continue;
      this.root.remove(entry.group);
      entry.mesh.geometry.dispose();
      entry.lines.geometry.dispose();
      entry.softLines.geometry.dispose();
      this.entries.delete(id);
    }
  }

  /** Meshes that can be clicked: visible and unlocked objects. */
  pickables(doc: Document): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const obj of doc.objects) {
      if (!obj.visible || obj.locked) continue;
      const e = this.entries.get(obj.id);
      if (e) out.push(e.mesh);
    }
    return out;
  }

  /** World-space bounds of the given objects. Empty box when none are visible. */
  bounds(ids: Iterable<ObjectId>): THREE.Box3 {
    const box = new THREE.Box3();
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e && e.group.visible) {
        e.group.updateMatrixWorld(true);
        box.expandByObject(e.mesh);
      }
    }
    return box;
  }

  dispose(): void {
    for (const e of this.entries.values()) {
      e.mesh.geometry.dispose();
      e.lines.geometry.dispose();
      e.softLines.geometry.dispose();
    }
    for (const m of this.materials.values()) m.dispose();
    this.edgeMaterial.dispose();
    this.selectedEdgeMaterial.dispose();
    this.softEdgeMaterial.dispose();
    this.selectedSoftEdgeMaterial.dispose();
  }

  private syncMaterials(doc: Document, xray: boolean): void {
    const live = new Set<MaterialId>();
    for (const m of doc.materials) {
      live.add(m.id);
      let mat = this.materials.get(m.id);
      if (!mat) {
        mat = new THREE.MeshStandardMaterial({
          // Normals come from the mesh: flat per face, smoothed across soft edges.
          side: THREE.DoubleSide,
          roughness: 0.85,
          metalness: 0,
          // Push faces back slightly so edges draw cleanly on top.
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        this.materials.set(m.id, mat);
      }
      mat.color.setRGB(m.color[0], m.color[1], m.color[2], THREE.SRGBColorSpace);
      if (mat.transparent !== xray) {
        mat.transparent = xray;
        mat.opacity = xray ? 0.35 : 1;
        mat.depthWrite = !xray;
        mat.needsUpdate = true;
      }
    }
    for (const [id, mat] of this.materials) {
      if (!live.has(id)) {
        mat.dispose();
        this.materials.delete(id);
      }
    }
  }

  private createEntry(obj: SceneObject): Entry {
    const group = new THREE.Group();
    group.userData.objectId = obj.id;
    const mesh = new THREE.Mesh(new THREE.BufferGeometry());
    mesh.userData.objectId = obj.id;
    const lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.edgeMaterial);
    const softLines = new THREE.LineSegments(new THREE.BufferGeometry(), this.softEdgeMaterial);
    lines.raycast = () => {}; // edges are picked by the Picker, not by raycasting lines
    softLines.raycast = () => {};
    group.add(mesh, lines, softLines);
    return { group, mesh, lines, softLines, meshRev: -1, groupMaterials: [] };
  }

  private rebuildGeometry(entry: Entry, obj: SceneObject): void {
    const b = buildMeshBuffers(obj.mesh);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(b.uvs, 2));
    b.groups.forEach((g, i) => geo.addGroup(g.start, g.count, i));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    entry.mesh.geometry.dispose();
    entry.mesh.geometry = geo;
    entry.mesh.userData.triFaces = b.triFaces;
    entry.groupMaterials = b.groups.map((g) => g.material);

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(b.edges, 3));
    entry.lines.geometry.dispose();
    entry.lines.geometry = lineGeo;

    const softGeo = new THREE.BufferGeometry();
    softGeo.setAttribute('position', new THREE.BufferAttribute(b.softEdges, 3));
    entry.softLines.geometry.dispose();
    entry.softLines.geometry = softGeo;

    entry.meshRev = obj.meshRev;
  }
}
