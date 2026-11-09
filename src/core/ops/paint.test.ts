import { describe, expect, it } from 'vitest';
import { fromMeshData } from '../halfedge/convert';
import { cubeData } from '../testing/fixtures';
import { paintTargets } from './paint';

describe('paintTargets', () => {
  const mesh = () => {
    const data = cubeData();
    // Top and front use material 1; the back (not touching the front) too.
    for (const f of data.faces) if (f.id === 1 || f.id === 2 || f.id === 3) f.material = 1;
    return fromMeshData(data);
  };

  it('face: just the clicked face', () => {
    const m = mesh();
    expect(paintTargets(m.faces.values(), m.face(2), 'face')).toEqual([2]);
  });

  it('connected: flood fill through edges over the same material', () => {
    const m = mesh();
    // front (2) → top (1) → back (3), all material 1 and edge-connected
    expect(paintTargets(m.faces.values(), m.face(2), 'connected').sort()).toEqual([1, 2, 3]);
    m.face(1).material = 0;
    expect(paintTargets(m.faces.values(), m.face(2), 'connected')).toEqual([2]);
  });

  it('same: every face with the material', () => {
    const m = mesh();
    m.face(1).material = 0;
    expect(paintTargets(m.faces.values(), m.face(2), 'same').sort()).toEqual([2, 3]);
  });
});
