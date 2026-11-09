import type { StandardView, Viewport } from '../render/Viewport';
import type { Vec3 } from '../core/math/vec';
import { selectedIds } from './actions';
import { verticesOf } from './components';
import { editor } from './editor';
import { isComponentMode } from './modes';
import { componentSelection, editObjects } from './selection';
import { projection, selectionMode } from './state';
import { transformPoint } from './transformPoints';

/** Bridges UI/keyboard actions to the (single) live viewport. */
let viewport: Viewport | null = null;

export function attachViewport(vp: Viewport | null): void {
  viewport = vp;
}

export function setStandardView(view: StandardView): void {
  viewport?.setStandardView(view);
}

export function toggleProjection(): void {
  projection.value = projection.value === 'perspective' ? 'orthographic' : 'perspective';
}

/**
 * Frame the selection. In component modes: the selected components, else the objects being
 * edited. In object mode: the selected objects, else everything.
 */
export function frameSelection(): void {
  if (!viewport) return;
  const mode = selectionMode.value;
  if (isComponentMode(mode)) {
    const doc = editor.doc;
    const points: Vec3[] = [];
    for (const [id, keys] of componentSelection[mode].value) {
      const obj = doc.findObject(id);
      if (obj) for (const v of verticesOf(obj.mesh, mode, keys)) points.push(transformPoint(obj.transform, v.pos));
    }
    if (points.length) viewport.framePoints(points);
    else viewport.frameObjects([...editObjects.value]);
    return;
  }
  viewport.frameObjects(selectedIds());
}

/** Where new objects should appear. */
export function spawnPoint(): Vec3 {
  return viewport?.spawnPoint() ?? [0, 0, 0];
}
