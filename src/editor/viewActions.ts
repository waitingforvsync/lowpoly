import type { StandardView, Viewport } from '../render/Viewport';
import type { Vec3 } from '../core/math/vec';
import { selectedIds } from './actions';
import { projection } from './state';

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

/** Frame the selection, or everything when nothing is selected. */
export function frameSelection(): void {
  viewport?.frameObjects(selectedIds());
}

/** Where new objects should appear. */
export function spawnPoint(): Vec3 {
  return viewport?.spawnPoint() ?? [0, 0, 0];
}
