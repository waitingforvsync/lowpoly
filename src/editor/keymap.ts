import { activeTool, selectionMode, snapEnabled, snapInvertHeld, type SelectionMode } from './state';
import { TOOLS } from './tools';
import { frameSelection, setStandardView, toggleProjection } from './viewActions';
import { deleteSelection, duplicateSelection, invertSelection, selectAll, selectNone } from './actions';
import { editor } from './editor';
import { openDocument, saveDocument } from '../io/file';
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

/** Ctrl/Cmd shortcuts, keyed by `[shift ? 'S+' : ''] + code`. */
const CTRL_SHORTCUTS: Record<string, () => void> = {
  KeyZ: () => editor.undo(),
  'S+KeyZ': () => editor.redo(),
  KeyY: () => editor.redo(),
  KeyD: duplicateSelection,
  KeyA: selectAll,
  'S+KeyA': selectNone,
  KeyI: invertSelection,
  KeyS: () => void saveDocument(),
  'S+KeyS': () => void saveDocument(true),
  KeyO: () => void openDocument(),
};

/** Plain-key shortcuts (no modifiers). */
const PLAIN_SHORTCUTS: Record<string, () => void> = {
  Numpad5: toggleProjection,
  KeyG: () => (snapEnabled.value = !snapEnabled.value),
  KeyF: frameSelection,
  Escape: selectNone,
  Delete: deleteSelection,
  Backspace: deleteSelection,
};

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Control') snapInvertHeld.value = true;
  if (isTextEntry(e.target)) return;
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && !e.altKey) {
    const action = CTRL_SHORTCUTS[(e.shiftKey ? 'S+' : '') + e.code];
    if (action) {
      e.preventDefault();
      if (!e.repeat || e.code === 'KeyZ' || e.code === 'KeyY') action();
    }
    return;
  }
  if (ctrl || e.altKey || e.shiftKey) return;

  const plain = PLAIN_SHORTCUTS[e.code];
  if (plain) {
    e.preventDefault();
    plain();
    return;
  }

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

  const tool = TOOLS.find((t) => t.code === e.code);
  if (tool) {
    activeTool.value = tool.id;
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === 'Control') snapInvertHeld.value = false;
}

function onBlur(): void {
  snapInvertHeld.value = false;
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (editor.isDirty) e.preventDefault();
}

export function installKeymap(): () => void {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('beforeunload', onBeforeUnload);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('beforeunload', onBeforeUnload);
  };
}

