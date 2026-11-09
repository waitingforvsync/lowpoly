import { batch, signal } from '@preact/signals';
import type { ObjectId } from '../core/document';

/**
 * Object selection. Not part of the document and never an undo entry on its own; the history
 * snapshots it around each command so undo/redo restores a sensible selection.
 */

export const selectedObjects = signal<ReadonlySet<ObjectId>>(new Set());
/** The most recently selected object, which the properties panel shows. */
export const activeObject = signal<ObjectId | null>(null);

export interface SelectionSnapshot {
  objects: ObjectId[];
  active: ObjectId | null;
}

export function snapshotSelection(): SelectionSnapshot {
  return { objects: [...selectedObjects.value], active: activeObject.value };
}

export function restoreSelection(s: SelectionSnapshot): void {
  setSelection(s.objects, s.active);
}

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

/** Drop ids that no longer exist. */
export function pruneSelection(exists: (id: ObjectId) => boolean): void {
  const kept = [...selectedObjects.value].filter(exists);
  if (kept.length !== selectedObjects.value.size) {
    const active = activeObject.value;
    setSelection(kept, active !== null && exists(active) ? active : null);
  }
}

function lastOf<T>(set: Set<T>): T | undefined {
  let last: T | undefined;
  for (const x of set) last = x;
  return last;
}
