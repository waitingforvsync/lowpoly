# Code Guide

How the code is organised: the layers, the main types and APIs, and how data flows between
them. For the roadmap see [PLAN.md](PLAN.md); for the reasoning behind decisions see
[JOURNAL.md](JOURNAL.md).

## Layers

```
ui/  (Preact panels)        render/  (Three.js viewport)
        \                      /
         editor/  (session: state, selection, actions, commands, keymap)
              |                 \
          history/            io/  (save / open)
              |
          core/  (pure model: mesh, document, ops; no DOM, no Three.js)
```

Dependencies point downwards. `core/` and `history/` are pure TypeScript with no DOM or Three.js,
and are unit-tested in Node. `editor/` holds the session state and every user-facing operation.
`render/` and `ui/` read the editor's state and call its actions.

**The central rule:** the document is plain data, changed only by `Command`s executed through
the editor's history. Live previews (gizmo drags, colour pickers) mutate the document directly
and call `editor.notifyPreview()`, then commit one command at the end.

## Coordinate conventions

- **Z-up** everywhere. Three.js renders Z-up directly (`camera.up = +Z`).
- Object transforms: `position`, `rotation` (XYZ Euler, **degrees**), `scale`. They match Three.js's
  `Euler` order `'XYZ'`.
- Mesh vertex positions are in object-local space. World = transform applied to local
  (`editor/transformPoints.ts` without Three.js, `render/transformMath.ts` with it).
- UVs are in world units (1 UV unit = 1 length unit).

---

## `core/` — the model

### `math/vec.ts`
Tuple vectors: `Vec2`, `Vec3` (and `ReadonlyVec*`). `add`, `sub`, `scale`, `dot`, `cross`,
`length`, `normalize`, `lerp2`, `lerp3`.
- `newellNormal(points)`: area-weighted polygon normal (length = 2 × area). CCW gives a normal toward the viewer.
- `planeBasis(n)`: orthonormal `{u, v}` in the plane, with `u × v = n`.
- `signedArea2D`, `pointInPolygon2D`.

### `meshdata.ts` — the serialized mesh
```ts
interface MeshData {
  verts: { id: VertId; p: Vec3 }[];
  faces: { id: FaceId; loops: Corner[][]; material: MaterialId }[]; // loops[0] outer (CCW), rest holes (CW)
  wireEdges: [VertId, VertId][];   // edges bordering no face
  softEdges: [VertId, VertId][];   // all other edges are hard
  nextVertId: VertId; nextFaceId: FaceId;
}
interface Corner { v: VertId; uv: Vec2 }
```
Used for save files, undo snapshots and (later) export. `emptyMeshData()`, `cloneMeshData()`.

### `halfedge/mesh.ts` — the working mesh
| Class | Fields | Notes |
|---|---|---|
| `Vertex` | `id`, `pos`, `out: HalfEdge[]` | `out` is unordered |
| `HalfEdge` | `origin`, `twin`, `edge`, `next`, `prev`, `loop`, `uv` | `loop`/`next`/`prev` are null on the open boundary or a wire edge. Getters `dest`, `face`, `isBoundary` |
| `Edge` | `he`, `hard` | `verts`, `faces()`, `isWire`, `isBoundary` |
| `Loop` | `face`, `he` | `halfEdges()`, `verts()`, `positions()`, `isHole` |
| `Face` | `id`, `outer`, `holes`, `material` | `loops`, `halfEdges()`, `normal()` |

`HalfEdgeMesh`
- **Storage:** `verts: Map`, `faces: Map`, and an edge index keyed by vertex pair (`edgeKey(a, b)` = `"min,max"`).
- **Lookups:** `findEdge(a, b)`, `findHalfEdge(a, b)` (directed), `edgeByKey`, `vertex(id)`, `face(id)`, `edges()`, `edgeCount`.
- **Primitive operators.** Each validates before mutating, so a `MeshError` leaves the mesh unchanged:
  - `addVertex(pos, id?)` / `removeVertex(v)`: only an isolated vertex can be removed.
  - `addEdge(a, b)`: adds a wire edge. `removeEdge(e)`: the edge must be wire.
  - `addFace(loops, material?, id?)`: creates missing edges; refuses a half-edge already in use (which would be non-manifold or wrongly wound).
  - `removeFace(face, {removeWireEdges?, removeIsolatedVerts?})`.

