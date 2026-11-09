import { add, dot, length, newellNormal, normalize, scale, type Vec2, type Vec3 } from './math/vec';
import type { Corner, MaterialId, MeshData, VertId } from './meshdata';
import { planarAxes, planarUV } from './uv/project';

/**
 * Parametric primitives. Every primitive:
 * - is Z-up, with its origin at the centre of its base, sitting on the ground (z >= 0);
 * - has outward-facing CCW faces, and is closed (except the plane);
 * - has UVs in world units: planar projection on flat faces, arc length on curved surfaces.
 */

export interface PrimitiveParams {
  box: { width: number; depth: number; height: number };
  plane: { width: number; depth: number };
  cylinder: { radius: number; height: number; sides: number };
  cone: { radius: number; height: number; sides: number };
  sphere: { radius: number; subdivisions: number };
  torus: { majorRadius: number; minorRadius: number; segments: number; sides: number };
}

export type PrimitiveType = keyof PrimitiveParams;

export type PrimitiveSource = {
  [K in PrimitiveType]: { type: K; params: PrimitiveParams[K] };
}[PrimitiveType];

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max?: number;
  integer?: boolean;
}

export interface PrimitiveDef<K extends PrimitiveType> {
  label: string;
  defaults: PrimitiveParams[K];
  params: ParamDef[];
}

const SIZE_MIN = 0.001;

export const PRIMITIVES: { [K in PrimitiveType]: PrimitiveDef<K> } = {
  box: {
    label: 'Box',
    defaults: { width: 1, depth: 1, height: 1 },
    params: [
      { key: 'width', label: 'Width (X)', min: SIZE_MIN },
      { key: 'depth', label: 'Depth (Y)', min: SIZE_MIN },
      { key: 'height', label: 'Height (Z)', min: SIZE_MIN },
    ],
  },
  plane: {
    label: 'Plane',
    defaults: { width: 1, depth: 1 },
    params: [
      { key: 'width', label: 'Width (X)', min: SIZE_MIN },
      { key: 'depth', label: 'Depth (Y)', min: SIZE_MIN },
    ],
  },
  cylinder: {
    label: 'Cylinder',
    defaults: { radius: 0.5, height: 1, sides: 8 },
    params: [
      { key: 'radius', label: 'Radius', min: SIZE_MIN },
      { key: 'height', label: 'Height', min: SIZE_MIN },
      { key: 'sides', label: 'Sides', min: 3, max: 128, integer: true },
    ],
  },
  cone: {
    label: 'Cone',
    defaults: { radius: 0.5, height: 1, sides: 8 },
    params: [
      { key: 'radius', label: 'Radius', min: SIZE_MIN },
      { key: 'height', label: 'Height', min: SIZE_MIN },
      { key: 'sides', label: 'Sides', min: 3, max: 128, integer: true },
    ],
  },
  sphere: {
    label: 'Sphere',
    defaults: { radius: 0.5, subdivisions: 1 },
    params: [
      { key: 'radius', label: 'Radius', min: SIZE_MIN },
      { key: 'subdivisions', label: 'Subdivisions', min: 0, max: 4, integer: true },
    ],
  },
  torus: {
    label: 'Torus',
    defaults: { majorRadius: 0.5, minorRadius: 0.2, segments: 12, sides: 6 },
    params: [
      { key: 'majorRadius', label: 'Major radius', min: SIZE_MIN },
      { key: 'minorRadius', label: 'Minor radius', min: SIZE_MIN },
      { key: 'segments', label: 'Segments', min: 3, max: 128, integer: true },
      { key: 'sides', label: 'Sides', min: 3, max: 64, integer: true },
    ],
  },
};

export const PRIMITIVE_TYPES = Object.keys(PRIMITIVES) as PrimitiveType[];

export function defaultSource(type: PrimitiveType): PrimitiveSource {
  return { type, params: { ...PRIMITIVES[type].defaults } } as PrimitiveSource;
}

/** Clamp and round parameters to their valid ranges. */
export function sanitizeSource(src: PrimitiveSource): PrimitiveSource {
  const params: Record<string, number> = { ...(src.params as unknown as Record<string, number>) };
  for (const def of PRIMITIVES[src.type].params) {
    let v = Number(params[def.key]);
    if (!Number.isFinite(v)) v = (PRIMITIVES[src.type].defaults as unknown as Record<string, number>)[def.key]!;
    if (def.integer) v = Math.round(v);
    v = Math.max(def.min, def.max !== undefined ? Math.min(def.max, v) : v);
    params[def.key] = v;
  }
  return { type: src.type, params } as unknown as PrimitiveSource;
}

