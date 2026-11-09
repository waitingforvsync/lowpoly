import * as THREE from 'three';
import type { Transform } from '../core/document';

const DEG = Math.PI / 180;

export function applyTransform(obj: THREE.Object3D, t: Transform): void {
  obj.position.set(t.position[0], t.position[1], t.position[2]);
  obj.rotation.set(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'XYZ');
  obj.scale.set(t.scale[0], t.scale[1], t.scale[2]);
}

export function transformToMatrix(t: Transform, out = new THREE.Matrix4()): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'XYZ'),
  );
  return out.compose(new THREE.Vector3(...t.position), q, new THREE.Vector3(...t.scale));
}

/** Decompose a matrix into a Transform, rounding away floating-point noise. */
export function matrixToTransform(m: THREE.Matrix4): Transform {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  m.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return {
    position: [round(p.x, 1e6), round(p.y, 1e6), round(p.z, 1e6)],
    rotation: [round(e.x / DEG, 1e4), round(e.y / DEG, 1e4), round(e.z / DEG, 1e4)],
    scale: [round(s.x, 1e6), round(s.y, 1e6), round(s.z, 1e6)],
  };
}

function round(x: number, k: number): number {
  return Math.round(x * k) / k + 0;
}
