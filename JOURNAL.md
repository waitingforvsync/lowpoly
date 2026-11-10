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

---

## M4 — Modelling operations

### Decisions
- **Ops that add geometry build `MeshData` and rebuild.** Extrude, inset, flip and the like edit the
  serialized form and go back through `fromMeshData`, which validates everything (manifold
  edges, planarity) and makes the op atomic: it either returns a valid new mesh or throws. Ops that
  only split things (connect, subdivide, make face/hole, triangulate) use the Euler operators in place.
- **Preview by re-running.** Interactive tools (Push/Pull, Inset, the Extrude gizmo) re-run the
  whole operation on a fresh copy of the original mesh at every pointer move, rather than building
  geometry once and moving it. At low-poly sizes it's instant, and the preview is always exactly
  what gets committed, with correct UVs, folds and validation. On release the original mesh
  object is put back and one `ReplaceMeshCommand` records the result.
- **Push/Pull is SketchUp's, not Blender's extrude.** Faces are grouped into coplanar,
  edge-connected groups, each moving along its own normal:
  - *stretch*: if every face around a group is perpendicular to it, its vertices just move (a box
    gets taller or shorter with no new faces; this is also the only sensible result when pushing a
    box top down, where walls would overlap the sides);
  - otherwise extrude, then merge walls into same-facing coplanar neighbours and dissolve the
    straight-through vertices left behind;
  - *push through*: a face pushed flat against an opposite-facing face cuts a hole in it (a tunnel);
  - a free-standing sheet becomes a closed solid (reversed base left behind, flipped if pulled backwards).
- **Extrude reuses the move gizmo.** With the Extrude tool, grabbing the translate gizmo extrudes the
  selection (faces as regions, open/loose edges into quads, vertices into loose edges) and the copies
  follow the gizmo, with its axis constraints and grid snap. The preview selects the copies.
- **Inset has two modes:** a ring of quads (Blender) or a hole (SketchUp's Offset: the old face
  becomes a frame whose hole the inset face fills). Hole mode plus Push/Pull through gives windows
  and tunnels.
- **Orientation is per shell.** The half-edge structure can't represent neighbours with opposite
  winding, so "flip this face" is impossible on its own; Flip and Recalculate act on whole
  edge-connected shells. Recalculate uses the signed volume about the shell's centre, which also
  gives a sensible answer for open shells.
- **Texture lock** (default on): a wall keeps the neighbouring face's UVs along its base edge and
  extends them across the wall at the same texel density, turned 90° so it isn't mirrored. Inset
  corners and cut holes evaluate the face's own fitted affine UV map. Off: walls get a world-space
  planar projection.
- **Commands can set the selection they produce.** `History.execute(cmd, select)` runs `select`
  after applying and records the selection then, so redo restores, for example, the faces an
  extrusion selected. This also fixed the M3 gap where redoing Merge lost its selection.
- `editMeshes` skips edits that change nothing (compared as serialized data), so e.g. Recalculate on
  an already-outward mesh doesn't leave an empty undo step.
- The status bar's measurement box now shows the value of a drag in progress; typing a value is M6.

### Mistakes
- **Inset size check by area sign.** Too large an inset of a square turns it 180° about its
  centre, which keeps the area's sign, so "is the area still positive?" passed. Each inset edge is
  now required to point the same way as the edge it came from.
- **Soft edges referring to vanished edges.** Extrude remapped interior soft edges but also kept
  the originals, some of which no longer existed, and `fromMeshData` rejected them. `rebuild` now
  drops soft-edge entries for edges that aren't there, which keeps every op simple.
