import type { SceneObject } from '../core/document';
import { edgeKey, type HalfEdgeMesh } from '../core/halfedge/mesh';
import type { ReadonlyVec3 } from '../core/math/vec';
import { connectVertices, subdivideEdges } from '../core/ops/connect';
import { extrudeAlongNormals, extrudeEdges, extrudeFaces, extrudeVerts } from '../core/ops/extrude';
import { makeFace, makeHole, triangulateFaces } from '../core/ops/faces';
import { insetFaces } from '../core/ops/inset';
import { flipNormals, recalculateNormals } from '../core/ops/normals';
import { pushPull } from '../core/ops/pushpull';
import { allKeys, edgesOf, facesOf, verticesOf } from './components';
import { editMeshes, type EditOutcome, selectedEntries } from './componentActions';
import { editor } from './editor';
import { isComponentMode } from './modes';
import { type ComponentMode, type ElementKey, selectedObjects } from './selection';
import { insetMode, selectionMode, showStatus, textureLock } from './state';

/** Modelling operations (M4) on the current selection. Each one is a single undo step. */

const faceIds = (keys: ReadonlySet<ElementKey>) => [...keys].filter((k): k is number => typeof k === 'number');

/**
 * Extrude the selected elements of one mesh by `offset` (in the object's local space): faces as
 * regions, boundary/loose edges into quads, vertices into loose edges. Shared by the numeric
 * command and the interactive Extrude tool. Selects the extruded copies.
 */
export function extrudeMesh(
  mesh: HalfEdgeMesh,
  mode: ComponentMode,
  keys: ReadonlySet<ElementKey>,
  offset: ReadonlyVec3,
): Required<EditOutcome> {
  const lock = textureLock.peek();
  if (mode === 'face') {
    const ids = faceIds(keys);
    return { mesh: extrudeFaces(mesh, ids, offset, { textureLock: lock }).mesh, select: ids };
  }
  if (mode === 'edge') {
    const edges = edgesOf(mesh, keys);
    const r = extrudeEdges(mesh, [...keys] as string[], offset, { textureLock: lock });
    return {
      mesh: r.mesh,
      select: edges.map((e) => edgeKey(r.vertMap.get(e.verts[0].id)!, r.vertMap.get(e.verts[1].id)!)),
    };
  }
  const r = extrudeVerts(mesh, faceIds(keys), offset);
  return { mesh: r.mesh, select: [...r.vertMap.values()] };
}

/** Push/pull the selected faces by `distance` along their normals. */
export function pushPullSelection(distance: number): void {
  const entries = selectedEntries('face');
  if (!entries.length || !distance) return;
  editMeshes(
    'Push/Pull',
    entries,
    (mesh, keys) => {
      const r = pushPull(mesh, faceIds(keys), distance, { textureLock: textureLock.peek() });
      return { mesh: r.mesh, select: r.faces };
    },
    'face',
  );
}

/** Extrude the selected faces by `distance` along each region's normal. */
export function extrudeSelection(distance: number): void {
  const entries = selectedEntries('face');
  if (!entries.length || !distance) return;
  editMeshes(
    'Extrude Faces',
    entries,
    (mesh, keys) => ({ mesh: extrudeAlongNormals(mesh, faceIds(keys), distance, { textureLock: textureLock.peek() }), select: faceIds(keys) }),
    'face',
  );
}

export function insetSelection(amount: number): void {
  const entries = selectedEntries('face');
  if (!entries.length || !(amount > 0)) return;
  editMeshes(
    'Inset Faces',
    entries,
    (mesh, keys) => {
      const r = insetFaces(mesh, faceIds(keys), amount, insetMode.peek());
      return { mesh: r.mesh, select: r.faces };
    },
    'face',
  );
}

/**
 * Connect: in vertex mode, split faces between selected vertices; in edge mode, cut each
 * selected edge in half and connect the midpoints across their faces.
 */
