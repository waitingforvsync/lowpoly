import { batch, signal } from '@preact/signals';
import { Document, SceneObject } from '../core/document';
import { fromMeshData } from '../core/halfedge/convert';
import { validate } from '../core/halfedge/validate';
import { buildPrimitive, defaultSource } from '../core/primitives';
import { type Command, History } from '../history/history';
import type { CommandContext } from './commands';
import { elementExists } from './components';
import {
  clearComponents,
  clearSelection,
  editObjects,
  pruneSelection,
  restoreSelection,
  type SelectionSnapshot,
  setSelection,
  snapshotSelection,
} from './selection';

/**
 * The editor session: the open document, its undo history and file name. UI and viewport
 * subscribe to `docVersion` (any document change, including live drag previews) and
 * `historyVersion` (undo/redo availability, dirty state).
 */
export class Editor {
  doc: Document;
  readonly docVersion = signal(0);
  readonly historyVersion = signal(0);
  readonly fileName = signal('Untitled');
  readonly history: History<SelectionSnapshot>;
  readonly ctx: CommandContext;

  constructor() {
    this.doc = createStartupDocument();
    const self = this;
    this.ctx = {
      get doc() {
        return self.doc;
      },
      selectObjects: (ids) => setSelection(ids),
    };
    this.history = new History<SelectionSnapshot>({
      getSelection: snapshotSelection,
      setSelection: restoreSelection,
      onChange: () => this.afterChange(),
    });
  }

  /** Run a command as one undo step. `select` sets the selection it produces (see History). */
  execute(cmd: Command | null, select?: () => void): void {
    if (cmd) this.history.execute(cmd, select);
  }

  undo(): void {
    this.history.undo();
  }

  redo(): void {
    this.history.redo();
  }

  /** Signal a document change made outside a command, e.g. a live preview while dragging. */
  notifyPreview(): void {
    this.docVersion.value++;
  }

  /** Replace the open document (New / Open). Clears history and selection. */
  replaceDocument(doc: Document, fileName: string): void {
    batch(() => {
      this.doc = doc;
      this.fileName.value = fileName;
      clearSelection();
      clearComponents();
      editObjects.value = new Set(doc.objects.map((o) => o.id));
      this.history.clear();
    });
  }

  get isDirty(): boolean {
    return this.history.isDirty;
  }

  private afterChange(): void {
    batch(() => {
      // Deleted or hidden objects can't stay selected; nor can elements that no longer exist.
      pruneSelection(
        (id) => this.doc.findObject(id)?.visible === true,
        (mode, id, key) => {
          const obj = this.doc.findObject(id);
          return !!obj && elementExists(obj.mesh, mode, key);
        },
      );
      const edit = [...editObjects.value].filter((id) => this.doc.findObject(id));
      if (edit.length !== editObjects.value.size) editObjects.value = new Set(edit);
      this.historyVersion.value++;
      this.docVersion.value++;
    });
    if (import.meta.env.DEV) this.validateAll();
  }

  /** Dev builds: check every mesh after each change, so topology bugs surface immediately. */
  private validateAll(): void {
    for (const obj of this.doc.objects) {
      const errors = validate(obj.mesh);
      if (errors.length) console.error(`Invalid mesh on object "${obj.name}":\n  ${errors.join('\n  ')}`);
    }
  }
}

export function createStartupDocument(): Document {
  const doc = new Document();
  const src = defaultSource('box');
  doc.insertObject(new SceneObject(doc.nextObjectId, 'Box', fromMeshData(buildPrimitive(src)), undefined, true, false, src));
  return doc;
}

export const editor = new Editor();