The mesh does **not** check planarity on `addFace`. Callers that build faces keep them planar, and `validate()` checks.

### `halfedge/convert.ts`
`fromMeshData(data)` (validating; throws `MeshError`), `toMeshData(mesh)` (canonical order),
`cloneMesh(mesh)`. The round trip is lossless: ids, each loop's starting corner, UVs, hardness.

### `halfedge/validate.ts`
`validate(mesh): string[]` (empty when valid) and `assertValid(mesh)`. It checks:
- twin, next/prev and edge/index consistency, and the per-vertex out lists;
- loop closure and that every loop has ≥ 3 corners;
- no vertex repeated within a face;
- that holes wind opposite to the outer loop;
- that faces are planar, and that id counters are past every id in use.

### `halfedge/euler.ts` — topological operators
They rebuild affected faces through `addFace`/`removeFace` and roll back on failure.
- `splitEdge(mesh, edge, t?, id?) → Vertex`: inserts a vertex, interpolates UVs per face, and keeps the edge's hardness.
- `splitFace(mesh, face, va, vb, newId?) → [Face, Face]`: connects two outer-loop vertices; holes go to whichever side contains them.
- `joinFaces(mesh, edge) → Face`: dissolves the edge between two coplanar faces that share exactly one edge.
- `addHole(mesh, face, corners, {fill?, fillId?})`, `fillHole(mesh, face, hole, id?)`, `removeHole(mesh, face, hole)`.

### `planarity.ts`
`isPlanar(points)`, `isFacePlanar(face)`, `planarDeviation`, `planarTolerance`
(`1e-5 × max(1, bbox diagonal)`), `planeOf`.

### `ops/` — modelling operations (work on a `HalfEdgeMesh`)
| File | API | Behaviour |
|---|---|---|
| `delete.ts` | `deleteFaces`, `deleteEdges`, `deleteVerts` | Blender semantics: removes the elements, plus edges and vertices left unused |
| `dissolve.ts` | `dissolveVertex`, `dissolveEdges`, `dissolveFaces` | Merges faces to keep the surface closed. Refuses non-coplanar results. A two-edge vertex is just removed from its faces |
| `merge.ts` | `mergeVertexGroups`, `mergeAtCenter`, `mergeByDistance` | Welds via `MeshData` and rebuilds (fully validated). Folds bent faces afterwards. Returns a **new** mesh |
| `planarize.ts` | `planarizeAround(mesh, movedVerts)`, `planarizeFaces` | Folds bent faces into planar pieces (cut off moved runs → cut off unmoved runs → triangulate and merge). Fold edges are hard |
| `extrude.ts` | `extrudeFaces(mesh, ids, offset, {textureLock})`, `extrudeAlongNormals`, `extrudeEdges`, `extrudeVerts` → `{mesh, vertMap}`; helpers `regions`, `reverseLoop`, `dropUnusedVerts`, `rebuild` | Faces extrude as edge-connected regions, with walls on every boundary edge (hole outlines too); the faces keep their ids. A free-standing sheet is closed into a solid (a reversed base is left behind; flipped if pulled backwards). Edges need a free side (open boundary or wire). Vertices extrude to wire edges. Works on `MeshData`, returns a **new** mesh |
| `pushpull.ts` | `pushPull(mesh, ids, distance, opts)` → `{mesh, faces}` | SketchUp Push/Pull on coplanar groups: **stretch** when every face around is perpendicular; otherwise extrude, then merge walls into same-facing coplanar neighbours and dissolve straight-through vertices. Pushing flat against an opposite face cuts a **tunnel** (hole) |
| `inset.ts` | `insetFaces(mesh, ids, amount, 'ring' \| 'hole')`, `offsetLoop` | Per-face inset with miter offsets. `ring`: ring of quads, holes inset too. `hole`: SketchUp Offset, the old face becomes a frame around the inset face. Refuses amounts that turn edges around. New corners continue the face's UVs |
| `connect.ts` | `connectVertices(mesh, verts)`, `subdivideEdges(mesh, edges, cuts)` | Connect splits faces between consecutive selected corners. Both edit in place and return new edge keys |
| `faces.ts` | `makeFace(mesh, {edges} \| {verts})`, `makeHole(mesh, inner)`, `triangulateFaces`, `faceContains` | Make face: from one edge cycle, or vertices (cycle order if joined by edges, else by angle); winding follows free half-edges, else faces away from the mesh centre. Make hole: a coplanar inner face becomes a filled hole of the face around it |
| `normals.ts` | `shells`, `shellOrientation`, `flipNormals(mesh, ids?)`, `recalculateNormals(mesh, ids?)` | Orientation is per **shell** (neighbours always wind consistently), so these flip whole edge-connected shells. Recalc uses the signed volume about the shell's centre |

