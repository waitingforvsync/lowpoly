import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Transform } from '../core/document';
import { transformToMatrix } from '../render/transformMath';
import { inverseTransformPoint, transformPoint } from './transformPoints';

describe('transformPoint', () => {
  const t: Transform = { position: [1, 2, 3], rotation: [30, -45, 60], scale: [2, 0.5, 1.5] };

  it('matches Three.js', () => {
    const m = transformToMatrix(t);
    const p = new THREE.Vector3(0.3, -1.2, 2).applyMatrix4(m);
    const q = transformPoint(t, [0.3, -1.2, 2]);
    expect(q[0]).toBeCloseTo(p.x);
    expect(q[1]).toBeCloseTo(p.y);
    expect(q[2]).toBeCloseTo(p.z);
  });

  it('inverts', () => {
    const back = inverseTransformPoint(t, transformPoint(t, [0.3, -1.2, 2]));
    expect(back[0]).toBeCloseTo(0.3);
    expect(back[1]).toBeCloseTo(-1.2);
    expect(back[2]).toBeCloseTo(2);
  });
});
