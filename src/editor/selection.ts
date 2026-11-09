import { batch, type Signal, signal } from '@preact/signals';
import type { ObjectId } from '../core/document';

/**
 * Object and component selection. Not part of the document and never an undo entry on its own;
 * the history snapshots it around each command so undo/redo restores a sensible selection.
 */

// --- Objects ----------------------------------------------------------------------------------

export const selectedObjects = signal<ReadonlySet<ObjectId>>(new Set());
/** The most recently selected object. */
export const activeObject = signal<ObjectId | null>(null);

export function setSelection(ids: Iterable<ObjectId>, active?: ObjectId | null): void {
  const set = new Set(ids);
  batch(() => {
    selectedObjects.value = set;
    activeObject.value = active !== undefined && (active === null || set.has(active)) ? active : (lastOf(set) ?? null);
  });
}

export function selectOnly(id: ObjectId): void {
  setSelection([id], id);
}

export function addToSelection(id: ObjectId): void {
  setSelection([...selectedObjects.value, id], id);
}

export function toggleSelection(id: ObjectId): void {
  const set = new Set(selectedObjects.value);
  if (set.has(id)) {
    set.delete(id);
    setSelection(set, activeObject.value === id ? null : activeObject.value);
  } else {
    set.add(id);
    setSelection(set, id);
  }
}

export function clearSelection(): void {
  setSelection([], null);
}

// --- Components -------------------------------------------------------------------------------

export type ComponentMode = 'vertex' | 'edge' | 'face';
export const COMPONENT_MODES: readonly ComponentMode[] = ['vertex', 'edge', 'face'];

/**
 * Element keys: vertex id (number), face id (number) or edge key ("a,b" with a < b, see
 * `edgeKey`). Kept per object, and separately per mode.
 */
export type ElementKey = number | string;
export type ComponentSet = ReadonlyMap<ObjectId, ReadonlySet<ElementKey>>;

export const componentSelection: Record<ComponentMode, Signal<ComponentSet>> = {
  vertex: signal<ComponentSet>(new Map()),
  edge: signal<ComponentSet>(new Map()),
  face: signal<ComponentSet>(new Map()),
};

/** Objects being edited in component modes. Fixed when leaving object mode. */
export const editObjects = signal<ReadonlySet<ObjectId>>(new Set());

export interface ComponentRef {
  objectId: ObjectId;
  key: ElementKey;
}

export type SelectOp = 'replace' | 'add' | 'toggle' | 'remove';

export function componentCount(mode: ComponentMode): number {
  let n = 0;
  for (const s of componentSelection[mode].value.values()) n += s.size;
  return n;
}

export function setComponents(mode: ComponentMode, sel: ComponentSet): void {
  const clean = new Map<ObjectId, ReadonlySet<ElementKey>>();
  for (const [id, set] of sel) if (set.size) clean.set(id, set);
  componentSelection[mode].value = clean;
}

/** Apply a click or box result to the selection. */
export function applyComponents(mode: ComponentMode, refs: ComponentRef[], op: SelectOp): void {
  const next = new Map<ObjectId, Set<ElementKey>>();
  if (op !== 'replace') {
    for (const [id, set] of componentSelection[mode].value) next.set(id, new Set(set));
  }
  for (const { objectId, key } of refs) {
    let set = next.get(objectId);
    if (!set) next.set(objectId, (set = new Set()));
    if (op === 'remove') set.delete(key);
    else if (op === 'toggle' && set.has(key)) set.delete(key);
    else set.add(key);
  }
  setComponents(mode, next);
}

export function clearComponents(mode?: ComponentMode): void {
  batch(() => {
    for (const m of mode ? [mode] : COMPONENT_MODES) componentSelection[m].value = new Map();
  });
}

// --- Snapshots for undo/redo ------------------------------------------------------------------

export interface SelectionSnapshot {
  objects: ObjectId[];
  active: ObjectId | null;
  components: Record<ComponentMode, [ObjectId, ElementKey[]][]>;
}

export function snapshotSelection(): SelectionSnapshot {
  const comp = (m: ComponentMode) =>
    [...componentSelection[m].value].map(([id, set]) => [id, [...set]] as [ObjectId, ElementKey[]]);
  return {
    objects: [...selectedObjects.value],
    active: activeObject.value,
    components: { vertex: comp('vertex'), edge: comp('edge'), face: comp('face') },
  };
}

export function restoreSelection(s: SelectionSnapshot): void {
  batch(() => {
    setSelection(s.objects, s.active);
    for (const m of COMPONENT_MODES) setComponents(m, new Map(s.components[m].map(([id, keys]) => [id, new Set(keys)])));
  });
}

/**
 * Drop selected objects that fail `objectOk`, and components whose object or element no longer
 * exists.
 */
export function pruneSelection(
  objectOk: (id: ObjectId) => boolean,
  elementExists: (mode: ComponentMode, id: ObjectId, key: ElementKey) => boolean,
): void {
  batch(() => {
    const kept = [...selectedObjects.value].filter(objectOk);
    if (kept.length !== selectedObjects.value.size) {
      const active = activeObject.value;
      setSelection(kept, active !== null && objectOk(active) ? active : null);
    }
    for (const m of COMPONENT_MODES) {
      let changed = false;
      const next = new Map<ObjectId, ReadonlySet<ElementKey>>();
      for (const [id, set] of componentSelection[m].value) {
        const keep = objectOk(id) ? [...set].filter((k) => elementExists(m, id, k)) : [];
        if (keep.length !== set.size) changed = true;
        if (keep.length) next.set(id, new Set(keep));
      }
      if (changed) componentSelection[m].value = next;
    }
  });
}

function lastOf<T>(set: Set<T>): T | undefined {
  let last: T | undefined;
  for (const x of set) last = x;
  return last;
}
