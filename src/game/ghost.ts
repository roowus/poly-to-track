/**
 * Ghost preview — the translucent in-viewport model shown while an
 * InsertSession is being positioned (Schematica's ghost). Nothing here touches
 * the track: it is ONE scavenged three.js mesh (see gizmo.ts for the
 * scavenging story) holding a cuboid per staged part, with per-vertex colors
 * matching each part's block color.
 *
 * Moving the session is `mesh.position.set(...)` — O(1) regardless of part
 * count, which is the whole point: the old design re-placed every part through
 * the game's setPart on each keystroke and froze for seconds at high counts.
 * Only rotation / rebuilds rewrite the geometry buffers (a few ms at the cap).
 */
import { COLOR_SWATCHES } from '../codec/parts';
import type { PlacedPart } from '../codec/parts';
import type { GameRenderer } from './track';
import {
  PART_SIZE, XZ_HALF_SPAN, pushBox, scavenge,
  type AttributeLike, type GeometryLike, type MaterialLike, type MeshLike, type Scavenged,
} from './gizmo';

/** Boxes drawn at most — beyond this the MERGED boxes are sampled uniformly.
 *  Keeps the ghost's buffers ~17MB worst case instead of unbounded. Parts are
 *  greedy-merged into cuboids first (see mergeGhostBoxes), so this cap is a
 *  box budget, not a part budget — even million-part solids fit with room to
 *  spare and the ghost shows the FULL geometry, no sampling holes. */
export const MAX_GHOST_BOXES = 20_000;

const FLOATS_PER_BOX = 36 * 3;
const GHOST_OPACITY = 0.55;
/** Part grid spacing: a Block is 4×4 tiles in x/z, 1 unit in y. */
const XZ_STEP = 4;

export interface GhostBoxSpec {
  /** Inclusive part-coordinate extents (tiles x/z, y-units) + color id. */
  x0: number; x1: number; y0: number; y1: number; z0: number; z1: number;
  color: number;
}

/**
 * Greedy-merge parts into axis-aligned cuboids: runs along x, rows merged
 * across z, slabs merged across y — same-color neighbors only, so every
 * merged box is still drawable in one flat color. Solid builds collapse to a
 * handful of slabs and hollow shells to O(surface) boxes, which is what lets
 * `write()` draw full geometry instead of uniformly sampling parts (the old
 * behavior — scaled-up models looked like Swiss cheese past 20k parts).
 */
export function mergeGhostBoxes(parts: readonly PlacedPart[]): GhostBoxSpec[] {
  let boxes: GhostBoxSpec[] = [];
  const sorted = [...parts].sort((a, b) =>
    a.color - b.color || a.y - b.y || a.z - b.z || a.x - b.x);
  // pass 1: runs along x
  for (const p of sorted) {
    const last = boxes[boxes.length - 1];
    if (last && last.color === p.color && last.y0 === p.y && last.z0 === p.z && last.x1 + XZ_STEP === p.x) {
      last.x1 = p.x;
    } else {
      boxes.push({ x0: p.x, x1: p.x, y0: p.y, y1: p.y, z0: p.z, z1: p.z, color: p.color });
    }
  }
  // pass 2: identical x-runs merged across z
  boxes.sort((a, b) => a.color - b.color || a.y0 - b.y0 || a.x0 - b.x0 || a.x1 - b.x1 || a.z0 - b.z0);
  boxes = mergeAdjacent(boxes, (a, b) =>
    a.color === b.color && a.y0 === b.y0 && a.x0 === b.x0 && a.x1 === b.x1 && a.z1 + XZ_STEP === b.z0,
  (a, b) => { a.z1 = b.z1; });
  // pass 3: identical x/z rectangles merged across y
  boxes.sort((a, b) => a.color - b.color || a.x0 - b.x0 || a.x1 - b.x1 ||
    a.z0 - b.z0 || a.z1 - b.z1 || a.y0 - b.y0);
  boxes = mergeAdjacent(boxes, (a, b) =>
    a.color === b.color && a.x0 === b.x0 && a.x1 === b.x1 &&
    a.z0 === b.z0 && a.z1 === b.z1 && a.y1 + 1 === b.y0,
  (a, b) => { a.y1 = b.y1; });
  return boxes;
}

function mergeAdjacent(
  sorted: GhostBoxSpec[],
  canMerge: (a: GhostBoxSpec, b: GhostBoxSpec) => boolean,
  merge: (a: GhostBoxSpec, b: GhostBoxSpec) => void,
): GhostBoxSpec[] {
  const out: GhostBoxSpec[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && canMerge(last, b)) merge(last, b);
    else out.push(b);
  }
  return out;
}

export interface Ghost {
  /** Move the whole ghost to the session offset (tiles / y-units). O(1). */
  setOffset(x: number, y: number, z: number): void;
  /** Swap the drawn parts (rotation / scale / resolution change). O(n). */
  setParts(parts: readonly PlacedPart[]): void;
  /** Remove from the scene and free the buffers. */
  dispose(): void;
}

const hexById = new Map<number, number>(
  COLOR_SWATCHES.map((s) => [s.id, parseInt(s.hex.slice(1), 16)]),
);

/**
 * Build a ghost for `parts` inside the captured renderer's scene, or null when
 * the scene has nothing to scavenge from (callers fall back to no preview —
 * the session still works, the panel stats still track it).
 */
