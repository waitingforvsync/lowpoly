# Low-Poly Mesh Editor — Plan

A minimalist, browser-based low-poly mesh editor written in TypeScript. UX inspired by SketchUp.

## Decisions

| Topic | Decision |
|---|---|
| Stack | Vite + TypeScript + Three.js (rendering only) + Preact (panels) + Vitest |
| Up axis | **Z-up** everywhere in the document and editor. Convert only at import/export boundaries (glTF/OBJ are Y-up). Three.js renders Z-up directly via `camera.up = (0,0,1)`. |
| Undo | Every document mutation is an undoable command. **Selection changes are not** undo entries, but each command records selection before/after so undo/redo restores a sensible selection. |
| Mesh representation | Compact, serializable **MeshData** for storage and undo snapshots; expanded to a **half-edge mesh** (with face holes) for editing operations. |
| Texturing | Supported from the start: per-face-corner UVs, document-level materials with optional image textures. |
| Shortcuts | SketchUp-flavoured letters, plus `1`–`4` for selection modes. See the [Keyboard shortcuts](#keyboard-shortcuts) section. |

## Architecture

```
src/
  core/
    math/          vec/mat helpers, plane fitting (Newell normal), projection
    meshdata.ts    serializable MeshData types + (de)serialization + validation
    halfedge/      HalfEdgeMesh, Euler operators, queries, validate(), to/from MeshData
    ops/           pure modelling ops working on HalfEdgeMesh (extrude, inset, ...)
    uv/            UV projection (planar, box), texture-lock helpers
    triangulate.ts face (with holes) → triangles, via earcut on the face plane
    document.ts    Document: objects, materials, texture assets
  history/         Command interface, HistoryStack, drag coalescing
  editor/          EditorState (mode, selection, active tool, snap settings),
                   tools/*.ts (one file per interactive tool), snapping, picking
  render/          doc → three.js sync, overlays (verts/edges/highlights), grid, gizmo
  io/              JSON save/load, OBJ(+MTL) import/export, GLB export
  ui/              Toolbar, Outliner, Properties, StatusBar (measurement box)
```

**Main rule:** the Document is plain, serializable data. Every mutation goes through a
Command on the history stack. Tools render live previews while dragging and commit a
single command when you release.

## Mesh data model

### Serialized form: `MeshData`

```ts
type VertId = number; type FaceId = number;

interface Corner { v: VertId; uv: [number, number]; }    // UV stored per face corner
interface FaceData {
  id: FaceId;
  loops: Corner[][];          // loops[0] = outer boundary (CCW about normal), loops[1..] = holes (CW)
  material: MaterialId;
}
interface MeshData {
  verts: { id: VertId; p: [number, number, number] }[];
  faces: FaceData[];
  wireEdges: [VertId, VertId][];   // loose edges not bordering any face (for draw tools)
  nextVertId: number; nextFaceId: number;
}
```

- IDs are stable across conversion, save/load and undo, so selection survives restores.
- Edges are implicit (derived from face loops) apart from wire edges. Edge identity in
  selections = sorted vertex-id pair.
- UV seams are implicit: two corners on the same vertex with different UVs.

### Working form: `HalfEdgeMesh`

```
Vertex   { id, pos, out: HalfEdge[] }                   // unordered outgoing half-edges
HalfEdge { origin: Vertex, twin, next, prev, edge, loop: Loop | null, uv }
Edge     { he }                                         // one per undirected edge
Loop     { face, he }                                   // a boundary cycle of a face
Face     { id, outer: Loop, holes: Loop[], material }
```

- A half-edge with `loop === null` is on the open boundary, or is a wire edge. Such
  half-edges have no `next`/`prev`. Vertex adjacency comes from the per-vertex `out` lists
  instead of boundary cycles. That avoids fragile boundary relinking, and it supports wire
  edges and vertices where separate fans meet. Edges are indexed by vertex pair for O(1) lookup.
- UV lives on the half-edge (= the face corner at its origin vertex).
- Faces own **hole loops**. A hole's half-edges are twins of the half-edges of whatever
  fills the hole: another face, or the open boundary.
- **Strictly planar faces.** Every face (outer loop and holes) lies within a small tolerance of
  its best-fit plane, and `validate` enforces it. Triangulation exists only for rendering and export.
  Edits that bend faces **fold** them into planar pieces (SketchUp-style, `ops/planarize.ts`).
  Moving one corner of a quad folds along the diagonal between that corner's neighbours, and the
  unmoved part keeps its plane. Merging operations (join faces, dissolve vertex, add hole) refuse
  non-coplanar results instead. A bent face with holes is refused. Fold edges are hard.
- **Edge hardness.** Each edge is hard (default: normals split, faceted) or soft (normals
  smoothed across it). This is shading only: soft edges are drawn faintly and stay selectable.
  Serialized as a sparse `softEdges` list in `MeshData`.
- **Manifold constraint:** each edge has at most 2 faces. Import/load splits non-manifold
  edges, and operations validate their results. (SketchUp permits non-manifold geometry. We don't.)
- **Primitive operators** on `HalfEdgeMesh`: `addVertex`, `removeVertex`, `addEdge` (wire),
  `removeEdge`, `addFace(loops)`, `removeFace`. Each checks its preconditions before
  mutating, so a thrown `MeshError` leaves the mesh unchanged.
- **Topological operators** (`halfedge/euler.ts`): `splitEdge`, `splitFace(va, vb)`,
  `joinFaces(edge)`, `addHole(face, corners, {fill})`, `fillHole`, `removeHole`. They rebuild
  the affected faces through `addFace`/`removeFace`, so the one validated primitive does all
  the pointer work, and they roll back fully on failure. Every modelling op is written in
  terms of these.
- `validate(mesh)` checks twin/next/prev consistency, loop closure and orientation, and
  manifoldness. It runs in all unit tests and, in dev builds, after every op.

### Conversion and lifecycle

- `toHalfEdge(MeshData)` and `toMeshData(HalfEdgeMesh)` are O(n) and lossless (IDs, UVs, holes).
- Each object keeps a live `HalfEdgeMesh` in the editor. `MeshData` is produced for
  save, undo snapshots and export. At low-poly sizes the cost doesn't matter.

### Triangulation (render and export)

- Each face is projected onto its best-fit plane (Newell normal) and triangulated with
  earcut, including holes. This handles non-planar n-gons reasonably.
- Render geometry is non-indexed, carries per-corner UVs and flat normals, and has one
  draw group per material.

## Materials and texturing

```ts
interface Material { id; name; color: [r,g,b]; texture?: AssetId; }
interface TextureAsset { id; name; mime; data: string /* base64 */; width; height; }
```

- Materials are document-level. Each face references one, and the default material is plain white.
- Texture images are embedded in the saved JSON for now; a zipped format can come later.
- **UV generation:**
  - Primitives come with sensible UVs (box/cylindrical unwraps).
  - Projection commands for selected faces: **Planar (face normal)**, **Box (world
    axes)**, **Reset**. Each has scale, offset and rotation in the properties panel.
  - **Texture lock (on by default, like SketchUp):** faces created by ops such as
    extrude, push/pull or inset get world-space box-projected UVs that continue
    their neighbours' mapping. That way, pushing a textured face doesn't smear the texture.
- **Paint tool:** applies the active material to clicked faces. Alt+click samples the material under
  the cursor. Ctrl+click paints the connected faces that share the clicked face's material; Shift+click
  every face of the object with that material. Clicking a selected face paints the whole selection.
- **Texture size:** each material has a tile size, the world size of one repeat of its image, since
  UVs are in world units.
- **UV editor panel:** a 2D view of UVs in texture repeats over the tiled texture. Face mode shows
  the selected faces, which can be dragged to move their UVs; other modes show the edited or selected
  objects' faces for reference. Scale and rotation use the UV section's fields.

## Undo / redo

- `Command { label; apply(doc); revert(doc); merge?(next): boolean }`.
- **MeshEditCommand:** stores `before` and `after` `MeshData` snapshots of the affected
  object(s). Simple and robust.
- **Delta commands** for cheap changes: object transform, rename, visibility, material
  properties, and so on.
- **Drags** preview against a scratch copy and commit one command on mouse-up.
  Numeric edits in the measurement box replace the last command when you're still in
  the same tool (SketchUp behaviour).
- Commands record selection before/after for restoring. Selecting alone never creates a
  history entry.
- History is in memory only and is not persisted.

## Viewport

- Ground grid with axes: red = X, green = Y, blue = Z (up).
- Navigation:
  - Middle mouse orbits.
  - Shift+middle pans.
  - The wheel zooms toward the cursor.
  - Toolbar orbit/pan/zoom buttons for trackpads.
- Standard views (Top / Front / Right / Iso), perspective/ortho toggle, Frame Selection.
- Display toggles: wireframe, X-ray, show backfaces, textures on/off.

## Selection

| Mode | Picks | Method |
|---|---|---|
| Object | whole objects | ray vs triangles |
| Vertex | vertices | nearest projected point within N px |
| Edge | edges | nearest projected segment within N px |
| Face | faces | ray vs triangles (maps back to face id) |

- Click to select. Shift adds, Ctrl toggles, Esc clears.
- **Box select:** dragging left→right selects what's fully inside (window). Dragging
  right→left selects anything touched (crossing).
- Commands: select all, none, invert, linked, grow/shrink, edge loop (on quads).
- Hover highlights the item a click would pick. Without X-ray, selection ignores occluded elements.

## Snapping

1. **Grid snap:** step sizes 0.1 / 0.25 / 0.5 / 1, plus a rotation step of 15°. Snap can be toggled, and holding Ctrl flips it temporarily.
2. **Inference snap:** endpoint, midpoint, on edge, on axis (from the last point), on face, with tooltip labels. Used by the Line and Rectangle tools.
3. **Axis lock:** arrow keys lock to X/Y/Z, or Shift locks to the current inference. A coloured guide line shows the locked axis.

## Gizmo

- Move, rotate and scale gizmos with axis, plane and screen-plane handles. The pivot is
  the centre of the selection, in world or local space.
- **First version:** Three.js `TransformControls` attached to a hidden pivot object.
  Its changes are applied to the selected objects or components, using its built-in
  snapping. Replace it with a custom gizmo if it starts to limit us.
- **Measurement box** in the status bar: type a value during or after a move, rotate,
  scale or push/pull to set it exactly.

## Operations

**File**
- New, Open, Save (JSON with embedded textures)
- Autosave to IndexedDB (restored on startup)
- Import OBJ (+MTL and textures; by picking or dropping the files)
- Export OBJ+MTL (zipped with textures) and GLB, of the selection or everything visible

**Edit**
- Undo, Redo
- Delete
- Duplicate
- Select all / none / invert

**Create** (primitives, with UVs)
- Box
- Plane
- Cylinder / prism (n sides)
- Cone
- Icosphere
- Torus

**Transform**
- Move, Rotate, Scale
- Mirror
- Snap selection to grid

**Model** (component modes)
- **Push/Pull:** extrude a face along its normal. Hole walls are created too. SketchUp behaviour:
  a face whose surrounding faces are all perpendicular just moves (the box stretches); walls that
  line up with the face beside them merge into it; pushing a face flat against an opposite face
  cuts a tunnel; a free-standing face becomes a closed solid.
- Extrude vertices, edges or faces along a free direction (the Extrude tool drives the move gizmo).
- **Inset** faces, as a ring of quads (holes are inset as well) or as a hole (SketchUp's Offset).
- **Split edge** (subdivide into n pieces), **Connect** (vertices: split a face; edges: cut in half
  and connect the midpoints).
- **Loop cut** (quad strips).
- **Merge** vertices (at centre / at last selected / by distance).
- **Delete** vs **Dissolve** (vertex, edge or face).
- **Make face** from a closed vertex or edge loop. Make hole: cut a selected inner face out of its surrounding face.
- **Flip normals**, **Recalculate normals** (consistent outward orientation). Both act on whole
  shells, since neighbouring faces always wind consistently.
- **Triangulate**.
- **Bevel** edges (later).

**Object**
- Rename
- Hide / lock
- Join objects
- Separate selection into a new object
- Apply transform, set origin

**UV / Material**
- Assign material
- Project Planar / Box
- Adjust UV offset / scale / rotation
- Texture lock toggle
- Paint tool

**Draw** (SketchUp-style)
- **Line:** closed loops become faces, and a loop drawn inside a face makes a hole or splits the face.
- **Rectangle** on the ground or on a face.

## UI layout

```
┌──────────────────── Toolbar (modes | tools | ops | snap settings) ─────────────────┐
├─ Outliner ─────┬──────────────────────────────────────────────────────────────────┤
│ objects        │                                                                  │
│ materials      │                   3D viewport                                    │
├─ Properties ───┤                                                                  │
│ object xform   │                                                                  │
│ selection/UV   │                                                                  │
│ tool options   │                                                                  │
├────────────────┴──── Status bar: hint | measurement box | counts ─────────────────┤
```

## Milestones

1. **M0 Scaffold:** Vite/TS/Preact/Three.js, panel layout, Z-up grid, camera navigation, static build.
2. **M1 Core data:** MeshData, HalfEdgeMesh with holes, Euler ops, `validate`, conversions,
   triangulation. Full unit tests, built test-first, since every later step depends on it.
3. **M2 Document and history:**
   - Objects, materials, outliner, properties, primitives with UVs.
   - Object-mode selection and gizmo with grid snap.
   - Save/load.
4. **M3 Component editing:** vertex/edge/face modes, picking, overlays, box select, component
   transforms, delete/dissolve/merge.
5. **M4 Modelling ops:** push/pull, extrude, inset, split/connect, make face/hole, flip/recalc
   normals, triangulate. Texture lock (walls continue the neighbouring face's texture).
6. **M5 Materials and texturing:** texture import, paint tool, UV projection commands (per face, box,
   planar, transform), textured rendering, texture display toggle.
7. **M6 SketchUp-style feel:** inference snapping, axis lock, measurement box (typed values for move,
   rotate, scale, extrude, push/pull, inset, line, rectangle, loop cut), line and rectangle tools, loop cut.
8. **M7 I/O and polish:** OBJ import/export, GLB export, autosave, UV editor panel, deploy (GitHub
   Pages on every push to `main`).

## Keyboard shortcuts

| Key | Action |
|---|---|
| `1` / `2` / `3` / `4` | Object / Vertex / Edge / Face selection mode |
| `Space` | Select tool |
| `M` | Move |
| `Q` | Rotate |
| `S` | Scale |
| `P` | Push/Pull |
| `E` | Extrude |
| `I` | Inset |
| `L` | Line tool |
| `R` | Rectangle tool |
| `B` | Paint bucket (Alt+click samples a material) |
| `K` | Loop cut |
| `J` | Connect (vertices: split faces between them; edges: connect their midpoints) |
| `Ctrl+F` | Make face from the selected vertices or edge loop |
| `Ctrl+M` | Merge selected vertices at their centre |
| `Ctrl+Shift+M` | Weld coincident vertices in the selection (merge by distance) |
| `Delete` | Delete selection |
| `Backspace` | Dissolve selection (component modes); delete (object mode) |
| `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) | Undo / Redo |
| `Ctrl+D` | Duplicate |
| `Ctrl+A` / `Ctrl+Shift+A` / `Ctrl+I` | Select all / none / invert |
| `Esc` | Cancel current tool operation / clear selection |
| `Shift` + click / drag | Add to selection |
| `Ctrl` + click / drag | Toggle in selection (click) / remove from selection (drag) |
| `Alt` + click | Select edge loop (edge mode) |
| `F` | Frame selection |
| `Numpad 7 / 1 / 3 / 0` | Top / Front / Right / Iso view |
| `Numpad 5` | Toggle perspective / ortho |
| `X` | Toggle X-ray |
| `W` | Toggle wireframe |
| `G` | Toggle grid snap (hold `Ctrl` to invert temporarily) |
| Arrow keys (Line tool) | Lock to X (→) / Y (←) / Z (↑) axis; ↓ locks to the inferred edge or axis. Same key again unlocks. Hold `Shift` to lock the current inference |
| Digits, `,` `.` `-` then `Enter` | Type a value into the measurement box (when its label shows): length, dimensions, distance, angle, scale, inset or cuts. After an operation, replaces it |
| Middle mouse / Shift+Middle / Wheel | Orbit / Pan / Zoom |
| `Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+O` | Save / Save As / Open. New is on the toolbar (browsers reserve `Ctrl+N`). |
