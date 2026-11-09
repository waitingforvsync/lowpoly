import type { FaceId, MaterialId, VertId } from '../meshdata';
import { newellNormal, normalize, type ReadonlyVec2, type ReadonlyVec3, type Vec2, type Vec3 } from '../math/vec';

/**
 * Half-edge mesh used for editing operations.
 *
 * Design notes:
 * - Every undirected Edge owns two HalfEdges (`he` and `he.twin`) pointing in opposite directions.
 * - A HalfEdge that belongs to a face loop has `loop`, `next` and `prev` set. A half-edge on the
 *   open boundary (or either half of a wire edge) has `loop === null` and no next/prev.
 * - Faces own an outer loop (CCW about the face normal) plus any number of hole loops (CW).
 * - Each vertex keeps an unordered list of its outgoing half-edges. This avoids the fragile
 *   boundary-cycle relinking of the classic structure, and supports wire edges and vertices
 *   where several separate fans meet.
 * - Manifold edges only: each half-edge is used by at most one face, so an edge borders at most
 *   two faces, and adjacent faces always have consistent orientation.
 * - A UV lives on the half-edge: it is the UV of the face corner at the half-edge's origin.
 */

export class MeshError extends Error {
  override name = 'MeshError';
}

export class Vertex {
  /** Outgoing half-edges, unordered. */
  readonly out: HalfEdge[] = [];
  constructor(
    readonly id: VertId,
    public pos: Vec3,
  ) {}
}

export class HalfEdge {
  twin!: HalfEdge;
  edge!: Edge;
  next: HalfEdge | null = null;
  prev: HalfEdge | null = null;
  loop: Loop | null = null;
  uv: Vec2 = [0, 0];

  constructor(public origin: Vertex) {}

  get dest(): Vertex {
    return this.twin.origin;
  }

  get face(): Face | null {
    return this.loop?.face ?? null;
  }

  get isBoundary(): boolean {
    return this.loop === null;
  }
}

export class Edge {
  /**
   * Shading hardness. Hard edges split normals (a crease); soft edges smooth normals across
   * them. Hard is the default, for the faceted low-poly look.
   */
  hard = true;

  constructor(public he: HalfEdge) {}

  get verts(): [Vertex, Vertex] {
    return [this.he.origin, this.he.twin.origin];
  }

  /** Faces on either side (0, 1 or 2). */
  faces(): Face[] {
    const result: Face[] = [];
    const a = this.he.face;
    const b = this.he.twin.face;
    if (a) result.push(a);
    if (b && b !== a) result.push(b);
    return result;
  }

  /** Neither side has a face. */
  get isWire(): boolean {
    return this.he.isBoundary && this.he.twin.isBoundary;
  }

  /** Exactly one side has a face. */
  get isBoundary(): boolean {
    return this.he.isBoundary !== this.he.twin.isBoundary;
  }
}

export class Loop {
  constructor(
    public face: Face,
    public he: HalfEdge,
  ) {}

  *halfEdges(): Generator<HalfEdge> {
    let h = this.he;
    do {
      yield h;
      h = h.next!;
    } while (h !== this.he);
  }

  verts(): Vertex[] {
    return Array.from(this.halfEdges(), (h) => h.origin);
  }

  positions(): Vec3[] {
    return Array.from(this.halfEdges(), (h) => h.origin.pos);
  }

  get isHole(): boolean {
    return this.face.outer !== this;
  }
}

export class Face {
  outer!: Loop;
  holes: Loop[] = [];

  constructor(
    readonly id: FaceId,
    public material: MaterialId,
  ) {}

  get loops(): Loop[] {
    return [this.outer, ...this.holes];
  }

  *halfEdges(): Generator<HalfEdge> {
    for (const loop of this.loops) yield* loop.halfEdges();
  }

  /** Unit normal from the outer loop (Newell's method). Zero vector for degenerate faces. */
  normal(): Vec3 {
    return normalize(newellNormal(this.outer.positions()));
  }
}