export function createGhost(renderer: GameRenderer, parts: readonly PlacedPart[]): Ghost | null {
  const kit = scavenge(renderer.scene);
  if (!kit) return null;

  let mesh: MeshLike | null = null;
  let geometry: GeometryLike | null = null;
  let capacity = 0;
  let disposed = false;
  const material: MaterialLike = kit.material;

  try {
    // White base × vertex colors = each box shows its part's block color.
    material.color?.setHex?.(0xffffff);
    material.emissive?.setHex?.(0x222222); // slight glow so dark colors read as "ghost"
    if ('map' in material) material.map = null;
    material.vertexColors = true;
    material.transparent = true;
    material.opacity = GHOST_OPACITY;
    material.depthWrite = false; // translucent — don't occlude the real track
    material.fog = false;
    (material as { needsUpdate?: boolean }).needsUpdate = true;
  } catch {
    try { material.dispose?.(); } catch { /* best effort */ }
    return null;
  }

  /** (Re)build the mesh with capacity for `boxes` cuboids. */
  function ensureCapacity(kitRef: Scavenged, boxes: number): { pos: Float32Array; col: Float32Array; posAttr: AttributeLike; colAttr: AttributeLike } | null {
    if (mesh && capacity >= boxes && capacity <= boxes * 4) {
      const g = geometry!;
      const posAttr = g.getAttribute?.('position') ?? g.attributes?.position;
      const colAttr = g.getAttribute?.('color') ?? g.attributes?.color;
      if (posAttr?.array instanceof Object && colAttr?.array instanceof Object) {
        return { pos: posAttr.array as Float32Array, col: colAttr.array as Float32Array, posAttr, colAttr };
      }
    }
    // Tear down the old mesh (if any) and build at the new capacity.
    if (mesh) {
      try { renderer.scene.remove(mesh); } catch { /* scene torn down */ }
      try { geometry?.dispose?.(); } catch { /* best effort */ }
      mesh = null;
      geometry = null;
    }
    try {
      capacity = boxes;
      const pos = new kitRef.Float32(boxes * FLOATS_PER_BOX);
      const col = new kitRef.Float32(boxes * FLOATS_PER_BOX);
      geometry = new kitRef.BufferGeometry();
      const posAttr = new kitRef.BufferAttribute(pos, 3);
      const colAttr = new kitRef.BufferAttribute(col, 3);
      geometry.setAttribute?.('position', posAttr);
      geometry.setAttribute?.('color', colAttr);
      mesh = new kitRef.Mesh(geometry, material);
      mesh.name = 'poly-to-track-ghost';
      mesh.frustumCulled = false; // positions are rewritten in place
      mesh.renderOrder = 9998;    // under the selection frame
      renderer.scene.add(mesh);
      return { pos, col, posAttr, colAttr };
    } catch {
      return null;
    }
  }

  function write(list: readonly PlacedPart[]): void {
    if (disposed) return;
    const merged = mergeGhostBoxes(list);
    // Merging normally lands FAR under the cap (solids collapse to slabs);
    // uniform sampling only kicks in on pathological checkerboards.
    const step = Math.max(1, Math.ceil(merged.length / MAX_GHOST_BOXES));
    const boxes = Math.ceil(merged.length / step);
    const buf = ensureCapacity(kit!, Math.max(1, boxes));
    if (!buf) return;
    let o = 0;
    for (let i = 0; i < merged.length; i += step) {
      const m = merged[i]!;
      const co = o;
      o = pushBox(
        buf.pos, o,
        m.x0 * PART_SIZE - XZ_HALF_SPAN, m.y0 * PART_SIZE, m.z0 * PART_SIZE - XZ_HALF_SPAN,
        m.x1 * PART_SIZE + XZ_HALF_SPAN, (m.y1 + 1) * PART_SIZE, m.z1 * PART_SIZE + XZ_HALF_SPAN,
      );
      const hex = hexById.get(m.color) ?? 0xb8b8b8;
      // Lift toward white so even the near-black game palette reads on screen.
      const r = Math.min(1, ((hex >> 16) & 255) / 255 + 0.25);
      const g = Math.min(1, ((hex >> 8) & 255) / 255 + 0.25);
      const b = Math.min(1, (hex & 255) / 255 + 0.25);
      for (let v = co; v < o; v += 3) {
        buf.col[v] = r; buf.col[v + 1] = g; buf.col[v + 2] = b;
      }
    }
    // Unused tail (capacity > boxes) collapses to degenerate zero-area tris.
    buf.pos.fill(0, o);
    buf.posAttr.needsUpdate = true;
    buf.colAttr.needsUpdate = true;
    if (mesh) mesh.visible = list.length > 0;
  }

  write(parts);
  if (!mesh) {
    try { material.dispose?.(); } catch { /* best effort */ }
    return null;
  }

  return {
    setOffset(x, y, z) {
      mesh?.position?.set(x * PART_SIZE, y * PART_SIZE, z * PART_SIZE);
    },
    setParts(next) {
      write(next);
    },
    dispose() {
      disposed = true;
      if (mesh) {
        try { renderer.scene.remove(mesh); } catch { /* scene already torn down */ }
      }
      try { geometry?.dispose?.(); } catch { /* best effort */ }
      try { material.dispose?.(); } catch { /* best effort */ }
      mesh = null;
      geometry = null;
    },
  };
}
