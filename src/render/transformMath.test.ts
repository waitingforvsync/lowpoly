import { describe, expect, it } from 'vitest';
import type { Transform } from '../core/document';
import { matrixToTransform, transformToMatrix } from './transformMath';

describe('transform <-> matrix', () => {
  it('round-trips', () => {
    const t: Transform = { position: [1, -2, 3.5], rotation: [10, 20, 30], scale: [1, 2, 0.5] };
    expect(matrixToTransform(transformToMatrix(t))).toEqual(t);
  });

  it('rounds away floating-point noise', () => {
    const t: Transform = { position: [0.1, 0.2, 0.3], rotation: [0, 0, 90], scale: [1, 1, 1] };
    const back = matrixToTransform(transformToMatrix(t));
    expect(back.position).toEqual([0.1, 0.2, 0.3]);
    expect(back.rotation).toEqual([0, 0, 90]);
  });
});