- **Test arithmetic.** Two of my first expected values were wrong: edges for an extruded chain
  (counted the shared vertical twice), and expecting Connect on all four corners of a quad to add a
  diagonal (consecutive corners are all adjacent, so there's nothing to connect, as in Blender).
- **Test-script misses, again.** The browser check's gizmo drag twice did nothing: once because the
  pivot was off-screen (the camera was still framed on another object), once because the drag
  snapped to zero (the view was framed so tightly that 60 px was under half a grid step). Logging
  the pivot's projected position (`worldToScreen`, added for this) found both at once.
  *Lesson (repeated from M3): print the screen geometry before assuming the app is broken.*
- The first heredoc-based patch script failed on quoting; script files written with the file tool
  are more reliable for multi-line patches (same lesson as M0's `launch.json`).

---

## M5 — Materials and texturing

### Decisions
- **Textures are embedded as data URLs** in a document-level `textures` list, referenced by id from
  materials. Saving keeps only textures some material uses; unused ones stay in memory so undo can
  bring them back. Images over 2048 px are scaled down on import to keep documents a sensible size.
  The format stays v1: the new fields are optional, so older files load unchanged.
- **Texture scale lives on the material** (`textureSize`, the world size of one image repeat), not in
  the UVs. UVs are already in world units, so a brick texture can be made "0.5 m per tile" once and every
  face using it agrees, including faces created later by modelling ops. Rendering uses one
  `THREE.Texture` per material with `repeat = 1 / textureSize`, sharing one decoded image per asset.
- **A textured material shows its texture untinted.** The colour is still kept and used when there's
  no texture, or when the Textures display toggle is off.
- **Paint follows SketchUp:** click paints a face (or the face selection, if the clicked face is in
  it); Ctrl paints the edge-connected faces sharing the clicked face's material (a fill); Shift paints
  every face of the object with that material (a replace); Alt samples. The active material is
  chosen by clicking it in the outliner, which also shows its texture settings.
- **UV commands:** Per Face (each face on its own plane: no stretch, seams), Box (nearest world axis
  per face: continuous around boxy shapes), Planar (one plane for all: continuous, stretched on
  slopes), and Transform (scale/rotate the current UVs about their centre, then offset). All take
  the same scale/rotation/offset fields. They work on selected faces, or whole objects in object mode.
- **Material property undo uses `null` for "unset"**, so undoing a change to a material that never had
  a texture size leaves it without one, rather than writing the default explicitly.
- **Texture lock now covers Push/Pull's stretch case:** faces that stretch get UVs for their moved
  corners from their own existing mapping, so a pulled-up textured box keeps square tiles instead of
  smearing them. (Walls already continued their neighbour's texture in M4.)

### Mistakes
- **Undo wasn't exact for material properties.** The first version of `SetMaterialPropsCommand`
  captured "before" with defaults filled in, so undo wrote `textureSize: [1, 1]` onto a material that
  never had one. The command round-trip test caught it; fixed with `null` = unset.
- **Signals subscription, again.** The outliner's material details read the active material through
  a helper that uses `peek()`, so clicking a material didn't refresh them. Same lesson as M3's
  `useDoc()`: each component must read (`.value`) the signals it displays itself.
- **Test-script error:** Playwright's `mouse.click` has no `modifiers` option (only `locator.click`
  does), so my Shift-/Alt-clicks were plain clicks and looked like the paint scopes were broken.
  Holding keys with `keyboard.down/up` fixed the script; the app was right.
- **Windows line endings from patch scripts.** Python's text mode wrote CRLF into files I patched in
  M4, which git normalised on commit with warnings. Patch scripts now open files with `newline=''`.

---

## M6 — SketchUp-style feel

### Decisions
- **Inference order:** endpoint > midpoint > on edge > on axis > on face > ground. The points of
  the shape being drawn count as endpoints, so a loop closes by snapping to its start. Edges beat
  axes so lines end on geometry, and axes beat faces because the pointer is almost always over a
  face. Ground points snap to the grid. Along an axis, or across a face from the last point, the
  *length* snaps to the grid step instead, so lines come out at round lengths in any direction.
  Tooltip names and colours follow SketchUp (green endpoint, cyan midpoint, red edge, blue face,
  the axis colour on an axis).
- **Axis lock:** → X, ← Y, ↑ Z, ↓ the edge (parallel) or axis being inferred. Pressing the same key
  again unlocks. Holding Shift locks whatever is inferred and releases on key-up. A locked line
  still takes points from inferences, projected onto it ("as far as that corner").
- **The mesh is manifold, so a Line can't leave loose edges.** Points stay pending until they make
  something. A path that runs from a face's edge to its edge splits the face, and drawing carries
  on from its end. A closed loop inside a face becomes a hole filled by a new face, ready to
  push/pull. One touching the face's edge in two or more places splits it. A closed loop not on
  any face becomes a new one-face "Shape" object. Open points in mid-air simply wait (Esc drops them).
- **`splitFace` takes an optional path** of interior points, rather than a new operator. A straight
  split is the empty path, and the rollback, hole distribution and UV continuation are shared.
- **Rectangles** lie in the plane of the face they start on (level × up-the-slope axes, so walls and
  roofs get sensible rectangles), or on the horizontal plane through the first corner. Sizes snap to
  the grid; typing `w,h` sets them.
- **Measurement box (SketchUp's VCB).** While a tool accepts a value, the box shows its label
  (Length, Dimensions, Distance, Angle, Scale, Inset, Cuts) and typing goes straight to it, with no
  click needed. After an operation, a typed value **replaces** it: undo, then run again with the
  value, so it remains one undo step. The offer lasts while that operation is still the last
  command, and ends on a tool change. If the rerun fails, the original is redone, so nothing is lost.
  Gizmo values reuse the drag's own delta: the direction moved, the rotation axis through the
  pivot, or the axes that were scaled.
- **Typing takes digits from the shortcuts** while a value is accepted (SketchUp does the same). With
  the Line tool mid-shape, or straight after a push/pull, `2` types "2" rather than switching to
  vertex mode. The label beside the box shows when this applies, and once the offer has ended
  (another command, a new tool, Esc on the line) digits go to the shortcuts again.
- **Loop cut** follows the quad ring both ways from the hovered edge. It stops at non-quads and
  boundaries, or closes round a loop. The cut follows the pointer along the edge (grid-snapped by
  distance); typing n replaces it with n even cuts. Ring parameters are measured from a consistent
  end of each edge, which is the step's invariant: "t from this half-edge's origin" equals "t from
  the twin of the opposite side's origin".

### Mistakes
- **Test-script misses, a third time.** Twice the browser check reported broken tools when the
  target point was simply off-screen: the mouse wheel zoomed *in* (toward the cursor), not out, and
  the default framing left `[1,-1,0]` below the window. Printing the projected positions before
  using them found it immediately. The scripts now log "on screen?" for their targets first.
- Three expected values in the new unit tests were wrong rather than the code: `Array.sort()` sorts
  numbers as strings, a "bow-tie" test shape had zero net area so it hit the area check before the
  self-crossing check, and I assumed which end of the edge ring would be "from".
- The loop-cut hover distance first went in the measurement box, under the label "Cuts", which read
  as "0.05 cuts". It moved to the pointer tooltip; the box is for what you can type.
- Heredoc patches with quotes failed again; the file tool remains the reliable way to write patch scripts.
