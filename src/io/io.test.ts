import { describe, expect, it } from 'vitest';
import { Document, SceneObject } from '../core/document';
import { fromMeshData } from '../core/halfedge/convert';
import { validate } from '../core/halfedge/validate';
import { buildPrimitive, defaultSource } from '../core/primitives';
import { cubeData, squareWithHoleData } from '../core/testing/fixtures';
import { exportGLB } from './gltf';
import { exportOBJ, parseMTL, parseOBJ } from './obj';
import { crc32, zip } from './zip';

const text = (d: string | Uint8Array) => (typeof d === 'string' ? d : new TextDecoder().decode(d));
const lines = (s: string, key: string) => s.split('\n').filter((l) => l.startsWith(`${key} `));

function docWith(...objs: SceneObject[]): Document {
  const doc = new Document();
  for (const o of objs) doc.insertObject(o);
  return doc;
}

describe('OBJ export', () => {
  it('writes world-space, Y-up geometry with UVs, normals and materials', () => {
    const doc = docWith(new SceneObject(0, 'My Cube', fromMeshData(cubeData()), { position: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }));
    const [obj, mtl] = exportOBJ(doc, doc.objects, 'scene');
    expect(obj!.name).toBe('scene.obj');
    const s = text(obj!.data);
    expect(s).toContain('mtllib scene.mtl');
    expect(s).toContain('o My_Cube');
    expect(lines(s, 'v')).toHaveLength(8);
    expect(lines(s, 'f')).toHaveLength(6);
    // Z-up (10, 0, 1) is Y-up (10, 1, -0).
    expect(lines(s, 'v')).toContain('v 11 1 0');
    expect(lines(s, 'vn')).toHaveLength(6); // flat: one normal per side
    expect(text(mtl!.data)).toContain('newmtl Default');
  });

  it('divides UVs by the tile size and exports textures', () => {
    const doc = docWith(new SceneObject(0, 'Q', fromMeshData(cubeData())));
    doc.insertTexture({ id: 0, name: 'bricks.png', mime: 'image/png', data: 'data:image/png;base64,AAEC', width: 1, height: 1 });
    doc.insertMaterial({ id: 1, name: 'Brick wall', color: [1, 0, 0], texture: 0, textureSize: [0.5, 2] });
    for (const f of doc.objects[0]!.mesh.faces.values()) f.material = 1;
    const files = exportOBJ(doc, doc.objects, 'x');
    const s = text(files[0]!.data);
    // The fixture's corner UVs (1, 1) become (2, 0.5) repeats.
    expect(lines(s, 'vt')).toContain('vt 2 0.5');
    expect(text(files[1]!.data)).toContain('newmtl Brick_wall');
    expect(text(files[1]!.data)).toContain('map_Kd bricks.png');
    expect(files[2]).toEqual({ name: 'bricks.png', data: new Uint8Array([0, 1, 2]) });
  });

  it('triangulates faces with holes, which OBJ cannot express', () => {
    const doc = docWith(new SceneObject(0, 'Frame', fromMeshData(squareWithHoleData())));
    const s = text(exportOBJ(doc, doc.objects, 'f')[0]!.data);
    expect(lines(s, 'f').every((l) => l.split(' ').length === 4)).toBe(true);
  });
});