export function connectSelection(mode: ComponentMode): void {
  if (mode === 'face') {
    showStatus('Connect works on selected vertices or edges');
    return;
  }
  const entries = selectedEntries(mode);
  if (!entries.length) return;
  editMeshes(
    mode === 'vertex' ? 'Connect Vertices' : 'Connect Edges',
    entries,
    (mesh, keys) => {
      if (mode === 'vertex') {
        connectVertices(mesh, verticesOf(mesh, 'vertex', keys));
        return { select: [...keys] };
      }
      const before = new Set(mesh.verts.keys());
      subdivideEdges(mesh, edgesOf(mesh, keys), 1);
      const mids = [...mesh.verts.values()].filter((v) => !before.has(v.id));
      return { select: connectVertices(mesh, mids) };
    },
    mode,
  );
}

/** Split each selected edge into `cuts + 1` equal pieces. */
export function subdivideSelection(cuts: number): void {
  const entries = selectedEntries('edge');
  if (!entries.length) return;
  editMeshes('Subdivide Edges', entries, (mesh, keys) => ({ select: subdivideEdges(mesh, edgesOf(mesh, keys), cuts) }), 'edge');
}

/** Make a face from the selected edge loop or vertices. The new face is selected in face mode. */
export function makeFaceFromSelection(mode: ComponentMode): void {
  if (mode === 'face') {
    showStatus('Make Face works on selected vertices or edges');
    return;
  }
  const entries = selectedEntries(mode);
  if (!entries.length) return;
  editMeshes(
    'Make Face',
    entries,
    (mesh, keys) => {
      const f = makeFace(mesh, mode === 'edge' ? { edges: edgesOf(mesh, keys) } : { verts: verticesOf(mesh, 'vertex', keys) });
      return { select: [f.id] };
    },
    'face',
  );
}

/** Cut each selected face out of the coplanar face surrounding it. */
export function makeHoleSelection(): void {
  const entries = selectedEntries('face');
  if (!entries.length) return;
  editMeshes('Make Hole', entries, (mesh, keys) => {
    for (const f of facesOf(mesh, keys)) makeHole(mesh, f);
  });
}

/**
 * Entries for operations that apply to whole objects in object mode, or to the selected faces
 * in face mode.
 */
function faceOrObjectEntries(): [SceneObject, ReadonlySet<ElementKey>][] {
  const mode = selectionMode.peek();
  if (isComponentMode(mode)) return mode === 'face' ? selectedEntries('face') : [];
  return editor.doc.objects
    .filter((o) => selectedObjects.peek().has(o.id) && o.visible && !o.locked)
    .map((o) => [o, new Set(allKeys(o.mesh, 'face'))]);
}

/** Reverse the faces of every shell (connected part) touched by the selection. */
export function flipSelection(): void {
  const entries = faceOrObjectEntries();
  if (!entries.length) return;
  editMeshes('Flip Normals', entries, (mesh, keys) => flipNormals(mesh, faceIds(keys)).mesh);
}

/** Turn every shell touched by the selection to face outward. */
export function recalcNormalsSelection(): void {
  const entries = faceOrObjectEntries();
  if (!entries.length) return;
  let flipped = 0;
  let failed = false;
  editMeshes('Recalculate Normals', entries, (mesh, keys) => {
    try {
      const r = recalculateNormals(mesh, faceIds(keys));
      flipped += r.flipped;
      return r.mesh;
    } catch (e) {
      failed = true;
      throw e;
    }
  });
  if (!failed) showStatus(flipped ? `Recalculate normals: flipped ${flipped} part${flipped === 1 ? '' : 's'}` : 'Normals already face outward');
}

export function triangulateSelection(): void {
  const entries = faceOrObjectEntries();
  if (!entries.length) return;
  const inFaceMode = selectionMode.peek() === 'face';
  editMeshes(
    'Triangulate',
    entries,
    (mesh, keys) => ({ select: triangulateFaces(mesh, facesOf(mesh, keys)) }),
    inFaceMode ? 'face' : undefined,
  );
}