### `triangulate.ts`
`triangulatePolygon(loops: Vec3[][]) → number[]`: earcut in the best-fit plane, CCW triangles.
`triangulateFace(face) → {corners: HalfEdge[], indices}`. Used only for rendering, picking overlays, folding fallback and export.

### `primitives.ts`
`PrimitiveType` = `box | plane | cylinder | cone | sphere | torus`. `PrimitiveSource` = `{type, params}`.
`PRIMITIVES` holds labels, defaults and parameter definitions (used to build the UI). Also
`defaultSource`, `sanitizeSource` (clamps parameters) and `buildPrimitive(src, material) → MeshData`. Every
primitive is Z-up, sits on z = 0, faces outward and has world-unit UVs.

### `uv/project.ts`
`planarAxes(normal)` and `planarUV(p, axes)`: world-unit planar projection. Vertical faces get +Z as up.

### `uv/continue.ts` — texture lock
`faceUVMap(points, uvs)`: least-squares affine map of a planar face's UVs (null if degenerate); used for
inset corners and holes. `wallUVs(a, b, uvA, uvB, offset)`: UVs for the far corners of a wall grown from
edge a→b, continuing the neighbour's texture at the same density, unmirrored. `projectUVs(points)`:
the world-space fallback.

### `document.ts`
- `SceneObject`:
  - `id`, `name`, `mesh: HalfEdgeMesh`, `transform`, `visible`, `locked`.
  - `source: PrimitiveSource | null`: set while the object is still an unedited primitive.
  - `meshRev`: bump it on any mesh change, or call `setMesh()`.
- `Material`: `{id, name, color}` (sRGB, 0–1). Material 0 is the default and can't be removed.
- `Document`:
  - ordered `objects` and `materials`, plus `nextObjectId` / `nextMaterialId` (these only ever increase);
  - lookups and edits: `findObject`, `object`, `objectIndex`, `insertObject`, `removeObject`, `findMaterial`, `insertMaterial`, `removeMaterial`;
  - `uniqueObjectName`.
- Serialization: `serializeDocument` / `deserializeDocument` (`DocumentData`, format `'lowpoly'` v1), `objectToData` / `objectFromData`.

### `testing/fixtures.ts`
`cubeData`, `quadData`, `twoTrianglesData`, `squareWithHoleData`: canonical `MeshData` for tests.

---

## `history/history.ts`
- `Command { label; apply(); revert() }`.
- `History<S>`:
  - `execute(cmd, select?)`, `undo`, `redo`, `clear`. The optional `select` callback runs right after
    the command applies, to set the selection it produces; redo restores that selection;
  - `markSaved`, `isDirty`, `undoLabel`, `redoLabel`.
  - It records the selection snapshot (type `S`) before and after each command, and restores it on undo/redo.
- Helpers: `FnCommand(label, do, undo)` and `CompositeCommand(label, cmds)`, which reverts in reverse order.

---

## `editor/` — the session

