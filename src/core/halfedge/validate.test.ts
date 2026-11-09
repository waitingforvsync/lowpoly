import { describe, expect, it } from 'vitest';
import { cubeData, squareWithHoleData } from '../testing/fixtures';
import { fromMeshData } from './convert';
import { assertValid, validate } from './validate';

describe('validate', () => {
  it('accepts valid meshes', () => {
    expect(validate(fromMeshData(cubeData()))).toEqual([]);
    expect(() => assertValid(fromMeshData(squareWithHoleData()))).not.toThrow();
  });

  it('detects broken twin pointers', () => {
    const m = fromMeshData(cubeData());
    const [e1, e2] = [...m.edges()];
    e1!.he.twin = e2!.he;
    expect(validate(m).join('\n')).toMatch(/twin/);
  });

  it('detects broken next/prev links', () => {
    const m = fromMeshData(cubeData());
    const h = m.face(0).outer.he;
    h.next!.prev = h.prev;
    expect(validate(m).join('\n')).toMatch(/next\/prev mismatch/);
  });

  it('detects a loop that is not continuous', () => {
    const m = fromMeshData(cubeData());
    const h = m.face(0).outer.he;
    h.next = h.next!.next;
    expect(validate(m).length).toBeGreaterThan(0);
  });

  it('detects a missing out-list entry', () => {
    const m = fromMeshData(cubeData());
    m.vertex(0).out.pop();
    expect(validate(m).join('\n')).toMatch(/out list/);
  });

  it('detects a hole wound the same way as the outer loop', () => {
    const data = squareWithHoleData();
    data.faces[0]!.loops[1]!.reverse();
    const m = fromMeshData(data);
    expect(validate(m).join('\n')).toMatch(/hole winds/);
  });

  it('detects stale id counters', () => {
    const m = fromMeshData(cubeData());
    m.nextVertId = 3;
    expect(validate(m).join('\n')).toMatch(/nextVertId/);
    expect(() => assertValid(m)).toThrow(/Invalid mesh/);
  });
});
