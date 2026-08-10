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
 * VISUALLY CALIBRATED (not derivable from footprints): rotation that makes
 * BlockSlopeUp ascend toward DIRS[i]. If a play-test shows ramps facing the
 * wrong way, fix this one table.
 */
const SLOPE_UP_ROT = [1, 0, 3, 2] as const;

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
    // between them — keep the opposite triangle.
    if (openCount === 2) {
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        if (open[i] && open[j]) {
          const ox = DIRS[i]!.dx + DIRS[j]!.dx; // toward the open corner
          const oz = DIRS[i]!.dz + DIRS[j]!.dz;
          if (!filled(x + ox, y, z + oz)) {
            const rot = HALF_BLOCK_ROT[`${-ox},${-oz}`];
            if (rot !== undefined) return { partId: PART.HalfBlock, rotation: rot };
          }
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
    return { partId: PART.BlockSlopeUp, rotation: SLOPE_UP_ROT[dir]! };
  }
}

export const FIT_AXIS = AXIS.YPositive;