| File | Contents |
|---|---|
| `editor.ts` | `Editor` singleton `editor`: `doc`, `docVersion` / `historyVersion` / `fileName` signals, `history`, `ctx` (a `CommandContext`), `execute(cmd, select?)`, `undo`, `redo`, `notifyPreview`, `replaceDocument`, `isDirty`. After every change it prunes stale selections and, in dev builds, validates every mesh |
| `state.ts` | UI signals: `selectionMode`, `activeTool`, `snapEnabled`, `snapInvertHeld`, `gridStep`, `rotationStep`, `projection`, `transformSpace`, `xray`, `cursorWorld`, `statusMessage` (+ `showStatus`), `textureLock`, `insetMode`, `measurement` (value of the drag in progress, shown in the status bar) |
| `selection.ts` | Object selection (`selectedObjects`, `activeObject`, `setSelection`, `selectOnly`, `addToSelection`, `toggleSelection`, `clearSelection`). Component selection: per mode, per object `componentSelection[mode]`, `editObjects`, `applyComponents(mode, refs, op)`, `setComponents`, `clearComponents`, `componentCount`. Undo snapshots: `snapshotSelection` / `restoreSelection`. Plus `pruneSelection` |
| `components.ts` | Resolving element keys against a mesh (`vertexOf`, `edgeOf`, `faceOf`, `keyOfEdge`, `elementExists`, `verticesOf`, `edgesOf`, `facesOf`, `allKeys`) and `convertSelection` between modes |
| `modes.ts` | `setSelectionMode(mode)`: fixes the edit set when entering a component mode, converts the selection between component modes. `isComponentMode` |
| `commands.ts` | `CommandContext`, `AddObjectsCommand`, `RemoveObjectsCommand`, `SetTransformsCommand`, `SetObjectPropsCommand`, `ReplaceMeshCommand` (full before/after snapshots; `capture(obj)`), `MoveVertsCommand` (positions only; clears `source`), `AddMaterialCommand`, `SetMaterialPropsCommand`, `assignObjectMaterialCommand`, `removeMaterialCommand` |
| `actions.ts` | Object-mode operations: `createPrimitive`, `deleteSelection`, `duplicateSelection`, `setTransforms`, `setObjectTransform`, `renameObject`, `setObjectsVisible`, `setObjectsLocked`, `setPrimitiveSource`, `selectAll`, `selectNone`, `invertSelection`. Materials: `addMaterial`, `previewMaterialColor` / `commitMaterialColor`, `renameMaterial`, `deleteMaterial`, `assignMaterial`, `objectMaterial` |
| `componentActions.ts` | Component operations: `deleteComponents`, `dissolveComponents`, `mergeComponentsAtCenter`, `mergeComponentsByDistance`, `selectAllComponents`, `invertComponents`, `componentCentroid`, `moveComponentsTo`, **`commitVertexMoves`** (the single path for vertex moves: folds bent faces, then picks `MoveVerts` or `ReplaceMesh`), `setEdgesHard` / `selectedEdgesHard`, `assignMaterialToFaces` / `selectedFacesMaterial`. **`editMeshes(label, entries, edit, selectMode?)`** runs topology edits on a clone of each mesh; `edit` returns the mesh or an `EditOutcome {mesh?, select?}`, and `select` becomes the selection in `selectMode` (redo restores it). Edits that change nothing are not recorded; failures show in the status bar. `selectedEntries(mode)` |
| `modelActions.ts` | M4 operations on the selection: `pushPullSelection`, `extrudeSelection`, `insetSelection`, `connectSelection` (vertex: split faces; edge: halve edges and connect midpoints), `subdivideSelection`, `makeFaceFromSelection`, `makeHoleSelection`, `flipSelection`, `recalcNormalsSelection`, `triangulateSelection` (the last three act on whole objects in object mode). `extrudeMesh(mesh, mode, keys, offset)` is shared with the Extrude tool |
| `tools.ts` | `TOOLS` definitions (id, label, key, hint), `toolById` |
| `keymap.ts` | `installKeymap()`. Shortcut tables; actions are mode-aware via `byMode`. Tracks Ctrl for snap inversion, and warns on unload when there are unsaved changes |
| `viewActions.ts` | Bridge to the live viewport: `attachViewport`, `currentViewport`, `setStandardView`, `toggleProjection`, `frameSelection`, `spawnPoint` |
| `snap.ts` | `snapScalar`, `snapVec3`, `isSnapActive(enabled, invertHeld)` |
| `transformPoints.ts` | `transformPoint(t, p)` / `inverseTransformPoint` without Three.js |

### Adding an undoable operation
1. Write the mesh logic as a pure function in `core/ops/` that takes a `HalfEdgeMesh`, with tests.
2. Add an action in `editor/modelActions.ts` (or `componentActions.ts`). Use
   `editMeshes(label, entries, fn, selectMode)` for topology changes, returning `{mesh, select}` so the
   result's selection survives redo; or `commitVertexMoves` for position-only changes (it folds bent
   faces for you).
