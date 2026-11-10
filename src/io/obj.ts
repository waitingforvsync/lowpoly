import type { Document, Material, SceneObject } from '../core/document';
import { fromMeshData, toMeshData } from '../core/halfedge/convert';
import { type Face, HalfEdgeMesh, MeshError, type Vertex } from '../core/halfedge/mesh';
import { length, newellNormal, type ReadonlyVec3, type Vec2, type Vec3 } from '../core/math/vec';
import type { MeshData } from '../core/meshdata';
import { reverseLoop } from '../core/ops/extrude';
import { isPlanar } from '../core/planarity';
import { triangulateFace, triangulatePolygon } from '../core/triangulate';
import { projectUVs } from '../core/uv/continue';
import { transformPoint } from '../editor/transformPoints';
import { cornerNormal } from '../render/meshBuffers';

/**
 * Wavefront OBJ (+ MTL) export and import. OBJ is Y-up; the document is Z-up, so positions and
 * normals are converted at this boundary. Exported geometry is in world space (OBJ has no object
 * transforms). UVs are written in texture repeats (document UVs are in world units, divided by the
 * material's tile size), with OBJ's bottom-left image origin, which matches ours.
 */

/** Z-up (document) to Y-up (OBJ, glTF). */
export const toYUp = (p: ReadonlyVec3): Vec3 => [p[0], p[2], -p[1]];
/** Y-up to Z-up. */
export const fromYUp = (p: ReadonlyVec3): Vec3 => [p[0], -p[2], p[1]];

export interface ExportFile {
  name: string;
  data: string | Uint8Array;
}

const num = (x: number) => String(Math.round(x * 1e6) / 1e6 + 0);

/** A filesystem- and MTL-safe name. */
export function safeName(name: string, fallback = 'item'): string {
  const s = name.trim().replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
  return s || fallback;
}

