import { describe, expect, it } from 'vitest';
import { fromMeshData, toMeshData } from './halfedge/convert';
import { validate } from './halfedge/validate';
import { dot, sub, type Vec3 } from './math/vec';
import {
  buildPrimitive,
  defaultSource,
  PRIMITIVE_TYPES,
  PRIMITIVES,
  sanitizeSource,
  type PrimitiveSource,
} from './primitives';

function centroid(ps: Vec3[]): Vec3 {
  const n = ps.length;
  return ps.reduce<Vec3>((c, p) => [c[0] + p[0] / n, c[1] + p[1] / n, c[2] + p[2] / n], [0, 0, 0]);
}

describe.each(PRIMITIVE_TYPES)('%s primitive', (type) => {
  const data = buildPrimitive(defaultSource(type));
  const mesh = fromMeshData(data);

  it('is a valid mesh', () => {
    expect(validate(mesh)).toEqual([]);
    expect(toMeshData(mesh)).toEqual(data);
  });

  it('sits on the ground', () => {
    const minZ = Math.min(...[...mesh.verts.values()].map((v) => v.pos[2]));
    expect(minZ).toBeCloseTo(0);
  });

  it('has finite UVs on every corner', () => {
    for (const f of mesh.faces.values()) for (const h of f.halfEdges()) expect(h.uv.every(Number.isFinite)).toBe(true);
  });

  if (type !== 'plane') {
    it('is closed', () => {
      for (const e of mesh.edges()) expect(e.faces()).toHaveLength(2);
    });

    it('has outward-facing faces', () => {
      // Every primitive except the torus is convex around its bounding-box centre. For the torus,
      // compare against the nearest point on the tube's centre circle instead.
      const all = [...mesh.verts.values()].map((v) => v.pos);
      const c = centroid(all);
      for (const f of mesh.faces.values()) {
        const fc = centroid(f.outer.positions());
        let ref = c;
        if (type === 'torus') {
          const R = PRIMITIVES.torus.defaults.majorRadius;
          const len = Math.hypot(fc[0], fc[1]);
          ref = [(fc[0] / len) * R, (fc[1] / len) * R, c[2]];
        }
        expect(dot(f.normal(), sub(fc, ref))).toBeGreaterThan(0);
      }
    });
  }
});

describe('primitive topology', () => {
  const counts = (src: PrimitiveSource) => {
    const m = fromMeshData(buildPrimitive(src));
    return [m.verts.size, m.edgeCount, m.faces.size];
  };

  it('box', () => expect(counts(defaultSource('box'))).toEqual([8, 12, 6]));
  it('cylinder', () => expect(counts({ type: 'cylinder', params: { radius: 1, height: 1, sides: 6 } })).toEqual([12, 18, 8]));
  it('cone', () => expect(counts({ type: 'cone', params: { radius: 1, height: 1, sides: 5 } })).toEqual([6, 10, 6]));
  it('sphere', () => {
    expect(counts({ type: 'sphere', params: { radius: 1, subdivisions: 0 } })).toEqual([12, 30, 20]);
    expect(counts({ type: 'sphere', params: { radius: 1, subdivisions: 2 } })).toEqual([162, 480, 320]);
  });
  it('torus has Euler characteristic 0', () => {
    const [v, e, f] = counts({ type: 'torus', params: { majorRadius: 1, minorRadius: 0.3, segments: 8, sides: 4 } });
    expect([v, e, f]).toEqual([32, 64, 32]);
    expect(v! - e! + f!).toBe(0);
  });
});

describe('primitive UVs', () => {
  it('box UVs are planar in world units', () => {
    const m = fromMeshData(buildPrimitive({ type: 'box', params: { width: 2, depth: 1, height: 3 } }));
    // Front face (normal -Y): u runs along +X, v along +Z.
    const front = [...m.faces.values()].find((f) => f.normal()[1] < -0.9)!;
    for (const h of front.halfEdges()) {
      expect(h.uv[0]).toBeCloseTo(h.origin.pos[0]);
      expect(h.uv[1]).toBeCloseTo(h.origin.pos[2]);
    }
  });

  it('cylinder side UVs wrap with a seam instead of running backwards', () => {
    const m = fromMeshData(buildPrimitive({ type: 'cylinder', params: { radius: 1, height: 1, sides: 4 } }));
    const sides = [...m.faces.values()].filter((f) => Math.abs(f.normal()[2]) < 0.1);
    for (const f of sides) {
      const us = Array.from(f.halfEdges(), (h) => h.uv[0]);
      expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(Math.SQRT2); // one side width
    }
  });
});

describe('sanitizeSource', () => {
  it('clamps and rounds parameters', () => {
    const s = sanitizeSource({ type: 'cylinder', params: { radius: -1, height: Number.NaN, sides: 3.6 } });
    expect(s).toEqual({ type: 'cylinder', params: { radius: 0.001, height: 1, sides: 4 } });
  });
});
