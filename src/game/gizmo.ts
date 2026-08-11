/**
 * In-viewport selection gizmo — the Blender-style orange bounding frame drawn
 * around the parts of a live InsertSession, INSIDE the game's own three.js
 * scene (captured by the renderer mixin, see track.ts).
 *
 * The game doesn't expose the three namespace (`window.__THREE__` is just the
 * revision string three stamps on load), so we can't `new THREE.LineSegments`.
 * Instead we SCAVENGE constructors from the live scene graph: any rendered
 * Mesh gives us its Mesh / BufferGeometry / BufferAttribute constructors and a
 * clonable material. From those we build one mesh containing 12 thin edge
 * cuboids + 8 corner cubes — an unambiguous selection frame that needs no
 * line-rendering classes at all.
 *
 * Geometry topology is constant (20 cuboids × 36 verts), so moving the frame
 * just rewrites the one position attribute in place.
 */
import type { GameRenderer } from './track';

/** Tile-space bounds of the session's parts (inclusive part origins). */
export interface TileBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface Gizmo {
  /** Reposition the frame around `bounds` (part origins, tile space); null hides it. */
  update(bounds: TileBounds | null): void;
  /** Remove the frame from the scene and drop all refs. */
  dispose(): void;
}

/** World units per tile / per y step — the game's `partSize`. */
const PART_SIZE = 5;
/** A Block's 4×4-tile footprint is CENTERED on its origin tile (spans −2..+2 ×5). */
const XZ_HALF_SPAN = 2 * PART_SIZE;
const EDGE_R = 0.5;   // edge cuboid half-thickness (world units)
const CORNER_R = 1.4; // corner cube half-size
const BOXES = 12 + 8;
const FLOATS = BOXES * 36 * 3;

const SELECTION_COLOR = 0xff9822; // Blender's selection orange

// three.js structural slices we rely on (duck-typed — the real classes live
// inside the game bundle).
interface Object3DLike {
  isObject3D?: boolean;
  visible: boolean;
  children?: unknown[];
  renderOrder?: number;
  frustumCulled?: boolean;
  name?: string;
}
interface MeshLike extends Object3DLike {
  isMesh?: boolean;
  geometry?: GeometryLike;
  material?: MaterialLike | MaterialLike[];
}
interface GeometryLike {
  isBufferGeometry?: boolean;
  getAttribute?(name: string): AttributeLike | undefined;
  setAttribute?(name: string, attr: unknown): unknown;
  dispose?(): void;
  attributes?: Record<string, AttributeLike>;
}
interface AttributeLike {
  isBufferAttribute?: boolean;
  array?: unknown;
  needsUpdate?: boolean;
}
interface MaterialLike {
  isMaterial?: boolean;
  clone?(): MaterialLike;
  dispose?(): void;
  color?: { setHex?(hex: number): unknown };
  emissive?: { setHex?(hex: number): unknown };
  map?: unknown;
  transparent?: boolean;
  opacity?: number;
  depthTest?: boolean;
  depthWrite?: boolean;
  fog?: boolean;
  toneMapped?: boolean;
  vertexColors?: boolean;
}

type Ctor<T> = new (...args: never[]) => T;

interface Scavenged {
  Mesh: new (geometry: unknown, material: unknown) => MeshLike;
  BufferGeometry: new () => GeometryLike;
  BufferAttribute: new (array: Float32Array, itemSize: number) => AttributeLike;
  /** The GAME REALM's Float32Array. The mod runs in the portal page; a typed
   *  array allocated with the portal's constructor fails the iframe three.js's
   *  `instanceof Float32Array` check ("Unsupported buffer data format"), so we
   *  must allocate with the game's own — scavenged off the seed attribute. */
  Float32: new (length: number) => Float32Array;
  material: MaterialLike;
}

/**
 * The scene's meshes are usually the game's own InstancedMesh subclasses whose
 * constructors IGNORE the (geometry, material) args and build their own — so
 * walk the seed's prototype chain up to the first constructor that behaves
 * like plain THREE.Mesh: honors both args and isn't instanced. Verified by
 * test-constructing at each level.
 */
function resolvePlainMeshCtor(
  seedCtor: unknown,
  BufferGeometry: Scavenged['BufferGeometry'],
  BufferAttribute: Scavenged['BufferAttribute'],
  Float32: Scavenged['Float32'],
  materialSample: MaterialLike,
): Scavenged['Mesh'] | null {
  let C = seedCtor;
  for (let i = 0; typeof C === 'function' && i < 8; i++) {
    try {
      const g = new BufferGeometry();
      g.setAttribute?.('position', new BufferAttribute(new Float32(9), 3));
      const m = materialSample.clone!();
      const inst = new (C as Scavenged['Mesh'])(g, m) as MeshLike & { isInstancedMesh?: boolean };
      const ok = inst.isMesh === true && !inst.isInstancedMesh && inst.geometry === g && inst.material === m;
      try { g.dispose?.(); m.dispose?.(); } catch { /* test objects */ }
      if (ok) return C as Scavenged['Mesh'];
    } catch { /* this level's ctor needs more args — try its parent */ }
    C = Object.getPrototypeOf(C);
  }
  return null;
}