function uniqueNamer(): (name: string) => string {
  const used = new Set<string>();
  return (name) => {
    let n = name;
    for (let i = 2; used.has(n.toLowerCase()); i++) n = `${name}_${i}`;
    used.add(n.toLowerCase());
    return n;
  };
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Bytes of a base64 `data:` URL. */
export function dataURLBytes(url: string): Uint8Array {
  const comma = url.indexOf(',');
  const bin = atob(url.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A world-space copy of an object's mesh. A mirroring transform (negative scale product) turns
 * faces inside out, so their loops are reversed to keep them facing outward.
 */
export function worldMesh(obj: SceneObject): HalfEdgeMesh {
  const d = toMeshData(obj.mesh);
  d.verts = d.verts.map((v) => ({ id: v.id, p: transformPoint(obj.transform, v.p) }));
  const s = obj.transform.scale;
  if (s[0] * s[1] * s[2] < 0) for (const f of d.faces) f.loops = f.loops.map(reverseLoop);
  return fromMeshData(d);
}

/** The tile size of a material (world units per texture repeat). */
export function tileSize(m: Material | undefined): Vec2 {
  const s = m?.textureSize;
  return s && s[0] > 0 && s[1] > 0 ? [s[0], s[1]] : [1, 1];
}

/** Per-corner normals of a face: flat, or smoothed across soft edges. */
export function faceCornerNormals(face: Face, faceNormals: Map<Face, Vec3>, smooth: boolean): Map<Vertex, Vec3> {
  const out = new Map<Vertex, Vec3>();
  for (const h of face.halfEdges()) out.set(h.origin, smooth ? cornerNormal(h, faceNormals) : faceNormals.get(face)!);
  return out;
}

export function faceNormalMap(mesh: HalfEdgeMesh): Map<Face, Vec3> {
  const m = new Map<Face, Vec3>();
  for (const f of mesh.faces.values()) {
    const n = f.normal();
    m.set(f, n[0] === 0 && n[1] === 0 && n[2] === 0 ? [0, 0, 1] : n);
  }
  return m;
}

/**
 * OBJ + MTL text for the given objects, plus the texture images they use. Faces stay polygons,
 * except faces with holes (which OBJ can't express) or everything when `triangulate` is set.
 */
export function exportOBJ(doc: Document, objects: readonly SceneObject[], baseName: string, triangulate = false): ExportFile[] {
  const base = safeName(baseName, 'model');
  const matName = new Map<number, string>();
  const nameMat = uniqueNamer();
  const nameTex = uniqueNamer();
  const texFile = new Map<number, string>();
  const images: ExportFile[] = [];
  const objLines = ['# Exported from Lowpoly (Y-up)', `mtllib ${base}.mtl`];
  const mtlLines = ['# Exported from Lowpoly'];
  const nameObj = uniqueNamer();
  let vBase = 1;
  let vtBase = 1;
  let vnBase = 1;

  const materialName = (id: number): string => {
    let n = matName.get(id);
    if (n) return n;
    const m = doc.findMaterial(id);
    n = nameMat(safeName(m?.name ?? 'Default', 'material'));
    matName.set(id, n);
    mtlLines.push('', `newmtl ${n}`, `Kd ${(m?.color ?? [0.8, 0.8, 0.8]).map(num).join(' ')}`, 'Ka 0 0 0', 'Ks 0 0 0', 'd 1', 'illum 1');
    const tex = m && doc.materialTexture(m);
    if (tex) {
      let file = texFile.get(tex.id);
      if (!file) {
        file = `${nameTex(safeName(tex.name.replace(/\.[^.]+$/, ''), 'texture'))}.${EXT[tex.mime] ?? 'png'}`;
        texFile.set(tex.id, file);
        images.push({ name: file, data: dataURLBytes(tex.data) });
      }
      mtlLines.push(`map_Kd ${file}`);
    }
    return n;
  };

  for (const obj of objects) {
    const mesh = worldMesh(obj);
    const normals = faceNormalMap(mesh);
    const smooth = [...mesh.edges()].some((e) => !e.hard);
    const verts = [...mesh.verts.values()];
    const vIndex = new Map(verts.map((v, i) => [v, vBase + i]));
    const vts: string[] = [];
    const vtIndex = new Map<string, number>();
    const vns: string[] = [];
    const vnIndex = new Map<string, number>();
    const index = (map: Map<string, number>, list: string[], key: string, start: number) => {
      let i = map.get(key);
      if (i === undefined) {
        i = start + list.length;
        map.set(key, i);
        list.push(key);
      }
      return i;
    };
    const faceLines: string[] = [];
    let lastMat = -1;
    const faces = [...mesh.faces.values()].sort((a, b) => a.material - b.material || a.id - b.id);
    for (const face of faces) {
      if (face.material !== lastMat) {
        faceLines.push(`usemtl ${materialName(face.material)}`);
        lastMat = face.material;
      }
      const size = tileSize(doc.findMaterial(face.material));
      const cn = faceCornerNormals(face, normals, smooth);
      const corner = (h: (typeof face.outer)['he']) => {
        const vt = index(vtIndex, vts, `${num(h.uv[0] / size[0])} ${num(h.uv[1] / size[1])}`, vtBase);
        const vn = index(vnIndex, vns, toYUp(cn.get(h.origin)!).map(num).join(' '), vnBase);
        return `${vIndex.get(h.origin)}/${vt}/${vn}`;
      };
      if (triangulate || face.holes.length) {
        const { corners, indices } = triangulateFace(face);
        for (let i = 0; i < indices.length; i += 3) {
          faceLines.push(`f ${[indices[i]!, indices[i + 1]!, indices[i + 2]!].map((k) => corner(corners[k]!)).join(' ')}`);
        }
      } else {
        faceLines.push(`f ${[...face.outer.halfEdges()].map(corner).join(' ')}`);
      }
    }
    objLines.push('', `o ${nameObj(safeName(obj.name, 'object'))}`);
    for (const v of verts) objLines.push(`v ${toYUp(v.pos).map(num).join(' ')}`);
    for (const t of vts) objLines.push(`vt ${t}`);
    for (const n of vns) objLines.push(`vn ${n}`);
    objLines.push('s off', ...faceLines);
    vBase += verts.length;
    vtBase += vts.length;
    vnBase += vns.length;
  }

  return [
    { name: `${base}.obj`, data: objLines.join('\n') + '\n' },
    { name: `${base}.mtl`, data: mtlLines.join('\n') + '\n' },
    ...images,
  ];
}

// --- Import ----------------------------------------------------------------------------------------

export interface ObjMaterial {
  name: string;
  /** Kd, taken as sRGB. */
  color: Vec3;
  /** map_Kd file name, as written in the MTL. */
  texture?: string;
}

export interface ObjImportObject {
  name: string;
  /** Mesh in the object's local space; face materials are indices into `slots`. */
  data: MeshData;
  /** Where the object's origin goes (the centre of its base). */
  origin: Vec3;
}

export interface ObjImport {
  objects: ObjImportObject[];
  /** Material names used by faces: slot 0 is "no material"; face.material indexes this list. */
  slots: (string | null)[];
  mtllibs: string[];
  warnings: string[];
}

function logicalLines(text: string): string[][] {
  const out: string[][] = [];
  let acc = '';
  for (const raw of text.split(/\r?\n/)) {
    if (raw.endsWith('\\')) {
      acc += raw.slice(0, -1) + ' ';
      continue;
    }
    const line = (acc + raw).replace(/#.*/, '').trim();
    acc = '';
    if (line) out.push(line.split(/\s+/));
  }
  return out;
}

export function parseMTL(text: string): ObjMaterial[] {
  const mats: ObjMaterial[] = [];
  let cur: ObjMaterial | null = null;
  for (const [key, ...args] of logicalLines(text)) {
    if (key === 'newmtl') {
      cur = { name: args.join(' '), color: [0.8, 0.8, 0.8] };
      mats.push(cur);
    } else if (cur && key === 'Kd' && args.length >= 3) {
      const c = args.slice(0, 3).map(Number);
      if (c.every(Number.isFinite)) cur.color = c.map((x) => Math.min(1, Math.max(0, x))) as Vec3;
    } else if (cur && key === 'map_Kd' && args.length) {
      // Options (-s, -o, ...) come first; the file name is last.
      cur.texture = args[args.length - 1]!;
    }
  }
  return mats;
}

interface RawCorner {
  v: number;
  vt: number | null;
  vn: number | null;
}

interface RawObject {
  name: string;
  faces: { corners: RawCorner[]; slot: number }[];
}

/**
 * Parse OBJ text into objects ready for the document: Z-up, every face planar (non-planar ones are
 * triangulated), degenerate faces dropped, and manifold (a face that would share an edge with two
 * others, or that winds against its neighbour, gets its own copy of its vertices). Edges whose
 * vertex normals agree on both sides become soft.
 */
export function parseOBJ(text: string, fallbackName = 'Imported'): ObjImport {
  const pos: Vec3[] = [];
  const tex: Vec2[] = [];
  const nor: Vec3[] = [];
  const slots: (string | null)[] = [null];
  const mtllibs: string[] = [];
  const warnings: string[] = [];
  const lines = logicalLines(text);
  const usesO = lines.some((l) => l[0] === 'o');
  const objects: RawObject[] = [];
  let cur: RawObject | null = null;
  let slot = 0;
  const start = (name: string) => {
    if (cur && !cur.faces.length) cur.name = name;
    else objects.push((cur = { name, faces: [] }));
  };
  const idx = (s: string | undefined, count: number): number | null => {
    if (!s) return null;
    const i = Number(s);
    if (!Number.isInteger(i) || i === 0) return null;
    const k = i < 0 ? count + i : i - 1;
    return k >= 0 && k < count ? k : null;
  };

  for (const [key, ...args] of lines) {
    if (key === 'v' && args.length >= 3) pos.push(fromYUp(args.slice(0, 3).map(Number) as Vec3));
    else if (key === 'vt' && args.length >= 1) tex.push([Number(args[0]), Number(args[1] ?? 0)]);
    else if (key === 'vn' && args.length >= 3) nor.push(fromYUp(args.slice(0, 3).map(Number) as Vec3));
    else if (key === 'o' || (key === 'g' && !usesO)) start(args.join(' ') || fallbackName);
    else if (key === 'usemtl') {
      const name = args.join(' ');
      slot = slots.indexOf(name);
      if (slot < 0) slot = slots.push(name) - 1;
    } else if (key === 'mtllib') mtllibs.push(...args);
    else if (key === 'f' && args.length >= 3) {
      if (!cur) start(fallbackName);
      const corners: RawCorner[] = [];
      let bad = false;
      for (const a of args) {
        const [v, vt, vn] = a.split('/');
        const vi = idx(v, pos.length);
        if (vi === null) bad = true;
        else corners.push({ v: vi, vt: idx(vt, tex.length), vn: idx(vn, nor.length) });
      }
      if (bad) warnings.push('a face refers to a missing vertex');
      else cur!.faces.push({ corners, slot });
    }
  }
  const out: ObjImportObject[] = [];
  for (const o of objects) {
    const built = buildObject(o, pos, tex, nor, warnings);
    if (built) out.push(built);
  }
  return { objects: out, slots, mtllibs, warnings: [...new Set(warnings)] };
}

function buildObject(o: RawObject, pos: Vec3[], tex: Vec2[], nor: Vec3[], warnings: string[]): ObjImportObject | null {
  const mesh = new HalfEdgeMesh();
  const shared = new Map<number, Vertex>();
  const vertexFor = (i: number) => {
    let v = shared.get(i);
    if (!v) shared.set(i, (v = mesh.addVertex([...pos[i]!])));
    return v;
  };
  /** Normal given in the file at each face corner, for deciding soft edges. */
  const cornerN = new Map<string, Vec3>();

  const addFace = (corners: RawCorner[], slot: number) => {
    const pts = corners.map((c) => pos[c.v]!);
    if (length(newellNormal(pts)) < 1e-12) {
      warnings.push('degenerate faces were skipped');
      return;
    }
    const uvs = corners.every((c) => c.vt !== null) ? corners.map((c) => tex[c.vt!]!) : projectUVs(pts);
    const make = (vs: Vertex[]) => mesh.addFace([vs.map((v, k) => ({ v, uv: uvs[k]! }))], slot);
    let face: Face;
    try {
      face = make(corners.map((c) => vertexFor(c.v)));
    } catch (e) {
      if (!(e instanceof MeshError)) throw e;
      // Non-manifold edge or inconsistent winding: give the face its own vertices.
      warnings.push('some faces were detached to keep the mesh manifold');
      face = make(corners.map((c) => mesh.addVertex([...pos[c.v]!])));
    }
    // The loop starts at the first corner, so corners and loop vertices line up.
    const verts = face.outer.verts();
    corners.forEach((c, k) => {
      if (c.vn !== null) cornerN.set(`${face.id}:${verts[k]!.id}`, nor[c.vn]!);
    });
  };

  for (const f of o.faces) {
    // Drop repeated consecutive corners (and a closing repeat).
    const cs = f.corners.filter((c, i, a) => c.v !== a[(i + a.length - 1) % a.length]!.v);
    if (cs.length < 3 || new Set(cs.map((c) => c.v)).size !== cs.length) {
      warnings.push('degenerate faces were skipped');
      continue;
    }
    const pts = cs.map((c) => pos[c.v]!);
    if (isPlanar(pts)) {
      addFace(cs, f.slot);
      continue;
    }
    warnings.push('non-planar faces were triangulated');
    const tri = triangulatePolygon([pts]);
    for (let i = 0; i < tri.length; i += 3) addFace([cs[tri[i]!]!, cs[tri[i + 1]!]!, cs[tri[i + 2]!]!], f.slot);
  }
  if (!mesh.faces.size) return null;

  // Soft edges: both faces give the same normal at both ends.
  const same = (a?: Vec3, b?: Vec3) => !!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-4;
  for (const e of mesh.edges()) {
    const [f1, f2] = e.faces();
    if (!f1 || !f2) continue;
    const ok = e.verts.every((v) => same(cornerN.get(`${f1.id}:${v.id}`), cornerN.get(`${f2.id}:${v.id}`)));
    // Faces that are flat to each other don't need smoothing.
    if (ok && !same(f1.normal(), f2.normal())) e.hard = false;
  }

  // Origin at the centre of the base.
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.verts.values()) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, v.pos[k]!);
      hi[k] = Math.max(hi[k]!, v.pos[k]!);
    }
  }
  const origin: Vec3 = [round((lo[0] + hi[0]) / 2), round((lo[1] + hi[1]) / 2), round(lo[2])];
  for (const v of mesh.verts.values()) v.pos = [round(v.pos[0] - origin[0]), round(v.pos[1] - origin[1]), round(v.pos[2] - origin[2])];
  return { name: o.name, data: toMeshData(mesh), origin };
}

const round = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