describe('OBJ import', () => {
  it('round-trips an exported cylinder: same counts, valid, soft sides', () => {
    const src = fromMeshData(buildPrimitive(defaultSource('cylinder')));
    const doc = docWith(new SceneObject(0, 'Cyl', src));
    const r = parseOBJ(text(exportOBJ(doc, doc.objects, 'c')[0]!.data));
    expect(r.objects).toHaveLength(1);
    const m = fromMeshData(r.objects[0]!.data);
    expect(validate(m)).toEqual([]);
    expect([m.verts.size, m.edgeCount, m.faces.size]).toEqual([src.verts.size, src.edgeCount, src.faces.size]);
    expect([...m.edges()].filter((e) => !e.hard).length).toBe([...src.edges()].filter((e) => !e.hard).length);
  });

  it('converts Y-up to Z-up and puts the origin at the centre of the base', () => {
    const r = parseOBJ(['v 0 0 0', 'v 2 0 0', 'v 2 4 0', 'v 0 4 0', 'f 1 2 3 4'].join('\n'));
    const o = r.objects[0]!;
    expect(o.origin).toEqual([1, 0, 0]);
    const zs = o.data.verts.map((v) => v.p[2]);
    expect(Math.max(...zs)).toBe(4);
    expect(o.data.verts.every((v) => v.p[1] === 0)).toBe(true);
  });

  it('splits non-planar faces, detaches non-manifold ones and skips degenerate ones', () => {
    const r = parseOBJ(
      [
        'o Thing',
        'v 0 0 0',
        'v 1 0 0',
        'v 1 1 0',
        'v 0 1 0.5', // makes the quad non-planar
        'v 0.5 0.5 -1',
        'f 1 2 3 4',
        'f 1 2 5', // reuses edge 1-2 in the same direction: winds against the first face
        'f 1 1 2', // degenerate
        'f -5 -3 -1', // negative indices: 1 3 5
      ].join('\n'),
    );
    const m = fromMeshData(r.objects[0]!.data);
    expect(validate(m)).toEqual([]);
    expect(m.faces.size).toBe(4); // 2 triangles from the quad + 2 triangles
    expect(r.warnings.join(';')).toMatch(/triangulated/);
    expect(r.warnings.join(';')).toMatch(/detached/);
    expect(r.warnings.join(';')).toMatch(/degenerate/);
  });

  it('reads objects, groups and material slots', () => {
    const r = parseOBJ(['mtllib a.mtl', 'o A', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'usemtl Red', 'f 1 2 3', 'o B', 'usemtl Blue', 'f 1 3 2'].join('\n'));
    expect(r.objects.map((o) => o.name)).toEqual(['A', 'B']);
    expect(r.slots).toEqual([null, 'Red', 'Blue']);
    expect(r.objects[1]!.data.faces[0]!.material).toBe(2);
    expect(r.mtllibs).toEqual(['a.mtl']);
  });

  it('parses MTL colours and textures', () => {
    const mats = parseMTL('newmtl Red\nKd 1 0 0\nmap_Kd -s 2 2 1 tex/red.png\nnewmtl Plain\n');
    expect(mats).toEqual([
      { name: 'Red', color: [1, 0, 0], texture: 'tex/red.png' },
      { name: 'Plain', color: [0.8, 0.8, 0.8] },
    ]);
  });
});

describe('GLB export', () => {
  function parse(bytes: Uint8Array) {
    const v = new DataView(bytes.buffer, bytes.byteOffset);
    expect(v.getUint32(0, true)).toBe(0x46546c67);
    expect(v.getUint32(8, true)).toBe(bytes.length);
    const jsonLen = v.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  }

  it('writes one node per object with a Y-up transform and triangulated primitives', () => {
    const doc = docWith(new SceneObject(0, 'Box', fromMeshData(cubeData()), { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] }));
    const bytes = exportGLB(doc, doc.objects);
    expect(bytes.length % 4).toBe(0);
    const j = parse(bytes);
    expect(j.nodes).toHaveLength(1);
    // Z-up (1, 2, 3) → Y-up (1, 3, -2).
    expect(j.nodes[0].translation).toEqual([1, 3, -2]);
    const prim = j.meshes[0].primitives[0];
    expect(j.accessors[prim.attributes.POSITION].count).toBe(36);
    // Positions are rotated too: the cube's z in [0, 1] becomes y in [0, 1].
    expect(j.accessors[prim.attributes.POSITION].min).toEqual([0, 0, -1]);
    expect(j.accessors[prim.attributes.POSITION].max).toEqual([1, 1, 0]);
    expect(j.materials[0].pbrMetallicRoughness.metallicFactor).toBe(0);
  });

  it('embeds PNG textures', () => {
    const doc = docWith(new SceneObject(0, 'Q', fromMeshData(cubeData())));
    doc.insertTexture({ id: 0, name: 't.png', mime: 'image/png', data: 'data:image/png;base64,AAEC', width: 1, height: 1 });
    doc.insertMaterial({ id: 1, name: 'T', color: [1, 1, 1], texture: 0 });
    for (const f of doc.objects[0]!.mesh.faces.values()) f.material = 1;
    const j = parse(exportGLB(doc, doc.objects));
    expect(j.images).toHaveLength(1);
    expect(j.images[0].mimeType).toBe('image/png');
    expect(j.materials[0].pbrMetallicRoughness.baseColorTexture).toEqual({ index: 0 });
  });
});

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('lays out local headers, a central directory and its end record', () => {
    const z = zip([
      { name: 'a.txt', data: 'hello' },
      { name: 'b.bin', data: new Uint8Array([1, 2, 3]) },
    ]);
    const v = new DataView(z.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    const end = z.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    const cdOffset = v.getUint32(end + 16, true);
    expect(v.getUint32(cdOffset, true)).toBe(0x02014b50);
    expect(new TextDecoder().decode(z.subarray(30, 35))).toBe('a.txt');
    expect(new TextDecoder().decode(z.subarray(35, 40))).toBe('hello');
  });
});