export function buildPrimitive(src: PrimitiveSource, material: MaterialId = 0): MeshData {
  const s = sanitizeSource(src);
  const b = new Builder(material);
  switch (s.type) {
    case 'box':
      box(b, s.params);
      break;
    case 'plane':
      plane(b, s.params);
      break;
    case 'cylinder':
      cylinder(b, s.params);
      break;
    case 'cone':
      cone(b, s.params);
      break;
    case 'sphere':
      sphere(b, s.params);
      break;
    case 'torus':
      torus(b, s.params);
      break;
  }
  return b.build();
}

// -------------------------------------------------------------------------------------------------

class Builder {
  private readonly verts: MeshData['verts'] = [];
  private readonly faces: MeshData['faces'] = [];
  constructor(private readonly material: MaterialId) {}

  vert(p: Vec3): VertId {
    const id = this.verts.length;
    this.verts.push({ id, p: [clean(p[0]), clean(p[1]), clean(p[2])] });
    return id;
  }

  pos(id: VertId): Vec3 {
    return this.verts[id]!.p;
  }

  /** Add a face with explicit UVs. */
  face(ids: VertId[], uvs: Vec2[]): void {
    const loop: Corner[] = ids.map((v, i) => ({ v, uv: [clean(uvs[i]![0]), clean(uvs[i]![1])] }));
    this.faces.push({ id: this.faces.length, material: this.material, loops: [loop] });
  }

  /** Add a flat face with planar-projected UVs. */
  flatFace(ids: VertId[]): void {
    const axes = planarAxes(newellNormal(ids.map((id) => this.pos(id))));
    this.face(
      ids,
      ids.map((id) => planarUV(this.pos(id), axes)),
    );
  }

  build(): MeshData {
    return {
      verts: this.verts,
      faces: this.faces,
      wireEdges: [],
      softEdges: [],
      nextVertId: this.verts.length,
      nextFaceId: this.faces.length,
    };
  }
}

/** Trim floating-point noise (e.g. cos(π/2) = 6e-17) and negative zero. */
function clean(x: number): number {
  return Math.round(x * 1e9) / 1e9 + 0;
}

/** Ring of n points around the Z axis at height z. Side 0 is centred on -Y (facing the front). */
function ring(n: number, r: number, z: number): Vec3[] {
  const offset = -Math.PI / 2 - Math.PI / n;
  return Array.from({ length: n }, (_, i) => {
    const a = offset + (2 * Math.PI * i) / n;
    return [r * Math.cos(a), r * Math.sin(a), z] as Vec3;
  });
}

function box(b: Builder, { width: w, depth: d, height: h }: PrimitiveParams['box']): void {
  const x = w / 2;
  const y = d / 2;
  const v = [
    b.vert([-x, -y, 0]),
    b.vert([x, -y, 0]),
    b.vert([x, y, 0]),
    b.vert([-x, y, 0]),
    b.vert([-x, -y, h]),
    b.vert([x, -y, h]),
    b.vert([x, y, h]),
    b.vert([-x, y, h]),
  ] as const;
  b.flatFace([v[0], v[3], v[2], v[1]]); // bottom
  b.flatFace([v[4], v[5], v[6], v[7]]); // top
  b.flatFace([v[0], v[1], v[5], v[4]]); // front (-Y)
  b.flatFace([v[1], v[2], v[6], v[5]]); // right (+X)
  b.flatFace([v[2], v[3], v[7], v[6]]); // back (+Y)
  b.flatFace([v[3], v[0], v[4], v[7]]); // left (-X)
}

function plane(b: Builder, { width: w, depth: d }: PrimitiveParams['plane']): void {
  const x = w / 2;
  const y = d / 2;
  b.flatFace([b.vert([-x, -y, 0]), b.vert([x, -y, 0]), b.vert([x, y, 0]), b.vert([-x, y, 0])]);
}

function cylinder(b: Builder, { radius: r, height: h, sides: n }: PrimitiveParams['cylinder']): void {
  const bottom = ring(n, r, 0).map((p) => b.vert(p));
  const top = ring(n, r, h).map((p) => b.vert(p));
  const side = 2 * r * Math.sin(Math.PI / n);
  b.flatFace([...bottom].reverse());
  b.flatFace(top);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    b.face(
      [bottom[i]!, bottom[j]!, top[j]!, top[i]!],
      [
        [i * side, 0],
        [(i + 1) * side, 0],
        [(i + 1) * side, h],
        [i * side, h],
      ],
    );
  }
}