/** A face corner given to `addFace`. */
export interface CornerInput {
  v: Vertex;
  uv?: ReadonlyVec2;
}

export interface RemoveFaceOptions {
  /** Also remove edges left with no face on either side. */
  removeWireEdges?: boolean;
  /** Also remove vertices left with no edges. */
  removeIsolatedVerts?: boolean;
}

export function edgeKey(a: VertId, b: VertId): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

export class HalfEdgeMesh {
  readonly verts = new Map<VertId, Vertex>();
  readonly faces = new Map<FaceId, Face>();
  private readonly edgeMap = new Map<string, Edge>();
  nextVertId: VertId = 0;
  nextFaceId: FaceId = 0;

  edges(): IterableIterator<Edge> {
    return this.edgeMap.values();
  }

  get edgeCount(): number {
    return this.edgeMap.size;
  }

  findEdge(a: Vertex, b: Vertex): Edge | undefined {
    return this.edgeMap.get(edgeKey(a.id, b.id));
  }

  /** The half-edge running from a to b, if the edge exists. */
  findHalfEdge(a: Vertex, b: Vertex): HalfEdge | undefined {
    const e = this.findEdge(a, b);
    if (!e) return undefined;
    return e.he.origin === a ? e.he : e.he.twin;
  }

  /** Lookup by edge key, used to check that `validate` agrees with the edge index. */
  edgeByKey(key: string): Edge | undefined {
    return this.edgeMap.get(key);
  }

  vertex(id: VertId): Vertex {
    const v = this.verts.get(id);
    if (!v) throw new MeshError(`No vertex with id ${id}`);
    return v;
  }

  face(id: FaceId): Face {
    const f = this.faces.get(id);
    if (!f) throw new MeshError(`No face with id ${id}`);
    return f;
  }

  // ---------------------------------------------------------------------------------------------
  // Primitive operators. Each one validates its preconditions before mutating anything, so a
  // thrown MeshError always leaves the mesh unchanged.
  // ---------------------------------------------------------------------------------------------

  addVertex(pos: ReadonlyVec3, id: VertId = this.nextVertId): Vertex {
    if (this.verts.has(id)) throw new MeshError(`Vertex id ${id} already in use`);
    const v = new Vertex(id, [pos[0], pos[1], pos[2]]);
    this.verts.set(id, v);
    this.nextVertId = Math.max(this.nextVertId, id + 1);
    return v;
  }

  removeVertex(v: Vertex): void {
    this.assertOwnVertex(v);
    if (v.out.length > 0) throw new MeshError(`Vertex ${v.id} still has ${v.out.length} edge(s)`);
    this.verts.delete(v.id);
  }

  /** Add a wire edge between two vertices. */
  addEdge(a: Vertex, b: Vertex): Edge {
    this.assertOwnVertex(a);
    this.assertOwnVertex(b);
    if (a === b) throw new MeshError(`Cannot add an edge from vertex ${a.id} to itself`);
    if (this.findEdge(a, b)) throw new MeshError(`Edge ${a.id}-${b.id} already exists`);
    return this.createEdge(a, b);
  }

  /** Remove an edge that has no face on either side. */
  removeEdge(e: Edge): void {
    if (this.edgeMap.get(edgeKey(e.he.origin.id, e.he.dest.id)) !== e) {
      throw new MeshError('Edge does not belong to this mesh');
    }
    if (!e.isWire) throw new MeshError(`Edge ${e.he.origin.id}-${e.he.dest.id} still borders a face`);
    removeFromArray(e.he.origin.out, e.he);
    removeFromArray(e.he.twin.origin.out, e.he.twin);
    this.edgeMap.delete(edgeKey(e.he.origin.id, e.he.dest.id));
  }

