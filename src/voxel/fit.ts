/**
 * Shape fitting: dress the voxel surface with the game's shaped Block pieces
 * instead of emitting only rectangular slabs.
 *
 * Cell-level heuristics (a cell = one Block volume, 4×4 tiles × 1 y-unit):
 * - Convex plan corners (two perpendicular sides + the diagonal open) become
 *   HalfBlock — the piece whose footprint is the diagonal half of the slab.
 * - Wall tips (three sides open) become QuarterBlock.
 * - Single-cell steps get a BlockSlopeUp ramp in the empty cell above the
 *   lower run, ascending toward the higher run — Minecraft-stairs smoothing.
 *
 * Rotation ground truth: footprints in the game catalog (chunk 2600) pin the
 * plan orientation of HalfBlock/QuarterBlock at rotation 0, and the tile
 * rotation formula (chunk 5494: rot 1 maps [x,z] → [z,−x−1] about Y+) gives
 * the rest. Slope pieces have a full 4×4 footprint so their ramp direction
 * is NOT derivable from data — SLOPE_UP_ROT below is calibrated visually.
 */
import { AXIS, PART, type PlacedPart } from '../codec/parts';
import type { VoxelGrid } from './voxelize';

/** Horizontal neighbor directions, in rotation order (+x, +z, −x, −z). */
const DIRS = [
  { dx: 1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: -1 },
] as const;

/**
 * HalfBlock at rotation 0 keeps the (−x,+z) triangle (footprint rows: z=+1
 * full, tapering to a single tile at x=−2,z=−2 — the diagonal faces +x/−z).
 * Rotating by 1 turns direction (dx,dz) into (dz,−dx), so the kept corner
 * cycles (−1,1) → (1,1) → (1,−1) → (−1,−1).
 * Index by kept-corner as `cornerKey(kx, kz)`.
 */
const HALF_BLOCK_ROT: Record<string, number> = {
  '-1,1': 0,
  '1,1': 1,
  '1,-1': 2,
  '-1,-1': 3,
};

/**
 * QuarterBlock at rotation 0 hugs the −x edge (x=−2 column full, tapering
 * toward +x). Kept-edge direction cycles (−1,0) → (0,1) → (1,0) → (0,−1).
 * Index by the DIRS index of the single filled (kept) neighbor.
 */
const QUARTER_BLOCK_ROT = [2, 3, 0, 1] as const; // filled dir +x → keep +x edge → rot 2, etc.

/**
 * Rotation that makes BlockSlopeUp ascend toward DIRS[i]. DERIVED from the
 * catalog (chunk 2600): BlockSlopeUpLong keeps its y=1 occupancy at z=−6..−4
 * of a footprint spanning z=−6..1 — the ramp ascends toward −z at rotation 0,
 * i.e. DIRS[3]. The tile rotation (dx,dz)→(dz,−dx) about Y+ then gives
 * ascend-direction → rotation: [+x→? …] as indexed below. (The previous
 * visually-calibrated [1,0,3,2] was 180° off for every direction — the
 * "curved ramp constantly placed 180° offset" report.)
 */
const SLOPE_UP_ROT = [3, 2, 1, 0] as const;

/**
 * BlockSlopeUpLong (151) shares BlockSlopeUp's ascend direction at rotation 0
 * (top layer toward −z), so the same rotation table applies. Its base spans a
 * SECOND cell beyond the anchor: the anchor is the LOW cell and the extension
 * (toward the ascend direction) is the HIGH cell — a 2-cell ramp rising one
 * unit, half as steep as BlockSlopeUp. It replaces the steep 1-cell ramp when
 * the terrain genuinely descends gently: the cell beyond the step's high run
 * is open at step level AND open one level above it (a sheer drop would clip
 * the long ramp's tail).
 */
const SLOPE_LONG_PART = 151;

/**
 * BlockOuterCorner (188) rounds a convex corner: rotation 0 keeps an L solid
 * toward +x/+z (the diagonal quadrant at (−x,−z) is cut). For a corner whose
 * OPEN diagonal quadrant is (ox,oz), rotate the CUT to face it:
 * (dx,dz)→(dz,−dx) rotates (−1,−1)→(−1,1)→(1,1)→(1,−1).
 */
const OUTER_CORNER_ROT: Record<string, number> = {
  '-1,-1': 0,
  '-1,1': 1,
  '1,1': 2,
  '1,-1': 3,
};

/**
 * BlockInnerCorner (155) fills a concave step: rotation 0 keeps the −x and
 * −z edges full (solid L meeting at (−2,−2), stepping toward (+1,+1)).
 */
const INNER_CORNER_ROT: Record<string, number> = {
  '-1,-1': 0,
  '-1,1': 1,
  '1,1': 2,
  '1,-1': 3,
};

export interface FittedCell {
  readonly partId: number;
  readonly rotation: number;
}

export interface FitResult {
  /** partId+rotation per filled cell, keyed x + y*nx + z*nx*ny. */
  readonly filledParts: Map<number, FittedCell>;
  /** Ramp pieces added in EMPTY cells (same key space). */
  readonly rampParts: Map<number, FittedCell>;
}