function cone(b: Builder, { radius: r, height: h, sides: n }: PrimitiveParams['cone']): void {
  const base = ring(n, r, 0).map((p) => b.vert(p));
  const apex = b.vert([0, 0, h]);
  const side = 2 * r * Math.sin(Math.PI / n);
  const slant = Math.hypot(h, r * Math.cos(Math.PI / n));
  b.flatFace([...base].reverse());
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    b.face(
      [base[i]!, base[j]!, apex],
      [
        [i * side, 0],
        [(i + 1) * side, 0],
        [(i + 0.5) * side, slant],
      ],
    );
  }
}

function torus(b: Builder, p: PrimitiveParams['torus']): void {
  const { majorRadius: R, minorRadius: r, segments: m, sides: k } = p;
  const ids: VertId[][] = [];
  for (let i = 0; i < m; i++) {
    const phi = -Math.PI / 2 + (2 * Math.PI * i) / m;
    const row: VertId[] = [];
    for (let j = 0; j < k; j++) {
      const theta = -Math.PI / 2 + (2 * Math.PI * j) / k; // start at the bottom, so it sits on z = 0
      const d = R + r * Math.cos(theta);
      row.push(b.vert([d * Math.cos(phi), d * Math.sin(phi), r + r * Math.sin(theta)]));
    }
    ids.push(row);
  }
  const du = (2 * Math.PI * R) / m;
  const dv = (2 * Math.PI * r) / k;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < k; j++) {
      const i1 = (i + 1) % m;
      const j1 = (j + 1) % k;
      b.face(
        [ids[i]![j]!, ids[i1]![j]!, ids[i1]![j1]!, ids[i]![j1]!],
        [
          [i * du, j * dv],
          [(i + 1) * du, j * dv],
          [(i + 1) * du, (j + 1) * dv],
          [i * du, (j + 1) * dv],
        ],
      );
    }
  }
}

function rotateX(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

function sphere(b: Builder, { radius: r, subdivisions }: PrimitiveParams['sphere']): void {
  const t = (1 + Math.sqrt(5)) / 2;
  let points: Vec3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((p) => normalize(rotateX(p as Vec3, Math.atan2(1, t))));
  // ^ rotated so vertices 5 and 6 sit exactly on the +Z / -Z poles.
  // prettier-ignore
  let tris: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map<string, number>();
    const mid = (a: number, c: number): number => {
      const key = a < c ? `${a},${c}` : `${c},${a}`;
      let idx = cache.get(key);
      if (idx === undefined) {
        idx = points.length;
        points.push(normalize(scale(add(points[a]!, points[c]!), 0.5)));
        cache.set(key, idx);
      }
      return idx;
    };
    const next: typeof tris = [];
    for (const [a, c, d] of tris) {
      const ab = mid(a, c);
      const bc = mid(c, d);
      const ca = mid(d, a);
      next.push([a, ab, ca], [c, bc, ab], [d, ca, bc], [ab, bc, ca]);
    }
    tris = next;
  }

  const center: Vec3 = [0, 0, r];
  const ids = points.map((p) => b.vert(add(scale(p, r), center)));
  const circumference = 2 * Math.PI * r;

  for (let tri of tris) {
    // Make sure the face points outward.
    const ps = tri.map((i) => points[i]!);
    if (dot(newellNormal(ps), add(add(ps[0]!, ps[1]!), ps[2]!)) < 0) tri = [tri[0], tri[2], tri[1]];

    // Spherical UVs in world units: u around the equator, v from the south pole up.
    const uvs = tri.map((i) => {
      const p = points[i]!;
      const u = ((Math.atan2(p[1], p[0]) + Math.PI) / (2 * Math.PI)) * circumference;
      const v = Math.acos(Math.max(-1, Math.min(1, -p[2]))) * r;
      return [u, v] as Vec2;
    });
    // Fix the seam: keep the triangle's u values within half a turn of each other.
    const us = uvs.map((uv) => uv[0]);
    if (Math.max(...us) - Math.min(...us) > circumference / 2) {
      for (const uv of uvs) if (uv[0] < circumference / 2) uv[0] += circumference;
    }
    // Pole corners have no meaningful u: use the average of the others.
    tri.forEach((i, k) => {
      const p = points[i]!;
      if (length([p[0], p[1], 0]) < 1e-9) {
        const others = uvs.filter((_, o) => o !== k);
        uvs[k]![0] = (others[0]![0] + others[1]![0]) / 2;
      }
    });

    b.face(
      tri.map((i) => ids[i]!),
      uvs,
    );
  }
}