3. Bind it in `keymap.ts` and/or add a button in `ui/`.

---

## `render/` — the viewport

| File | Contents |
|---|---|
| `Viewport.ts` | Owns the renderer, both cameras (perspective/ortho), OrbitControls, `SceneSync`, `ComponentOverlay`, `Gizmo` and the grid. One effect re-syncs on any document, selection or mode change. Pointer handling: click → pick, drag past 4 px → box select (window or crossing), hover highlight in component modes; with the Push/Pull or Inset tool, a press on a face starts a `FaceDrag` (Esc cancels). Also `setStandardView`, `frameObjects`, `framePoints`, `spawnPoint`, `worldToScreen` |
| `FaceDrag.ts` | `PushPullDrag`, `InsetDrag`, `localFaceHit`. Each pointer move re-runs the op on a fresh copy of the original mesh as a preview (`obj.setMesh`); release restores the original and commits one `ReplaceMeshCommand`. Push/Pull distance = closest approach of the pointer ray to the normal line through the press point; inset amount = pointer travel across the face plane. Both in local space, snapped to the grid step |
| `SceneSync.ts` | Mirrors the document into Three.js: one group per object (mesh + hard-edge lines + soft-edge lines). Rebuilds geometry only when `meshRev` changes. Keeps a material per document material; X-ray makes faces translucent. `pickables`, `meshOf`, `bounds` |
| `meshBuffers.ts` | `buildMeshBuffers(mesh)` (pure, tested): non-indexed positions, normals (flat, smoothed across soft edges via `cornerNormal`), UVs, per-material groups, `triFaces` (triangle → face id), hard and soft edge segments |
| `Picker.ts` | `pickComponent(env, mode, x, y)`, `boxComponents(env, mode, rect, crossing)`, `boxObjects`. Screen-space distance for vertices and edges, raycasting for faces. Occlusion uses jittered rays with a tolerance of a few pixels' world size |
| `ComponentOverlay.ts` | Vertex dots, thick selected/hover edges (`LineSegments2`), translucent face fills. Rebuilt on change |
| `Gizmo.ts` | `TransformControls` on a hidden pivot. Targets are objects or components (`GizmoTargets`). It previews live, and commits `SetTransforms` or `commitVertexMoves` on release. With the Extrude tool the translate gizmo extrudes: each frame re-runs `extrudeMesh` with the local offset and selects the copies; release commits one `ReplaceMeshCommand` per object |
| `transformMath.ts` | `applyTransform`, `transformToMatrix`, `matrixToTransform` (rounds away float noise) |
| `grid.ts`, `AxesIndicator.ts`, `colors.ts` | Ground grid (drawn first without depth writes), corner axes gizmo, palette |

## `ui/` — panels (Preact)
`App` lays out `Toolbar`, `Outliner` and `Properties` (sidebar), `ViewportView` and `StatusBar`.
`fields.tsx` has `TextField`, `NumberField` and `Vec3Field` (commit on Enter or blur, revert on Escape),
plus colour hex helpers. `icons.tsx` has small SVG icons. `Properties.tsx` shows a **Model** section per
component mode (numeric Push/Pull, Extrude, Inset, Subdivide; Connect, Make Face/Hole, Triangulate,
Flip, Recalc Normals) and per-tool options (texture lock, inset mode).

**Important: `useDoc()`.** The document is mutated in place, and `@preact/signals` skips re-rendering
children whose props haven't changed. Every component that displays document data must call
`useDoc()` (which reads `editor.docVersion`) itself. See the JOURNAL entry in M3.

## `io/file.ts`
`newDocument`, `saveDocument(saveAs?)`, `openDocument`. Uses the File System Access API when
available (Save writes back to the same file), otherwise falls back to a download and a file input.
The format is `serializeDocument` JSON, saved as `*.lowpoly.json`.

## Tests and tooling
- `npm test` (Vitest, Node). Tests sit next to their sources as `*.test.ts`. **Also run `npm run typecheck`**: Vitest does not type-check.
- `npm run dev`, or F5 in VS Code (`.vscode/launch.json`, using `serverReadyAction`).
- Browser checks: drive the dev server with Playwright on the real GPU. App modules can be imported in
  the page (`await import('/src/editor/editor.ts')`) to inspect live state.
