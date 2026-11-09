import { batch } from '@preact/signals';
import { editor } from './editor';
import { convertSelection, elementExists } from './components';
import {
  COMPONENT_MODES,
  componentSelection,
  editObjects,
  type ComponentMode,
  selectedObjects,
  setComponents,
  setSelection,
} from './selection';
import { selectionMode, type SelectionMode } from './state';

/**
 * Switch selection mode.
 * - Object → component: the selected objects (or every visible, unlocked object if none) become
 *   the edit set. Stored component selections outside it, or stale against the meshes, are dropped.
 * - Component → component: the selection converts (faces → their edges, and so on).
 * - Component → object: the edit set becomes the object selection.
 */
export function setSelectionMode(next: SelectionMode): void {
  const prev = selectionMode.value;
  if (prev === next) return;
  const doc = editor.doc;

  batch(() => {
    if (prev === 'object') {
      const usable = doc.objects.filter((o) => o.visible && !o.locked);
      const chosen = usable.filter((o) => selectedObjects.value.has(o.id));
      const edit = new Set((chosen.length ? chosen : usable).map((o) => o.id));
      editObjects.value = edit;
      for (const m of COMPONENT_MODES) {
        const kept = new Map(
          [...componentSelection[m].value]
            .filter(([id]) => edit.has(id))
            .map(([id, keys]) => [id, new Set([...keys].filter((k) => elementExists(doc.object(id).mesh, m, k)))]),
        );
        setComponents(m, kept);
      }
    }
    if (next === 'object') {
      setSelection(editObjects.value);
    } else if (prev !== 'object') {
      setComponents(next, convertSelection(doc, componentSelection[prev].value, prev, next));
    }
    selectionMode.value = next;
  });
}

export function isComponentMode(mode: SelectionMode): mode is ComponentMode {
  return mode !== 'object';
}
