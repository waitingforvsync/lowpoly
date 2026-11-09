import type { Document } from '../core/document';
import { editor } from '../editor/editor';

/**
 * Subscribe a component to document changes and return the document.
 *
 * @preact/signals skips re-rendering a child whose props are shallowly unchanged unless it reads
 * a signal that changed. The document is mutated in place, so every component that shows
 * document data must read `docVersion` itself (via this hook), not rely on its parent.
 */
export function useDoc(): Document {
  void editor.docVersion.value;
  return editor.doc;
}
