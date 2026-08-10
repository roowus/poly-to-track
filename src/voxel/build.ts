/**
 * Voxel grid → PolyTrack part list.
 *
 * One filled voxel = one Block (id 29) at that grid cell. The grid is
 * anisotropic (y cells are ¼ the height of an x/z cell) to match the Block's
 * real 20×5×20 world proportions — one Block per cell keeps the model's
 * aspect ratio. The model sits on y=1 (one cell above ground) next to a small
 * drive pad: Start + Finish at y=0, so the generated track is immediately
 * playable.
 */
import { AXIS, COLOR, PART, type PlacedPart } from '../codec/parts';
import { fitShapes } from './fit';
import type { VoxelGrid } from './voxelize';

export interface BuildOptions {
  /** TrackPartColor id for every block. */
  readonly color: number;
  /** Grid-cell offset applied to the whole model. */
  readonly offset?: [number, number, number];
  /** Include the Start/Finish drive pad (default true). */
  readonly withPad?: boolean;
  /**
   * Fit shaped pieces (HalfBlock corners, QuarterBlock tips, slope ramps on
   * steps) instead of only rectangular Blocks. Default true.
   */
  readonly shaped?: boolean;
}

export const DEFAULT_BUILD: BuildOptions = { color: COLOR.Default };

/** Hard ceiling — beyond this the code gets huge and the game struggles. */
export const MAX_PARTS = 100_000;

/**
 * Track coordinates are in tiles; a full Block occupies 4×4 tiles in x/z and
 * 1 unit in y (the game's legacy-v2 importer multiplies x/z by 4, and Block's
 * footprint spans [-2..1]² tiles). Adjacent voxels are therefore 4 tiles
 * apart horizontally and 1 apart vertically.
 */
export const BLOCK_XZ_STRIDE = 4;

export function buildParts(grid: VoxelGrid, opts: BuildOptions = DEFAULT_BUILD): PlacedPart[] {
  if (grid.filledCount > MAX_PARTS) {
    throw new Error(
      `Too many blocks (${grid.filledCount.toLocaleString()} > ${MAX_PARTS.toLocaleString()}) — lower the resolution`,
    );
  }
  const [ox, oy, oz] = opts.offset ?? [0, 0, 0];
  const parts: PlacedPart[] = [];
  const fit = opts.shaped !== false ? fitShapes(grid) : null;

  const place = (x: number, y: number, z: number, partId: number, rotation: number): void => {
    parts.push({
      x: (x + ox) * BLOCK_XZ_STRIDE,
      y: y + oy + 1, // keep the model one cell above the pad's ground level
      z: (z + oz) * BLOCK_XZ_STRIDE,
      partId,
      rotation,
      rotationAxis: AXIS.YPositive,
      color: opts.color,
    });
  };

  for (let z = 0; z < grid.nz; z++) {
    for (let y = 0; y < grid.ny; y++) {
      for (let x = 0; x < grid.nx; x++) {
        const key = x + y * grid.nx + z * grid.nx * grid.ny;
        if (grid.cells[key]) {
          const shaped = fit?.filledParts.get(key);
          place(x, y, z, shaped?.partId ?? PART.Block, shaped?.rotation ?? 0);
        } else {
          const ramp = fit?.rampParts.get(key);
          if (ramp) place(x, y, z, ramp.partId, ramp.rotation);
        }
      }
    }
  }

  if (parts.length > MAX_PARTS) {
    throw new Error(
      `Too many parts after shape fitting (${parts.length.toLocaleString()} > ${MAX_PARTS.toLocaleString()}) — lower the resolution`,
    );
  }

  if (opts.withPad !== false) {
    const padZ = (oz - 2) * BLOCK_XZ_STRIDE; // just in front of the model footprint
    parts.push(
      { x: ox * BLOCK_XZ_STRIDE, y: oy, z: padZ, partId: PART.Start, rotation: 0, rotationAxis: AXIS.YPositive, color: COLOR.Default, startOrder: 0 },
      { x: (ox + 2) * BLOCK_XZ_STRIDE, y: oy, z: padZ, partId: PART.Finish, rotation: 0, rotationAxis: AXIS.YPositive, color: COLOR.Default },
    );
  }
  return parts;
}
