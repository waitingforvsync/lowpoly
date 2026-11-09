import { activeTool, selectionMode, snapEnabled, type SelectionMode } from './state';
import { TOOLS } from './tools';
import { setStandardView, toggleProjection } from './viewActions';
import type { StandardView } from '../render/Viewport';

const MODE_KEYS: Record<string, SelectionMode> = {
  Digit1: 'object',
  Digit2: 'vertex',
  Digit3: 'edge',
  Digit4: 'face',
};

const VIEW_KEYS: Record<string, StandardView> = {
  Numpad7: 'top',
  Numpad1: 'front',
  Numpad3: 'right',
  Numpad0: 'iso',
};

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

function onKeyDown(e: KeyboardEvent): void {
  if (isTextEntry(e.target)) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl || e.altKey) return; // Ctrl/Alt shortcuts arrive with history and selection (M2+).

  const mode = MODE_KEYS[e.code];
  if (mode) {
    selectionMode.value = mode;
    e.preventDefault();
    return;
  }

  const view = VIEW_KEYS[e.code];
  if (view) {
    setStandardView(view);
    e.preventDefault();
    return;
  }

  if (e.code === 'Numpad5') {
    toggleProjection();
    e.preventDefault();
    return;
  }

  if (e.code === 'KeyG') {
    snapEnabled.value = !snapEnabled.value;
    e.preventDefault();
    return;
  }

  const tool = TOOLS.find((t) => t.code === e.code);
  if (tool) {
    activeTool.value = tool.id;
    e.preventDefault();
  }
}

export function installKeymap(): () => void {
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
