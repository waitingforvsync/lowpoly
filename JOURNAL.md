# Engineering Journal

A running record of design decisions, the reasoning behind them, and mistakes made along the
way (with what they taught). Newest entries at the bottom of each milestone. See
[PLAN.md](PLAN.md) for the roadmap.

---

## M0 — Scaffold (2026-11-09)

### Decisions
- **Vite + TypeScript + Preact + Three.js.** Static build with a relative `base`, so it can be hosted
  from any path. Preact (with signals) for panels; Three.js strictly as a renderer.
- **Z-up throughout.** Three.js renders Z-up directly via `camera.up = (0,0,1)` and
  `Object3D.DEFAULT_UP`. No conversion in the viewport; conversion happens only at Y-up file
  formats (glTF/OBJ) on import/export.
- **OrbitControls with the left button unbound.** Middle orbits, Shift+middle / right pans, the wheel
  zooms to the cursor. The left button is reserved for tools.
- **Render on demand** rather than a continuous loop: `requestRender()` coalesces into one rAF.
- **Strict TS**, including `noUncheckedIndexedAccess`, which pays off in mesh code full of index lookups.

### Mistakes
- **F5 hung on "Waiting for preLaunchTask".** The VS Code background task waited for a
  "ready in" pattern that never matched in the task terminal, most likely because of Vite's colour
  codes, so VS Code waited until it timed out. Replaced it with a `node` launch config that runs Vite
  directly with `NO_COLOR=1` and uses `serverReadyAction` to open the browser when the URL is
  printed. *Lesson: prefer VS Code's built-in server-ready mechanism over hand-written problem matchers.*
- **Misleading headless screenshots.** Under SwiftShader (software GL), any line passing behind
  the camera vanished and an axis drew the wrong colour. Real GPU rendering was correct.
  *Lesson: verify rendering on the hardware GPU before chasing a "bug".*
- **Shell escaping.** A bash heredoc turned `\\s` into `\s` in `launch.json`. Fixed with the
  editor. *Lesson: write files containing backslashes with the file tools, not the shell.*
- A missing favicon caused a 404 console error that the smoke test flagged. Added an inline SVG icon.

---

## M1 — Half-edge mesh core

### Decisions
- **Two representations.** `MeshData` (plain JSON: n-gon faces as loops of `{v, uv}` corners,
  holes as extra loops, wire edges, stable ids) for saving and undo snapshots. `HalfEdgeMesh` for
  editing. Conversion is lossless in both directions, including ids and each loop's starting corner.
- **Per-corner UVs** stored on half-edges, so UV seams need no special handling.
- **No boundary next/prev links.** Half-edges on the open boundary (and wire edges) have
  `loop = null` and no `next`/`prev`. Vertex adjacency comes from an unordered per-vertex `out`
  list instead. The classic design threads boundary cycles, which needs fragile relinking at
  vertices where several separate fans meet, and with wire edges. This sidesteps that entirely.
- **Manifold edges only** (≤ 2 faces per edge). It falls out naturally: `addFace` refuses a
  half-edge that is already used. That check also catches inconsistent winding between neighbours.
- **Primitive operators check everything before mutating**, so a thrown `MeshError` leaves the
  mesh untouched. Higher-level operators (`splitEdge`, `splitFace`, `joinFaces`, holes) *rebuild
  the affected faces* through `addFace`/`removeFace` instead of doing pointer surgery, and roll back
  on failure. Faces are small, so this costs little and keeps all pointer logic in one validated place.
- **`validate()`** checks every invariant. It runs in all tests and, in dev builds, after every command.
- **Triangulation** is earcut on the face's best-fit plane (Newell normal). Triangles are forced to CCW
  about the normal, with a fan fallback for degenerate faces.

### Mistakes
- `fillHole` passed one loop where `addFace` expects a list of loops. Vitest ran it (and failed
  at runtime) because it doesn't type-check. *Lesson: always run `tsc --noEmit` alongside tests.*
- The rollback path was initially untested. Added a test that forces a failure partway through a
  rebuild (`addHole` with a fill id that's already taken).

---

## M2 — Document, history, primitives, object editing

### Decisions
- **Document = plain data mutated only by Commands.** `History` records the selection before
  and after each command and restores it on undo/redo, but selection changes are never entries
  themselves (user decision).
- **Mesh edits snapshot the whole mesh** (`ReplaceMeshCommand` stores before/after `MeshData`).
  Cheap at low-poly sizes and robust. Pure vertex moves later got a lighter `MoveVertsCommand`.
- **Id counters only ever increase.** Undoing an add doesn't roll `nextObjectId` back, so an id
  is never reused while it might still be referenced (e.g. by the redo stack).
- **Live previews, single commit.** Gizmo drags mutate the document directly for the preview,
  put the "before" values back on release, then execute one command. So every drag is one undo
  step and `apply()` always does the real work.
- **Gizmo = Three's `TransformControls` driving a hidden pivot.** The change in the pivot since
  the drag started is applied to every target. That handles multiple objects, local/world space and snapping.
- **Primitives sit on the ground** (origin at the base centre) with **world-unit UVs** (planar
  projection on flat faces, arc length on curved surfaces). They stay parametric (`source`) until edited.
- **Rendering mirrors the document** (`SceneSync`), rebuilding geometry only when an object's
  `meshRev` changes.
- **Ground-plane lines draw first without depth writes**, so geometry resting on z = 0 covers
  the grid instead of z-fighting. The vertical axis depth-tests normally.

### Mistakes
- **Primitives not on the ground.** The torus's tube ring started at the inner equator (no
  vertex at the bottom), and the icosphere had no vertices at the poles. Fixed by starting the
  ring at the bottom, and by rotating the icosahedron so two vertices sit exactly on ±Z.
