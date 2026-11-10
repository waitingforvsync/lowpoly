import type { Edge, Face, HalfEdgeMesh, Vertex } from '../core/halfedge/mesh';
import { edgeLoop, growEdges, growFaces, growVertices, linkedVertices, shrinkEdges, shrinkFaces, shrinkVertices } from '../core/ops/select';
import { convertSelection, edgeOf, edgesOf, facesOf, keyOfEdge, verticesOf } from './components';
import { editor } from './editor';
import { isComponentMode } from './modes';
import { applyComponents, componentSelection, type ComponentMode, type ComponentRef, type ElementKey, type SelectOp, setComponents } from './selection';
import { selectionMode } from './state';

/** Selection commands for component modes (M8): linked, grow, shrink, edge loop. Not undoable. */

type Step = 'grow' | 'shrink';

function stepKeys(mesh: HalfEdgeMesh, mode: ComponentMode, keys: ReadonlySet<ElementKey>, step: Step): ElementKey[] {
  if (mode === 'vertex') {
    const sel = new Set<Vertex>(verticesOf(mesh, 'vertex', keys));
    return [...(step === 'grow' ? growVertices(sel) : shrinkVertices(sel))].map((v) => v.id);
  }
  if (mode === 'edge') {
    const sel = new Set<Edge>(edgesOf(mesh, keys));
    return [...(step === 'grow' ? growEdges(sel) : shrinkEdges(sel))].map(keyOfEdge);
  }
  const sel = new Set<Face>(facesOf(mesh, keys));
  return [...(step === 'grow' ? growFaces(sel) : shrinkFaces(sel))].map((f) => f.id);
}

function stepSelection(step: Step): void {
  const mode = selectionMode.peek();
  if (!isComponentMode(mode)) return;
  const next = new Map<number, Set<ElementKey>>();
  for (const [id, keys] of componentSelection[mode].peek()) {
    const obj = editor.doc.findObject(id);
    if (obj) next.set(id, new Set(stepKeys(obj.mesh, mode, keys, step)));
  }
  setComponents(mode, next);
}

/** Add everything that shares a vertex with the selection. */
export const growSelection = () => stepSelection('grow');
/** Remove what touches anything unselected. */
export const shrinkSelection = () => stepSelection('shrink');

/** Extend the selection to every element connected to it. */
export function selectLinked(): void {
  const mode = selectionMode.peek();
  if (!isComponentMode(mode)) return;
  const doc = editor.doc;
  const verts = new Map<number, Set<ElementKey>>();
  for (const [id, keys] of componentSelection[mode].peek()) {
    const obj = doc.findObject(id);
    if (obj) verts.set(id, new Set([...linkedVertices(verticesOf(obj.mesh, mode, keys))].map((v) => v.id)));
  }
  // Whole shells, so converting up takes every element in them.
  setComponents(mode, convertSelection(doc, verts, 'vertex', mode));
}

/** Edge mode, Alt+click: select the edge loop through the clicked edge. */
export function selectEdgeLoop(ref: ComponentRef, op: SelectOp): void {
  const obj = editor.doc.findObject(ref.objectId);
  const e = obj && edgeOf(obj.mesh, ref.key);
  if (!e) return;
  const loop = edgeLoop(e).map((x) => ({ objectId: ref.objectId, key: keyOfEdge(x) }));
  // Toggle a whole loop by whether the clicked edge was selected.
  const selected = componentSelection.edge.peek().get(ref.objectId)?.has(ref.key) ?? false;
  applyComponents('edge', loop, op === 'toggle' ? (selected ? 'remove' : 'add') : op);
}
