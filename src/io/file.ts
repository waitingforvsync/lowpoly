import { deserializeDocument, Document, serializeDocument } from '../core/document';
import { editor } from '../editor/editor';

/**
 * Save and open documents as JSON. Uses the File System Access API where available (Chrome,
 * Edge), so Save writes back to the same file. Otherwise falls back to a download and an
 * <input type="file">.
 */

const EXTENSION = '.lowpoly.json';

interface WritableFile {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  name: string;
  createWritable(): Promise<WritableFile>;
  getFile(): Promise<File>;
}
interface PickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
interface FsWindow {
  showSaveFilePicker?: (o: PickerOptions) => Promise<FileHandle>;
  showOpenFilePicker?: (o: PickerOptions) => Promise<FileHandle[]>;
}

const fsWindow = window as unknown as FsWindow;
const FILE_TYPES = [{ description: 'Lowpoly scene', accept: { 'application/json': ['.json'] } }];

let currentHandle: FileHandle | null = null;

function baseName(fileName: string): string {
  return fileName.replace(/\.lowpoly\.json$|\.json$/i, '');
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function confirmDiscard(): boolean {
  return !editor.isDirty || window.confirm('Discard unsaved changes?');
}

export function newDocument(): void {
  if (!confirmDiscard()) return;
  currentHandle = null;
  editor.replaceDocument(new Document(), 'Untitled');
}

export async function saveDocument(saveAs = false): Promise<void> {
  const json = JSON.stringify(serializeDocument(editor.doc), null, 1);
  try {
    if (fsWindow.showSaveFilePicker) {
      if (!currentHandle || saveAs) {
        currentHandle = await fsWindow.showSaveFilePicker({
          suggestedName: baseName(editor.fileName.value) + EXTENSION,
          types: FILE_TYPES,
        });
      }
      const w = await currentHandle.createWritable();
      await w.write(json);
      await w.close();
      editor.fileName.value = baseName(currentHandle.name);
    } else {
      download(baseName(editor.fileName.value) + EXTENSION, json);
    }
    editor.history.markSaved();
  } catch (e) {
    if (!isAbort(e)) window.alert(`Could not save: ${(e as Error).message}`);
  }
}

export async function openDocument(): Promise<void> {
  if (!confirmDiscard()) return;
  try {
    let file: File | null;
    let handle: FileHandle | null = null;
    if (fsWindow.showOpenFilePicker) {
      [handle = null] = await fsWindow.showOpenFilePicker({ types: FILE_TYPES });
      file = handle ? await handle.getFile() : null;
    } else {
      file = await pickFile();
    }
    if (!file) return;
    const doc = deserializeDocument(JSON.parse(await file.text()));
    currentHandle = handle;
    editor.replaceDocument(doc, baseName(file.name));
  } catch (e) {
    if (!isAbort(e)) window.alert(`Could not open file: ${(e as Error).message}`);
  }
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