/** Find a rendered Mesh in the scene and lift the constructors we need off it. */
function scavenge(scene: unknown): Scavenged | null {
  const stack: unknown[] = [scene];
  let guard = 0;
  while (stack.length > 0 && guard++ < 20000) {
    const node = stack.pop() as MeshLike | undefined;
    if (!node || typeof node !== 'object') continue;
    if (node.isMesh && node.geometry?.isBufferGeometry) {
      const geom = node.geometry;
      const pos = geom.getAttribute?.('position') ?? geom.attributes?.position;
      const mat = Array.isArray(node.material) ? node.material[0] : node.material;
      if (pos?.isBufferAttribute && mat?.isMaterial && typeof mat.clone === 'function') {
        try {
          const BufferGeometry = geom.constructor as Ctor<GeometryLike> as Scavenged['BufferGeometry'];
          const BufferAttribute = pos.constructor as Ctor<AttributeLike> as Scavenged['BufferAttribute'];
          const Float32 = (pos.array as { constructor?: unknown })?.constructor as Scavenged['Float32'] | undefined;
          if (typeof Float32 !== 'function') continue;
          const Mesh = resolvePlainMeshCtor(node.constructor, BufferGeometry, BufferAttribute, Float32, mat);
          if (!Mesh) continue;
          return { Mesh, BufferGeometry, BufferAttribute, Float32, material: mat.clone!() };
        } catch { /* odd material — keep looking */ }
      }
    }
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return null;
}

/** Append the 12 triangles (36 verts) of an axis-aligned cuboid. */
function pushBox(
  out: Float32Array, offset: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): number {
  // 8 corners
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ] as const;
  // 12 triangles (two per face), CCW from outside
  const idx = [
    0, 2, 1, 0, 3, 2, // -z
    4, 5, 6, 4, 6, 7, // +z
    0, 1, 5, 0, 5, 4, // -y
    3, 7, 6, 3, 6, 2, // +y
    0, 4, 7, 0, 7, 3, // -x
    1, 2, 6, 1, 6, 5, // +x
  ];
  let o = offset;
  for (const i of idx) {
    const v = c[i]!;
    out[o++] = v[0]; out[o++] = v[1]; out[o++] = v[2];
  }
  return o;
}

/** Rewrite `arr` with the selection frame for world-space bounds. */
function writeFrame(
  arr: Float32Array,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): void {
  let o = 0;
  const X = [x0, x1] as const, Y = [y0, y1] as const, Z = [z0, z1] as const;
  // 4 edges along X (vary y,z corners)
  for (const y of Y) for (const z of Z) {
    o = pushBox(arr, o, x0, y - EDGE_R, z - EDGE_R, x1, y + EDGE_R, z + EDGE_R);
  }
  // 4 edges along Y
  for (const x of X) for (const z of Z) {
    o = pushBox(arr, o, x - EDGE_R, y0, z - EDGE_R, x + EDGE_R, y1, z + EDGE_R);
  }
  // 4 edges along Z
  for (const x of X) for (const y of Y) {
    o = pushBox(arr, o, x - EDGE_R, y - EDGE_R, z0, x + EDGE_R, y + EDGE_R, z1);
  }
  // 8 corner cubes
  for (const x of X) for (const y of Y) for (const z of Z) {
    o = pushBox(arr, o, x - CORNER_R, y - CORNER_R, z - CORNER_R, x + CORNER_R, y + CORNER_R, z + CORNER_R);
  }
}

/** Tile-space part bounds → world-space frame corners. */
function tileToWorld(b: TileBounds): [number, number, number, number, number, number] {
  return [
    b.min[0] * PART_SIZE - XZ_HALF_SPAN,
    b.min[1] * PART_SIZE,
    b.min[2] * PART_SIZE - XZ_HALF_SPAN,
    b.max[0] * PART_SIZE + XZ_HALF_SPAN,
    (b.max[1] + 1) * PART_SIZE,
    b.max[2] * PART_SIZE + XZ_HALF_SPAN,
  ];
}

/**
 * Build a gizmo inside `renderer.scene`, or return null when the scene has
 * nothing to scavenge from yet (empty scene) — callers just skip the gizmo.
 */
export function createGizmo(renderer: GameRenderer): Gizmo | null {
  const parts = scavenge(renderer.scene);
  if (!parts) return null;

  let mesh: MeshLike | null = null;
  let positions: Float32Array | null = null;
  let attr: AttributeLike | null = null;
  let geometry: GeometryLike | null = null;
  const material = parts.material;

  try {
    material.color?.setHex?.(SELECTION_COLOR);
    material.emissive?.setHex?.(SELECTION_COLOR);
    if ('map' in material) material.map = null;
    // The seed geometry carries a color attribute; ours doesn't — vertex
    // colors on would make the shader read a missing attribute.
    material.vertexColors = false;
    material.transparent = true;
    material.opacity = 0.95;
    material.depthTest = false;   // selection frame reads through terrain, like Blender
    material.depthWrite = false;
    material.fog = false;
    material.toneMapped = false;
    (material as { needsUpdate?: boolean }).needsUpdate = true;

    positions = new parts.Float32(FLOATS);
    geometry = new parts.BufferGeometry();
    attr = new parts.BufferAttribute(positions, 3);
    geometry.setAttribute?.('position', attr);
    mesh = new parts.Mesh(geometry, material);
    mesh.name = 'poly-to-track-gizmo';
    mesh.frustumCulled = false;  // we rewrite positions in place; skip stale bounds
    mesh.renderOrder = 9999;
    mesh.visible = false;
    renderer.scene.add(mesh);
  } catch {
    try { material.dispose?.(); } catch { /* best effort */ }
    return null;
  }

  return {
    update(bounds) {
      if (!mesh || !positions || !attr) return;
      if (!bounds) {
        mesh.visible = false;
        return;
      }
      writeFrame(positions, ...tileToWorld(bounds));
      attr.needsUpdate = true;
      mesh.visible = true;
    },
    dispose() {
      if (mesh) {
        try { renderer.scene.remove(mesh); } catch { /* scene already torn down */ }
      }
      try { geometry?.dispose?.(); } catch { /* best effort */ }
      try { material.dispose?.(); } catch { /* best effort */ }
      mesh = null;
      positions = null;
      attr = null;
      geometry = null;
    },
  };
}