/** Choose a shaped piece for every cell of the grid. */
export function fitShapes(grid: VoxelGrid): FitResult {
  const { nx, ny, nz, cells } = grid;
  const idx = (x: number, y: number, z: number) => x + y * nx + z * nx * ny;
  const filled = (x: number, y: number, z: number): boolean =>
    x >= 0 && x < nx && y >= 0 && y < ny && z >= 0 && z < nz && cells[idx(x, y, z)] !== 0;

  const filledParts = new Map<number, FittedCell>();
  const rampParts = new Map<number, FittedCell>();

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (filled(x, y, z)) {
          filledParts.set(idx(x, y, z), fitFilled(x, y, z));
        } else {
          const ramp = fitRamp(x, y, z);
          if (ramp) rampParts.set(idx(x, y, z), ramp);
        }
      }
    }
  }
  return { filledParts, rampParts };

  function fitFilled(x: number, y: number, z: number): FittedCell {
    const open = DIRS.map((d) => !filled(x + d.dx, y, z + d.dz));
    const openCount = open.filter(Boolean).length;

    // Wall tip: three open sides — keep a quarter wedge facing the run.
    if (openCount === 3) {
      const keep = open.indexOf(false);
      return { partId: PART.QuarterBlock, rotation: QUARTER_BLOCK_ROT[keep]! };
    }

    // Convex corner: two perpendicular open sides and an open diagonal
    // between them. A true 90° corner gets the rounded OuterCorner piece
    // (only the corner cell is diagonally cut — sides stay flush) when the
    // run continues past it; otherwise the diagonal HalfBlock.
    if (openCount === 2) {
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        if (open[i] && open[j]) {
          const ox = DIRS[i]!.dx + DIRS[j]!.dx; // toward the open corner
          const oz = DIRS[i]!.dz + DIRS[j]!.dz;
          if (!filled(x + ox, y, z + oz)) {
            const half = HALF_BLOCK_ROT[`${-ox},${-oz}`];
            if (half === undefined) break;
            // OuterCorner keeps both side edges flush — the two neighbors
            // BEYOND the corner along each side must be material, else the
            // rounded cut would eat volume the silhouette needs.
            const i2 = (i + 2) % 4; // continue past the filled side opposite open[i]
            const j2 = (j + 2) % 4;
            const sideA = filled(x + DIRS[i2]!.dx, y, z + DIRS[i2]!.dz);
            const sideB = filled(x + DIRS[j2]!.dx, y, z + DIRS[j2]!.dz);
            if (sideA && sideB) {
              return { partId: PART.OuterCorner, rotation: OUTER_CORNER_ROT[`${ox},${oz}`]! };
            }
            return { partId: PART.HalfBlock, rotation: half };
          }
        }
      }
    }

    // Concave step (one open side, the diagonal across it open, the
    // diagonal beside it filled): the InnerCorner piece fills the notch.
    if (openCount === 1) {
      const i = open.indexOf(true);
      const ox = DIRS[i]!.dx, oz = DIRS[i]!.dz; // toward the open side
      for (const [ax, az] of [[oz, -ox], [-oz, ox]] as const) { // the two diagonals across the open side
        if (filled(x + ax, y, z + az) && !filled(x + ax - ox, y, z + az - oz)) {
          // filled diagonal neighbor whose side neighbor toward us is open:
          // this cell is the inner corner of an L-step.
          const rot = INNER_CORNER_ROT[`${-ax + ox},${-az + oz}`];
          if (rot !== undefined) return { partId: PART.InnerCorner, rotation: rot };
        }
      }
    }

    return { partId: PART.Block, rotation: 0 };
  }

  function fitRamp(x: number, y: number, z: number): FittedCell | null {
    // Empty cell resting on material, open above, exactly one filled
    // horizontal neighbor: a single step — smooth it with an ascending ramp.
    if (!filled(x, y - 1, z) || filled(x, y + 1, z)) return null;
    let dir = -1;
    for (let i = 0; i < 4; i++) {
      if (filled(x + DIRS[i]!.dx, y, z + DIRS[i]!.dz)) {
        if (dir !== -1) return null;
        dir = i;
      }
    }
    if (dir === -1) return null;
    const rot = SLOPE_UP_ROT[dir]!;

    // Gentle terrain: the long ramp (151) shares the steep ramp's anchor
    // cell and ascend rotation, but its base extends one cell BACKWARD
    // (away from the rise), halving the surface slope. Use it whenever that
    // backward cell is open air above terrain — the tail needs the space and
    // rests on it. Otherwise the terrain is sheer behind the gap (a ledge,
    // a corner) and the steep ramp is the correct piece.
    const d = DIRS[dir]!;
    const backX = x - d.dx, backZ = z - d.dz;
    if (
      !filled(backX, y, backZ) && !filled(backX, y + 1, backZ)
      && filled(backX, y - 1, backZ)
    ) {
      return { partId: SLOPE_LONG_PART, rotation: rot };
    }
    return { partId: PART.BlockSlopeUp, rotation: rot };
  }
}

export const FIT_AXIS = AXIS.YPositive;
