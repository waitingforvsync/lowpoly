import * as THREE from 'three';
import type { Document, SceneObject, TextureId } from '../core/document';
import { buildMeshBuffers } from '../render/meshBuffers';
import { transformToMatrix } from '../render/transformMath';
import { dataURLBytes, tileSize } from './obj';

/**
 * Binary glTF (GLB) export. One node per object, keeping its transform; meshes are triangulated,
 * with normals (smoothed across soft edges) and UVs in texture repeats. glTF is Y-up, so geometry
 * is rotated by C = −90° about X and node transforms become C·M·C⁻¹. glTF's image origin is the
 * top-left, so V is flipped. Materials are unlit-looking PBR: no metal, full roughness, base colour
 * (converted from sRGB to linear) or base-colour texture. Images must be PNG or JPEG; others are
 * supplied converted by the caller (`images`) or left out.
 */

export interface GlbImage {
  mime: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
}

const C = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
const C_INV = C.clone().invert();

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** PNG/JPEG textures straight from the document; others need converting first. */
export function documentImages(doc: Document): Map<TextureId, GlbImage> {
  const out = new Map<TextureId, GlbImage>();
  for (const t of doc.textures) {
    if (t.mime === 'image/png' || t.mime === 'image/jpeg') out.set(t.id, { mime: t.mime, bytes: dataURLBytes(t.data) });
  }
  return out;
}

export function exportGLB(doc: Document, objects: readonly SceneObject[], images = documentImages(doc)): Uint8Array {
  const chunks: Uint8Array[] = [];
  let binLength = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];

  const addView = (bytes: Uint8Array, target?: number): number => {
    const pad = (4 - (binLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      binLength += pad;
    }
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.length, ...(target ? { target } : {}) });
    binLength += bytes.length;
    return bufferViews.length - 1;
  };
  const addAccessor = (data: Float32Array, type: 'VEC2' | 'VEC3', minMax = false): number => {
    const view = addView(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 34962);
    const n = type === 'VEC2' ? 2 : 3;
    const acc: Record<string, unknown> = { bufferView: view, componentType: 5126, count: data.length / n, type };
    if (minMax) {
      const min = Array(n).fill(Infinity);
      const max = Array(n).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        min[i % n] = Math.min(min[i % n], data[i]!);
        max[i % n] = Math.max(max[i % n], data[i]!);
      }
      acc.min = min;
      acc.max = max;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  // Materials, textures and images, created on first use.
  const materials: object[] = [];
  const materialIndex = new Map<number, number>();
  const textures: object[] = [];
  const textureIndex = new Map<TextureId, number>();
  const gltfImages: object[] = [];
  const samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  const textureFor = (id: TextureId): number | null => {
    if (textureIndex.has(id)) return textureIndex.get(id)!;
    const img = images.get(id);
    if (!img) return null;
    const tex = doc.findTexture(id);
    gltfImages.push({ name: tex?.name ?? `texture${id}`, mimeType: img.mime, bufferView: addView(img.bytes) });
    textures.push({ sampler: 0, source: gltfImages.length - 1 });
    textureIndex.set(id, textures.length - 1);
    return textures.length - 1;
  };
  const materialFor = (id: number): number => {
    if (materialIndex.has(id)) return materialIndex.get(id)!;
    const m = doc.findMaterial(id);
    const tex = m?.texture != null ? textureFor(m.texture) : null;
    const color = m?.color ?? [0.8, 0.8, 0.8];
    materials.push({
      name: m?.name ?? 'Default',
      pbrMetallicRoughness: {
        baseColorFactor: tex !== null ? [1, 1, 1, 1] : [...color.map(srgbToLinear), 1],
        ...(tex !== null ? { baseColorTexture: { index: tex } } : {}),
        metallicFactor: 0,
        roughnessFactor: 1,
      },
    });
    materialIndex.set(id, materials.length - 1);
    return materials.length - 1;
  };

  const nodes: object[] = [];
  const meshes: object[] = [];
  for (const obj of objects) {
    const b = buildMeshBuffers(obj.mesh);
    const primitives: object[] = [];
    for (const g of b.groups) {
      const pos = new Float32Array(g.count * 3);
      const nor = new Float32Array(g.count * 3);
      const uv = new Float32Array(g.count * 2);
      const [sx, sy] = tileSize(doc.findMaterial(g.material));
      for (let i = 0; i < g.count; i++) {
        const k = g.start + i;
        // C: (x, y, z) → (x, z, −y)
        pos.set([b.positions[k * 3]!, b.positions[k * 3 + 2]!, -b.positions[k * 3 + 1]!], i * 3);
        nor.set([b.normals[k * 3]!, b.normals[k * 3 + 2]!, -b.normals[k * 3 + 1]!], i * 3);
        uv.set([b.uvs[k * 2]! / sx, 1 - b.uvs[k * 2 + 1]! / sy], i * 2);
      }
      primitives.push({
        attributes: { POSITION: addAccessor(pos, 'VEC3', true), NORMAL: addAccessor(nor, 'VEC3'), TEXCOORD_0: addAccessor(uv, 'VEC2') },
        material: materialFor(g.material),
        mode: 4,
      });
    }
    if (!primitives.length) continue;
    meshes.push({ name: obj.name, primitives });
    const m = C.clone().multiply(transformToMatrix(obj.transform)).multiply(C_INV);
    const t = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    m.decompose(t, q, s);
    const clean = (xs: number[]) => xs.map((x) => Math.round(x * 1e7) / 1e7 + 0);
    nodes.push({ name: obj.name, mesh: meshes.length - 1, translation: clean(t.toArray()), rotation: clean(q.toArray()), scale: clean(s.toArray()) });
  }

  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'Lowpoly' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };
  if (textures.length) Object.assign(json, { textures, images: gltfImages, samplers });

  return glb(JSON.stringify(json), chunks, binLength);
}

function glb(json: string, chunks: Uint8Array[], binLength: number): Uint8Array {
  const jsonBytes = new TextEncoder().encode(json);
  const jsonLen = Math.ceil(jsonBytes.length / 4) * 4;
  const binLen = Math.ceil(binLength / 4) * 4;
  const total = 12 + 8 + jsonLen + (binLength ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); // 'glTF'
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jsonLen, true);
  v.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen); // pad JSON with spaces
  if (binLength) {
    const at = 20 + jsonLen;
    v.setUint32(at, binLen, true);
    v.setUint32(at + 4, 0x004e4942, true); // 'BIN'
    let p = at + 8;
    for (const c of chunks) {
      out.set(c, p);
      p += c.length;
    }
  }
  return out;
}
