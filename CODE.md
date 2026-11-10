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
- `splitFace(mesh, face, va, vb, newId?, path?) → [Face, Face]`: connects two outer-loop vertices, directly or through `path` (new points inside the face, from `va` to `vb`, whose UVs continue the face's mapping); holes go to whichever side contains them. Without a path the vertices must not be adjacent.
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
| `paint.ts` | `paintTargets(faces, clicked, 'face' \| 'connected' \| 'same')` | Which faces a Paint click affects: the face, its edge-connected faces of the same material, or every face with that material |
| `draw.ts` | `locateOnFace(face, p)`, `drawPathOnFace(mesh, faceId, pts)`, `drawLoopOnFace(mesh, faceId, pts)` → `{faces, inner}`, `faceUnder(mesh, pts, closed)`, `loopMeshData(pts, up)`, `cleanPoints`, `isSimple2D` | Line/Rectangle results. A closed shape inside a face becomes a filled hole; one touching the outer edge at ≥ 2 points splits the face along each stretch through its inside; a path from outer edge to outer edge splits it (edge points split the edge first, also in the neighbour). Refuses shapes that leave the face, cross themselves or its edges, touch at one point, touch or surround a hole. Edits in place |
| `loopcut.ts` | `edgeRing(edge)` → `{edges: {from, to}[], faces, closed}`, `loopCut(mesh, edge, ts)`, `evenCuts(n)`, `loopCutSegments(ring, ts)` | The ring runs through quads to the opposite edge both ways, until a non-quad, a boundary or back to the start. Parameters are measured from each ring edge's `from` end, so one t cuts straight across. Edits in place; returns the new edge keys |
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

### `uv/uvops.ts` — UV commands
`projectFaceUVs(mesh, faces, kind, params)` with `kind` = `'face'` (each face on its own plane),
`'planar'` (one plane: the average normal) or `'box'` (nearest world axis per face, `nearestAxis`).
`transformFaceUVs(mesh, faces, params)` scales/rotates the existing UVs about their centre, then
offsets them. `UVParams = {scale, rotation (deg), offset}`: uv → R·uv / scale + offset.

### `uv/continue.ts` — texture lock
`faceUVMap(points, uvs)`: least-squares affine map of a planar face's UVs (null if degenerate); used for
inset corners and holes. `wallUVs(a, b, uvA, uvB, offset)`: UVs for the far corners of a wall grown from
edge a→b, continuing the neighbour's texture at the same density, unmirrored. `projectUVs(points)`:
the world-space fallback. `faceUVFunction(points, uvs)`: `faceUVMap`, or the planar fallback when the
face's UVs are degenerate (for new points drawn on a face).

### `document.ts`
- `SceneObject`:
  - `id`, `name`, `mesh: HalfEdgeMesh`, `transform`, `visible`, `locked`.
  - `source: PrimitiveSource | null`: set while the object is still an unedited primitive.
  - `meshRev`: bump it on any mesh change, or call `setMesh()`.
- `Material`: `{id, name, color, texture?, textureSize?}`. `color` is sRGB 0–1 (shown when untextured
  or textures are off). `textureSize` is the world size of one image repeat (default 1 × 1): UVs are
  in world units, so this sets how big the texture looks. Material 0 is the default and can't be
  removed. `cloneMaterial`.
- `TextureAsset`: `{id, name, mime, data (a data: URL), width, height}`.
- `Document`:
  - ordered `objects` and `materials`, a `textures` list, plus `nextObjectId` / `nextMaterialId` /
    `nextTextureId` (these only ever increase);
  - lookups and edits: `findObject`, `object`, `objectIndex`, `insertObject`, `removeObject`, `findMaterial`, `insertMaterial`, `removeMaterial`, `findTexture`, `insertTexture`, `removeTexture`, `materialTexture(m)`;
  - `uniqueObjectName`.
- Serialization: `serializeDocument` / `deserializeDocument` (`DocumentData`, format `'lowpoly'` v1), `objectToData` / `objectFromData`.
  Textures are embedded; only those some material uses are saved (unused ones stay in memory for undo).
  `textures` / `nextTextureId` are optional, so older files load; a material pointing at a missing image loses the reference.

### `testing/fixtures.ts`
`cubeData`, `quadData`, `twoTrianglesData`, `squareWithHoleData`: canonical `MeshData` for tests.

---

## `history/history.ts`
- `Command { label; apply(); revert() }`.
- `History<S>`:
  - `execute(cmd, select?)`, `undo`, `redo`, `clear`. The optional `select` callback runs right after
    the command applies, to set the selection it produces; redo restores that selection;
  - `markSaved`, `isDirty`, `undoLabel`, `redoLabel`, `lastCommand` (what the next undo reverts).
  - It records the selection snapshot (type `S`) before and after each command, and restores it on undo/redo.
- Helpers: `FnCommand(label, do, undo)` and `CompositeCommand(label, cmds)`, which reverts in reverse order.

---

## `editor/` — the session

| File | Contents |
|---|---|
| `editor.ts` | `Editor` singleton `editor`: `doc`, `docVersion` / `historyVersion` / `fileName` signals, `history`, `ctx` (a `CommandContext`), `execute(cmd, select?)`, `undo`, `redo`, `notifyPreview`, `replaceDocument`, `isDirty`. After every change it prunes stale selections and, in dev builds, validates every mesh |
| `state.ts` | UI signals: `selectionMode`, `activeTool`, `snapEnabled`, `snapInvertHeld`, `gridStep`, `rotationStep`, `projection`, `transformSpace`, `xray`, `cursorWorld`, `statusMessage` (+ `showStatus`), `textureLock`, `insetMode`, `measurement` (value of the drag in progress, shown in the status bar), `activeMaterial` (what Paint applies), `showTextures` |
| `materialActions.ts` | `loadMaterialTexture(id)` (file picker), `setMaterialTextureFromFile(id, blob)`, `clearMaterialTexture`, `setMaterialTextureSize`, `paintMaterial()` (the active material, or Default if it was deleted), `paintFaces(objectId, faceIds, scope)`, `sampleMaterial` |
| `selection.ts` | Object selection (`selectedObjects`, `activeObject`, `setSelection`, `selectOnly`, `addToSelection`, `toggleSelection`, `clearSelection`). Component selection: per mode, per object `componentSelection[mode]`, `editObjects`, `applyComponents(mode, refs, op)`, `setComponents`, `clearComponents`, `componentCount`. Undo snapshots: `snapshotSelection` / `restoreSelection`. Plus `pruneSelection` |
| `components.ts` | Resolving element keys against a mesh (`vertexOf`, `edgeOf`, `faceOf`, `keyOfEdge`, `elementExists`, `verticesOf`, `edgesOf`, `facesOf`, `allKeys`) and `convertSelection` between modes |
| `modes.ts` | `setSelectionMode(mode)`: fixes the edit set when entering a component mode, converts the selection between component modes. `isComponentMode` |
| `commands.ts` | `CommandContext`, `AddObjectsCommand`, `RemoveObjectsCommand`, `SetTransformsCommand`, `SetObjectPropsCommand`, `ReplaceMeshCommand` (full before/after snapshots; `capture(obj)`), `MoveVertsCommand` (positions only; clears `source`), `AddMaterialCommand`, `SetMaterialPropsCommand`, `assignObjectMaterialCommand`, `removeMaterialCommand`. `SetMaterialPropsCommand` takes `Partial<MaterialProps>` (`name`, `color`, `texture`, `textureSize`; `null` unsets the optional ones, so undo restores "never set" exactly). `AddTextureCommand` |
| `actions.ts` | Object-mode operations: `createPrimitive`, `deleteSelection`, `duplicateSelection`, `setTransforms`, `setObjectTransform`, `renameObject`, `setObjectsVisible`, `setObjectsLocked`, `setPrimitiveSource`, `selectAll`, `selectNone`, `invertSelection`. Materials: `addMaterial`, `previewMaterialColor` / `commitMaterialColor`, `renameMaterial`, `deleteMaterial`, `assignMaterial`, `objectMaterial` |
| `componentActions.ts` | Component operations: `deleteComponents`, `dissolveComponents`, `mergeComponentsAtCenter`, `mergeComponentsByDistance`, `selectAllComponents`, `invertComponents`, `componentCentroid`, `moveComponentsTo`, **`commitVertexMoves`** (the single path for vertex moves: folds bent faces, then picks `MoveVerts` or `ReplaceMesh`), `setEdgesHard` / `selectedEdgesHard`, `assignMaterialToFaces` / `selectedFacesMaterial`. **`editMeshes(label, entries, edit, selectMode?)`** runs topology edits on a clone of each mesh; `edit` returns the mesh or an `EditOutcome {mesh?, select?}`, and `select` becomes the selection in `selectMode` (redo restores it). Edits that change nothing are not recorded; failures show in the status bar. `selectedEntries(mode)` |
| `modelActions.ts` | M4 operations on the selection: `pushPullSelection`, `extrudeSelection`, `insetSelection`, `connectSelection` (vertex: split faces; edge: halve edges and connect midpoints), `subdivideSelection`, `makeFaceFromSelection`, `makeHoleSelection`, `flipSelection`, `recalcNormalsSelection`, `triangulateSelection` (the last three act on whole objects in object mode), `projectUVSelection(kind, params)`, `transformUVSelection(params)` (faces in face mode, whole objects in object mode; `faceOrObjectEntries`). `extrudeMesh(mesh, mode, keys, offset)` is shared with the Extrude tool |
| `tools.ts` | `TOOLS` definitions (id, label, key, hint), `toolById` |
| `measure.ts` | The measurement box. `MeasureHandler {label, apply(text), valid?()}`, `measureHandler` / `measureTyped` signals, `offerMeasure`, `withdrawMeasure`, `currentMeasure()` (for display), `measureKey(e)` (keymap routing: digits , ; . - start typing; Backspace / Enter / Esc while typing), `applyMeasure`, `parseNumbers`, `parseOne`. **`offerReplace(label, parse, run)`**: after an operation, a typed value undoes it and runs it again with the value, while it is still the last command; if the rerun executes nothing, the original is redone. Changing tool withdraws the offer (`installMeasure`) |
| `drawActions.ts` | `drawShape(worldPoints, closed, label, up, prefer?)` → `'drawn' \| 'nothing' \| 'pending' \| 'error'`: on a face of a visible unlocked object, cuts it (`draw.ts`, via `editMeshes`; an open line only once both ends are on the face's edge); a closed shape elsewhere becomes a new "Shape" object (origin at its first point, facing up if flat, else the viewer; added to the edit set in component modes). `loopCutEdge(objectId, edgeKey, {cuts} \| {t, from})` |
| `keymap.ts` | `installKeymap()`. Shortcut tables; actions are mode-aware via `byMode`. Tracks Ctrl for snap inversion, and warns on unload when there are unsaved changes. Keys go to the measurement box first when it accepts a value |
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
| `Viewport.ts` | Owns the renderer, both cameras (perspective/ortho), OrbitControls, `SceneSync`, `ComponentOverlay`, `Gizmo` and the grid. One effect re-syncs on any document, selection or mode change. Pointer handling: click → pick, drag past 4 px → box select (window or crossing), hover highlight in component modes; with the Push/Pull or Inset tool, a press on a face starts a `FaceDrag` (Esc cancels); with the Paint tool a click paints (Ctrl: connected, Shift: same material, Alt: sample); the Line, Rectangle and Loop Cut tools are `ViewTool`s that get the pointer and keys (capture phase, before shortcuts) through a `ToolHost` (inference, rays, edge picking over every visible object). Also `setStandardView`, `frameObjects`, `framePoints`, `spawnPoint`, `worldToScreen` |
| `Inference.ts` | `infer(env, {from?, lock?, points?, plane?})` → `Inference {point, kind, label, color, face, objectId, edgeDir?, axis?}`. Priority: endpoint (shape points, then vertices) > midpoint > on edge > on an axis through `from` (within 8 px, grid-snapped distance) > on face (length from `from` snapped) > ground (grid-snapped) or the given plane. A locked direction keeps the point on that line, projecting point inferences onto it. `lineRayParam`, `AXES`, `INFERENCE_COLORS` |
| `ToolOverlay.ts` | Drawn over the model: thick preview lines (`setLines`, `setPath`), dashed guide (`setGuide`), inference marker (`setMarker`), tooltip DOM element (`setTip`) |
| `DrawTools.ts` | `ToolHost`, `ViewTool`, **`LineTool`** (click points; auto-commits when a path crosses a face edge to edge, or a loop closes; arrows lock X/Y/Z, ↓ the inferred edge/axis, Shift holds the current one; typed length or x,y,z offset), **`RectangleTool`** (two corners; in the clicked face's plane, X/Y on level planes, otherwise level × up-the-slope; sizes grid-snapped; typed `w,h` during or after), **`LoopCutTool`** (hover preview at the pointer, grid-snapped along the edge; click cuts; typed n replaces it with n even cuts) |
| `FaceDrag.ts` | `PushPullDrag`, `InsetDrag`, `localFaceHit`. Each pointer move re-runs the op on a fresh copy of the original mesh as a preview (`obj.setMesh`); release restores the original and commits one `ReplaceMeshCommand`. Push/Pull distance = closest approach of the pointer ray to the normal line through the press point; inset amount = pointer travel across the face plane. Both in local space, snapped to the grid step. After release, a typed distance/inset redoes it exactly (`offerReplace`) |
| `SceneSync.ts` | Mirrors the document into Three.js: one group per object (mesh + hard-edge lines + soft-edge lines). Rebuilds geometry only when `meshRev` changes. Keeps a material per document material; X-ray makes faces translucent. Textures: one decoded image per `TextureAsset`, one `THREE.Texture` per material (repeat = 1 / `textureSize`, sRGB, repeat wrapping); a textured material renders white × texture. Images decode asynchronously and call the redraw callback given to the constructor. `pickables`, `meshOf`, `bounds` |
| `meshBuffers.ts` | `buildMeshBuffers(mesh)` (pure, tested): non-indexed positions, normals (flat, smoothed across soft edges via `cornerNormal`), UVs, per-material groups, `triFaces` (triangle → face id), hard and soft edge segments |
| `Picker.ts` | `pickComponent(env, mode, x, y)`, `boxComponents(env, mode, rect, crossing)`, `boxObjects`. Screen-space distance for vertices and edges, raycasting for faces. Occlusion uses jittered rays with a tolerance of a few pixels' world size |
| `ComponentOverlay.ts` | Vertex dots, thick selected/hover edges (`LineSegments2`), translucent face fills. Rebuilt on change |
| `Gizmo.ts` | `TransformControls` on a hidden pivot. Targets are objects or components (`GizmoTargets`). It previews live, and commits `SetTransforms` or `commitVertexMoves` on release. With the Extrude tool the translate gizmo extrudes: each frame re-runs `extrudeMesh` with the local offset and selects the copies; release commits one `ReplaceMeshCommand` per object. Each drag keeps its world-space `delta`; afterwards a typed value replaces it: a distance along the direction moved (or x,y,z), an angle about the same axis through the pivot, or a scale factor on the axes that were scaled (or x,y,z) |
| `transformMath.ts` | `applyTransform`, `transformToMatrix`, `matrixToTransform` (rounds away float noise) |
| `grid.ts`, `AxesIndicator.ts`, `colors.ts` | Ground grid (drawn first without depth writes), corner axes gizmo, palette |

## `ui/` — panels (Preact)
`App` lays out `Toolbar`, `Outliner` and `Properties` (sidebar), `ViewportView` and `StatusBar`.
`fields.tsx` has `TextField`, `NumberField` and `Vec3Field` (commit on Enter or blur, revert on Escape),
plus colour hex helpers. `icons.tsx` has small SVG icons. `Properties.tsx` shows a **Model** section per
component mode (numeric Push/Pull, Extrude, Inset, Subdivide; Connect, Make Face/Hole, Triangulate,
Flip, Recalc Normals), a **UV** section (scale, rotation, offset; Per Face / Box / Planar / Transform) in
face and object modes, and per-tool options (texture lock, inset mode, paint material). In the Outliner,
clicking a material makes it the active (paint) material; its texture (Load…/Clear) and tile size
show below the list.

`StatusBar.tsx`'s measurement box shows the handler's label (Length, Distance, Cuts…) when it
accepts a value, the typed text while typing, and otherwise the value of the operation in progress.

**Important: `useDoc()`.** The document is mutated in place, and `@preact/signals` skips re-rendering
children whose props haven't changed. Every component that displays document data must call
`useDoc()` (which reads `editor.docVersion`) itself. See the JOURNAL entry in M3.

## `io/texture.ts`
`pickImageFile()`, `readTexture(file)` (data URL; images over `MAX_TEXTURE_SIZE` = 2048 px are scaled
down so documents stay small), `loadImage`.

## `io/file.ts`
`newDocument`, `saveDocument(saveAs?)`, `openDocument`. Uses the File System Access API when
available (Save writes back to the same file), otherwise falls back to a download and a file input.
The format is `serializeDocument` JSON, saved as `*.lowpoly.json`.

## Tests and tooling
- `npm test` (Vitest, Node). Tests sit next to their sources as `*.test.ts`. **Also run `npm run typecheck`**: Vitest does not type-check.
- `npm run dev`, or F5 in VS Code (`.vscode/launch.json`, using `serverReadyAction`).
- Browser checks: drive the dev server with Playwright on the real GPU. App modules can be imported in
  the page (`await import('/src/editor/editor.ts')`) to inspect live state.
