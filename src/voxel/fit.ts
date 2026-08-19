/**
 * Shape fitting: dress the voxel surface with the game's shaped Block pieces
 * instead of emitting only rectangular slabs.
 *
 * Cell-level heuristics (a cell = one Block volume, 4×4 tiles × 1 y-unit):
 * - Convex plan corners (two perpendicular sides + the diagonal open) become
 *   HalfBlock — the piece whose footprint is the diagonal half of the slab.
 * - Wall tips (three sides open) become QuarterBlock.
 *
 * Slope/ramp pieces are deliberately NOT placed: user preference — builds
 * contain only pieces that sit in material-filled cells. (fitRamp used to
 * smooth single-cell steps with BlockSlopeUp/UpLong in empty cells.)
 *
 * Rotation ground truth: footprints in the game catalog (chunk 2600) pin the
 * plan orientation of HalfBlock/QuarterBlock at rotation 0, and the tile
 * rotation formula (chunk 5494: rot 1 maps [x,z] → [z,−x−1] about Y+) gives
 * the rest.
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
}

/** Choose a shaped piece for every cell of the grid. */
export function fitShapes(grid: VoxelGrid): FitResult {
  const { nx, ny, nz, cells } = grid;
  const idx = (x: number, y: number, z: number) => x + y * nx + z * nx * ny;
  const filled = (x: number, y: number, z: number): boolean =>
    x >= 0 && x < nx && y >= 0 && y < ny && z >= 0 && z < nz && cells[idx(x, y, z)] !== 0;

  const filledParts = new Map<number, FittedCell>();
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (filled(x, y, z)) filledParts.set(idx(x, y, z), fitFilled(x, y, z));
      }
    }
  }
  return { filledParts };

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
}

export const FIT_AXIS = AXIS.YPositive;
