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
import { AXIS, COLOR, nearestColorId, PART, type PlacedPart } from '../codec/parts';
import { fitShapes } from './fit';
import type { VoxelGrid } from './voxelize';

export interface BuildOptions {
  /** TrackPartColor id for every block (fallback when the model has no colors
   *  or useModelColors is off). */
  readonly color: number;
  /** Map per-voxel model colors to the nearest game color (default true when
   *  the grid carries colors). */
  readonly useModelColors?: boolean;
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

/** Soft threshold for UI warnings only — huge builds are allowed, but the
 *  game visibly chugs past this and track CODES get enormous. */
export const PARTS_WARNING = 100_000;

/**
 * Track coordinates are in tiles; a full Block occupies 4×4 tiles in x/z and
 * 1 unit in y (the game's legacy-v2 importer multiplies x/z by 4, and Block's
 * footprint spans [-2..1]² tiles). Adjacent voxels are therefore 4 tiles
 * apart horizontally and 1 apart vertically.
 */
export const BLOCK_XZ_STRIDE = 4;

export function buildParts(grid: VoxelGrid, opts: BuildOptions = DEFAULT_BUILD): PlacedPart[] {
  const [ox, oy, oz] = opts.offset ?? [0, 0, 0];
  const parts: PlacedPart[] = [];
  const fit = opts.shaped !== false ? fitShapes(grid) : null;
  const voxColors = opts.useModelColors !== false ? grid.colors ?? null : null;
  // Distinct voxel colors are few after palette mapping — memoize by packed RGB.
  const colorCache = new Map<number, number>();
  const colorAt = (key: number): number => {
    if (!voxColors) return opts.color;
    const r = voxColors[key * 3]!, g = voxColors[key * 3 + 1]!, b = voxColors[key * 3 + 2]!;
    if (r === 0 && g === 0 && b === 0) return opts.color; // uncolored cell
    const packed = (r << 16) | (g << 8) | b;
    let id = colorCache.get(packed);
    if (id === undefined) {
      id = nearestColorId(r, g, b);
      colorCache.set(packed, id);
    }
    return id;
  };

  const place = (x: number, y: number, z: number, partId: number, rotation: number, color: number): void => {
    parts.push({
      x: (x + ox) * BLOCK_XZ_STRIDE,
      y: y + oy + 1, // keep the model one cell above the pad's ground level
      z: (z + oz) * BLOCK_XZ_STRIDE,
      partId,
      rotation,
      rotationAxis: AXIS.YPositive,
      color,
    });
  };

  for (let z = 0; z < grid.nz; z++) {
    for (let y = 0; y < grid.ny; y++) {
      for (let x = 0; x < grid.nx; x++) {
        const key = x + y * grid.nx + z * grid.nx * grid.ny;
        if (grid.cells[key]) {
          const shaped = fit?.filledParts.get(key);
          place(x, y, z, shaped?.partId ?? PART.Block, shaped?.rotation ?? 0, colorAt(key));
        } else {
          const ramp = fit?.rampParts.get(key);
          // A ramp fills an empty cell — color it like the step it leans on.
          if (ramp) place(x, y, z, ramp.partId, ramp.rotation, colorAt(key - grid.nx));
        }
      }
    }
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
