import type { StandardView, Viewport } from '../render/Viewport';
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