- A command round-trip test expected the id counters to revert on undo, which contradicts the
  decision above. Fixed the test, not the code.
- Preact 11 renamed its JSX helper types (`JSX.TargetedKeyboardEvent` → `TargetedKeyboardEvent`),
  and its input-attribute type is a complex union. Typed components' props explicitly.
- Hidden objects stayed selected after redo. Moved the "hidden objects can't be selected" rule into
  the editor's after-change hook, so it holds whichever path makes the change.

---

## M3 — Component selection and editing

### Decisions
- **Edit set.** Entering a component mode fixes which objects are being edited: the
  selection, or every visible unlocked object if nothing is selected. Component selections are
  kept per object and per mode, keyed by vertex id, face id or a sorted `"a,b"` edge key.
- **Switching component modes converts the selection.** Going down (faces → edges → vertices)
  takes everything touched; going up keeps only fully selected elements.
- **CPU, screen-space picking.** Vertices and edges by distance to their projection, faces by
  raycasting. Simple, and fast enough for low-poly meshes.
- **Box select is SketchUp-style:** left→right selects what's fully inside (window), right→left
  selects anything touched (crossing). Occlusion applies to components but not to objects.
- **Topology-changing edits run on a clone** of each object's mesh, then go through
  `ReplaceMeshCommand`. A failed edit discards the clone and reports the reason in the status bar.
- **Delete/dissolve/merge semantics follow Blender.** Merge works on `MeshData` (remap ids,
  collapse corners, drop degenerate faces), then rebuilds, so the result is always fully validated.

### Mistakes
- **Dissolving a vertex in the middle of an edge merged the two neighbouring faces.** The
  general fan-merge treated it like any other vertex. Added the special case: a vertex with
  exactly two edges is simply removed from each face's loop.
- **Occluded vertices picked in exactly aligned views.** In a straight top view, the ray to a
  bottom corner only grazes the box edges, so it hit nothing and the corner counted as visible.
  Visibility now also casts rays one pixel to each side, and compares depths with a tolerance of
  a few pixels' world size.
- **Panels didn't update after edits.** `@preact/signals` skips re-rendering a child whose props
  are shallowly unchanged unless the child itself reads a signal that changed. The document is
  mutated in place, so children receiving the same object reference never re-rendered. Fixed with
  a `useDoc()` hook that every document-reading component calls. *Lesson: with in-place
  mutation, each component must subscribe for itself; don't rely on the parent re-rendering.*
- **Test-script errors mistaken for app bugs.** Twice, a scripted gizmo drag missed the gizmo
  because I assumed where it was on screen. Importing the app's own modules in the page
  (`await import('/src/editor/editor.ts')`) to read the true state settled it quickly.
  *Lesson: check state directly before trusting screen-coordinate assumptions.*

---

## Planarity and edge hardness (between M3 and M4)

### Decisions
- **Faces are strictly planar** (user decision; triangulation is only a render/export concern).
  A face is planar when every vertex lies within `1e-5 × max(1, bbox diagonal)` of its best-fit
  plane. `validate()` enforces it.
- **Edits that bend faces fold them** (SketchUp-style, user decision), in `ops/planarize.ts`:
  1. If the unmoved corners (≥ 3) are coplanar, each run of moved corners is cut off with a chord
     between the unmoved corners either side. *Moving one corner of a quad folds along the
     diagonal between that corner's neighbours* (the user's rule), and the unmoved part keeps its
     plane and the face's id.
  2. Else, if the moved corners (≥ 3) are coplanar, the runs of unmoved corners are cut off instead.
  3. Else: triangulate, then greedily merge neighbouring triangles while the union stays planar.
  A bent face with holes is refused. Fold edges are hard.
- **Merging operations refuse rather than fold.** `joinFaces`, `dissolveVertex` and `addHole`
  require coplanarity: folding after a dissolve would just recreate the dissolved edge.
- **Vertex moves commit through one path** (`commitVertexMoves`). It applies the move to a
  clone and folds. With no folds it records a cheap `MoveVertsCommand`; otherwise a
  `ReplaceMeshCommand`. The gizmo preview shows bent faces during the drag, and the fold happens on release.
- **Edge hardness** is an `Edge.hard` flag (default hard, for the faceted look). It's serialized as a
  sparse `softEdges` list and carried through split, unsplit and merge. **Shading only** (user decision):
  corner normals are the angle-weighted average of the faces reachable across soft edges.
  Soft edges are drawn faintly and stay selectable.

### Mistakes
- Faces were originally allowed to be non-planar (projection-based triangulation made it "work").
  The user preferred strictness, and the change made several existing tests produce bent faces.
  Those tests now assert that the operation is refused or folded.
- A fold test raised a cube corner straight up and expected three folds, but straight up keeps the
  vertex in both side planes, so only the top bends. Fixed the test, and kept the case as an assertion.
