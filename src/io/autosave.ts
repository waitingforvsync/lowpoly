import { effect } from '@preact/signals';
import { deserializeDocument, serializeDocument } from '../core/document';
import { editor } from '../editor/editor';
import { showStatus } from '../editor/state';

/**
 * Autosave: the open document is written to IndexedDB shortly after every change (and on New /
 * Open), and restored when the app starts. IndexedDB rather than localStorage, whose ~5 MB limit
 * documents with embedded textures easily exceed. One slot: the most recent document.
 */

const DB_NAME = 'lowpoly';
const STORE = 'autosave';
const KEY = 'current';
const DELAY_MS = 800;

interface Saved {
  json: string;
  fileName: string;
  savedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Restore the autosaved document, if there is one. Returns true if it did. */
export async function restoreAutosave(): Promise<boolean> {
  let saved: Saved | undefined;
  try {
    saved = await run<Saved | undefined>('readonly', (s) => s.get(KEY));
  } catch {
    return false; // IndexedDB unavailable (e.g. some private modes)
  }
  if (!saved) return false;
  try {
    const doc = deserializeDocument(JSON.parse(saved.json));
    editor.replaceDocument(doc, saved.fileName);
  } catch (e) {
    showStatus(`Couldn't restore the autosaved document: ${(e as Error).message}`, 'error');
    return false;
  }
  const when = new Date(saved.savedAt).toLocaleString();
  showStatus(`Restored your last session (autosaved ${when}). Save to keep it as a file.`);
  return true;
}

/** Start saving after changes. Call after `restoreAutosave`, so the startup scene doesn't overwrite it. */
export function installAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = '';
  let warned = false;
  const stop = effect(() => {
    void editor.historyVersion.value;
    const fileName = editor.fileName.value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const json = JSON.stringify(serializeDocument(editor.doc));
      if (json === last) return;
      last = json;
      run('readwrite', (s) => s.put({ json, fileName, savedAt: Date.now() } satisfies Saved, KEY)).catch((e: unknown) => {
        if (!warned) showStatus(`Autosave failed: ${(e as Error)?.message ?? e}`, 'error');
        warned = true;
      });
    }, DELAY_MS);
  });
  return () => {
    clearTimeout(timer);
    stop();
  };
}
