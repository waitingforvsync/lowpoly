import { activeTool, selectionMode, snapEnabled, snapInvertHeld, xray, type SelectionMode } from './state';
import { TOOLS } from './tools';
import { frameSelection, setStandardView, toggleProjection } from './viewActions';
import { deleteSelection, duplicateSelection, invertSelection, selectAll, selectNone } from './actions';
import {
  deleteComponents,
  dissolveComponents,
  invertComponents,
  mergeComponentsAtCenter,
  mergeComponentsByDistance,
  selectAllComponents,
} from './componentActions';
import { editor } from './editor';
import { isComponentMode, setSelectionMode } from './modes';
import { clearComponents } from './selection';
import { connectSelection, makeFaceFromSelection } from './modelActions';
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

/** Run the component-mode action if in a component mode, else the object-mode one. */
function byMode(objectAction: (() => void) | null, componentAction: (mode: 'vertex' | 'edge' | 'face') => void) {
  return () => {
    const mode = selectionMode.value;
    if (isComponentMode(mode)) componentAction(mode);
    else objectAction?.();
  };
}

/** Ctrl/Cmd shortcuts, keyed by `[shift ? 'S+' : ''] + code`. */
const CTRL_SHORTCUTS: Record<string, () => void> = {
  KeyZ: () => editor.undo(),
  'S+KeyZ': () => editor.redo(),
  KeyY: () => editor.redo(),
  KeyD: byMode(duplicateSelection, () => {}),
  KeyA: byMode(selectAll, selectAllComponents),
  'S+KeyA': byMode(selectNone, (m) => clearComponents(m)),
  KeyI: byMode(invertSelection, invertComponents),
  KeyM: byMode(null, mergeComponentsAtCenter),
  'S+KeyM': byMode(null, mergeComponentsByDistance),
  KeyS: () => void saveDocument(),
  'S+KeyS': () => void saveDocument(true),
  KeyO: () => void openDocument(),
  KeyF: byMode(null, makeFaceFromSelection),
};

/** Plain-key shortcuts (no modifiers). */
const PLAIN_SHORTCUTS: Record<string, () => void> = {
  Numpad5: toggleProjection,
  KeyG: () => (snapEnabled.value = !snapEnabled.value),
  KeyX: () => (xray.value = !xray.value),
  KeyF: frameSelection,
  Escape: byMode(selectNone, (m) => clearComponents(m)),
  Delete: byMode(deleteSelection, deleteComponents),
  Backspace: byMode(deleteSelection, dissolveComponents),
  KeyJ: byMode(null, connectSelection),
};

const REPEATABLE = new Set(['KeyZ', 'KeyY']);

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Control') snapInvertHeld.value = true;
  if (isTextEntry(e.target)) return;
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && !e.altKey) {
    const action = CTRL_SHORTCUTS[(e.shiftKey ? 'S+' : '') + e.code];
    if (action) {
      e.preventDefault();
      if (!e.repeat || REPEATABLE.has(e.code)) action();
    }
    return;
  }
  if (ctrl || e.altKey || e.shiftKey) return;

  const plain = PLAIN_SHORTCUTS[e.code];
  if (plain) {
    e.preventDefault();
    if (!e.repeat) plain();
    return;
  }

  const mode = MODE_KEYS[e.code];
  if (mode) {
    setSelectionMode(mode);
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
