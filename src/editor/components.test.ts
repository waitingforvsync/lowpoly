import { describe, expect, it } from 'vitest';
import { Document, SceneObject } from '../core/document';
import { fromMeshData } from '../core/halfedge/convert';
import { cubeData } from '../core/testing/fixtures';
import { allKeys, convertSelection, verticesOf } from './components';
import type { ComponentSet } from './selection';

function doc() {
  const d = new Document();
  d.insertObject(new SceneObject(0, 'Cube', fromMeshData(cubeData())));
  return d;
}

const sel = (keys: (number | string)[]): ComponentSet => new Map([[0, new Set(keys)]]);
const keys = (s: ComponentSet) => [...(s.get(0) ?? [])].sort();

describe('convertSelection', () => {
  it('faces → vertices and edges take everything touched', () => {
    const d = doc();
    expect(keys(convertSelection(d, sel([1]), 'face', 'vertex'))).toEqual([4, 5, 6, 7]);
    expect(keys(convertSelection(d, sel([1]), 'face', 'edge'))).toEqual(['4,5', '4,7', '5,6', '6,7']);
  });

  it('vertices → edges/faces take only fully selected elements', () => {
    const d = doc();
    expect(keys(convertSelection(d, sel([4, 5, 6]), 'vertex', 'edge'))).toEqual(['4,5', '5,6']);
    expect(keys(convertSelection(d, sel([4, 5, 6]), 'vertex', 'face'))).toEqual([]);
    expect(keys(convertSelection(d, sel([4, 5, 6, 7]), 'vertex', 'face'))).toEqual([1]);
  });

  it('edges → faces needs every edge', () => {
    const d = doc();
    expect(keys(convertSelection(d, sel(['4,5', '5,6', '6,7', '4,7']), 'edge', 'face'))).toEqual([1]);
    expect(keys(convertSelection(d, sel(['4,5', '5,6', '6,7']), 'edge', 'face'))).toEqual([]);
  });

  it('drops objects with nothing left', () => {
    const d = doc();
    expect(convertSelection(d, sel([0]), 'vertex', 'face').size).toBe(0);
  });
});

describe('helpers', () => {
  it('verticesOf and allKeys', () => {
    const m = doc().object(0).mesh;
    expect(verticesOf(m, 'edge', ['0,1', '1,2']).map((v) => v.id).sort()).toEqual([0, 1, 2]);
    expect(allKeys(m, 'edge')).toHaveLength(12);
    expect(allKeys(m, 'face')).toHaveLength(6);
  });
});