  /**
   * Add a face. `loops[0]` is the outer boundary (CCW about the intended normal), and any further
   * loops are holes (CW). Missing edges are created. Existing edges must have the matching
   * half-edge free; otherwise the face would be non-manifold or oppositely oriented to its neighbour.
   */
  addFace(loops: readonly (readonly CornerInput[])[], material: MaterialId = 0, id: FaceId = this.nextFaceId): Face {
    if (this.faces.has(id)) throw new MeshError(`Face id ${id} already in use`);
    if (loops.length === 0) throw new MeshError('A face needs at least one loop');

    const seen = new Set<Vertex>();
    for (const loop of loops) {
      if (loop.length < 3) throw new MeshError(`Face loops need at least 3 corners (got ${loop.length})`);
      for (const c of loop) {
        this.assertOwnVertex(c.v);
        if (seen.has(c.v)) throw new MeshError(`Vertex ${c.v.id} appears more than once in face ${id}`);
        seen.add(c.v);
      }
    }
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i]!.v;
        const b = loop[(i + 1) % loop.length]!.v;
        const h = this.findHalfEdge(a, b);
        if (h && h.loop) {
          throw new MeshError(
            `Half-edge ${a.id}->${b.id} is already used by face ${h.loop.face.id} ` +
              '(non-manifold edge or inconsistent orientation)',
          );
        }
      }
    }

    // All checks passed: mutate.
    const face = new Face(id, material);
    loops.forEach((loopInput, li) => {
      const hes: HalfEdge[] = loopInput.map((c, i) => {
        const a = c.v;
        const b = loopInput[(i + 1) % loopInput.length]!.v;
        return this.findHalfEdge(a, b) ?? this.createEdge(a, b).he;
      });
      const loop = new Loop(face, hes[0]!);
      hes.forEach((h, i) => {
        h.loop = loop;
        h.next = hes[(i + 1) % hes.length]!;
        h.prev = hes[(i + hes.length - 1) % hes.length]!;
        const uv = loopInput[i]!.uv;
        h.uv = uv ? [uv[0], uv[1]] : [0, 0];
      });
      if (li === 0) face.outer = loop;
      else face.holes.push(loop);
    });
    this.faces.set(id, face);
    this.nextFaceId = Math.max(this.nextFaceId, id + 1);
    return face;
  }

  /** Remove a face. Its edges remain (as boundary or wire edges) unless asked otherwise. */
  removeFace(face: Face, opts: RemoveFaceOptions = {}): void {
    if (this.faces.get(face.id) !== face) throw new MeshError(`Face ${face.id} does not belong to this mesh`);
    const hes = Array.from(face.halfEdges());
    for (const h of hes) {
      h.loop = null;
      h.next = null;
      h.prev = null;
      h.uv = [0, 0];
    }
    this.faces.delete(face.id);

    if (opts.removeWireEdges) {
      for (const h of hes) {
        if (h.edge.isWire && this.edgeMap.get(edgeKey(h.origin.id, h.dest.id)) === h.edge) {
          this.removeEdge(h.edge);
        }
      }
    }
    if (opts.removeIsolatedVerts) {
      for (const h of hes) {
        if (h.origin.out.length === 0 && this.verts.get(h.origin.id) === h.origin) this.removeVertex(h.origin);
      }
    }
  }

  private createEdge(a: Vertex, b: Vertex): Edge {
    const h = new HalfEdge(a);
    const t = new HalfEdge(b);
    h.twin = t;
    t.twin = h;
    const e = new Edge(h);
    h.edge = e;
    t.edge = e;
    a.out.push(h);
    b.out.push(t);
    this.edgeMap.set(edgeKey(a.id, b.id), e);
    return e;
  }

  private assertOwnVertex(v: Vertex): void {
    if (this.verts.get(v.id) !== v) throw new MeshError(`Vertex ${v.id} does not belong to this mesh`);
  }
}

function removeFromArray<T>(arr: T[], item: T): void {
  const i = arr.indexOf(item);
  if (i >= 0) arr.splice(i, 1);
}
