/**
 * Mesh → voxel grid.
 *
 * Surface pass: for every triangle, test triangle/box overlap (separating
 * axis theorem, Akenine-Möller) against the voxels in the triangle's AABB.
 * Solid pass (optional): 6-connected flood fill from outside the grid;
 * every unreached, unmarked voxel is interior and gets filled.
 */
import type { TriangleMesh } from '../mesh/types';
import { meshBounds } from '../mesh/types';

export interface VoxelizeOptions {
  /** Longest model axis maps to this many voxels (in x/z cell units). */
  readonly resolution: number;
  /** Fill enclosed interior volume. */
  readonly solid: boolean;
  /**
   * y cells per x/z cell. PolyTrack's Block is a 4×4×1-tile slab (world
   * 20×5×20), so stacking one Block per CUBIC voxel squashes models 4×.
   * Subdividing y by 4 makes each cell match the Block's real proportions.
   * Defaults to 4; pass 1 for plain cubic voxels.
   */
  readonly ySubdivisions?: number;
}

export interface VoxelGrid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** x + y*nx + z*nx*ny; 1 = filled. */
  readonly cells: Uint8Array;
  readonly filledCount: number;
  /** World-proportion height of one cell relative to its x/z size (1/ySubdivisions). */
  readonly yAspect: number;
  /** RGB (3 bytes/cell, same indexing) — present only when the mesh carried
   *  colors. Interior cells inherit the nearest surface color. */
  readonly colors?: Uint8Array;
}

export function voxelize(mesh: TriangleMesh, opts: VoxelizeOptions): VoxelGrid {
  const ySub = Math.max(1, Math.round(opts.ySubdivisions ?? 4));
  const yAspect = 1 / ySub;
  if (mesh.triangleCount === 0) return { nx: 0, ny: 0, nz: 0, cells: new Uint8Array(0), filledCount: 0, yAspect };
  const { min, max } = meshBounds(mesh);
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const longest = Math.max(size[0]!, size[1]!, size[2]!);
  if (!(longest > 0)) return { nx: 1, ny: 1, nz: 1, cells: new Uint8Array([1]), filledCount: 1, yAspect };
  const meshColors = mesh.colors ?? null;

  // Anisotropic cells (x/z cells are `cell` wide, y cells are `cell/ySub`
  // tall) are implemented by stretching the mesh's y axis by ySub and
  // voxelizing cubically — identical math, no per-axis SAT variants.
  const cell = longest / opts.resolution;
  const nx = Math.max(1, Math.ceil(size[0]! / cell - 1e-9));
  const ny = Math.max(1, Math.ceil((size[1]! * ySub) / cell - 1e-9));
  const nz = Math.max(1, Math.ceil(size[2]! / cell - 1e-9));
  const cells = new Uint8Array(nx * ny * nz);
  const colors = meshColors ? new Uint8Array(nx * ny * nz * 3) : null;

  // Epsilon-padded: model faces often lie EXACTLY on cell-boundary planes
  // (any axis-aligned geometry does), where float error can flip the SAT's
  // touching-counts-as-overlap equality and punch pinholes in the shell —
  // which the solid flood fill then leaks through.
  const half = (cell / 2) * (1 + 1e-6);
  const p = mesh.positions;
  const v0 = [0, 0, 0], v1 = [0, 0, 0], v2 = [0, 0, 0];

  for (let t = 0; t < mesh.triangleCount; t++) {
    const b = t * 9;
    for (let a = 0; a < 3; a++) {
      const s = a === 1 ? ySub : 1;
      v0[a] = (p[b + a]! - min[a]!) * s;
      v1[a] = (p[b + 3 + a]! - min[a]!) * s;
      v2[a] = (p[b + 6 + a]! - min[a]!) * s;
    }
    // Clamp both ends into the grid: a triangle lying exactly on the max
    // boundary plane floors to one past the last cell and must still test
    // against that last cell.
    const tMinX = clampIndex(Math.min(v0[0]!, v1[0]!, v2[0]!) / cell, nx);
    const tMaxX = clampIndex(Math.max(v0[0]!, v1[0]!, v2[0]!) / cell, nx);
    const tMinY = clampIndex(Math.min(v0[1]!, v1[1]!, v2[1]!) / cell, ny);
    const tMaxY = clampIndex(Math.max(v0[1]!, v1[1]!, v2[1]!) / cell, ny);
    const tMinZ = clampIndex(Math.min(v0[2]!, v1[2]!, v2[2]!) / cell, nz);
    const tMaxZ = clampIndex(Math.max(v0[2]!, v1[2]!, v2[2]!) / cell, nz);

    for (let z = tMinZ; z <= tMaxZ; z++) {
      for (let y = tMinY; y <= tMaxY; y++) {
        for (let x = tMinX; x <= tMaxX; x++) {
          const idx = x + y * nx + z * nx * ny;
          if (cells[idx]) continue;
          const cx = (x + 0.5) * cell, cy = (y + 0.5) * cell, cz = (z + 0.5) * cell;
          if (triBoxOverlap(cx, cy, cz, half, v0, v1, v2)) {
            cells[idx] = 1;
            // First triangle to claim the cell colors it (cells[idx] guard
            // above means later triangles never repaint). (0,0,0) is the
            // "uncolored" sentinel for interior fill — bump black to (1,1,1).
            if (colors && meshColors) {
              const r = meshColors[t * 3]!, g = meshColors[t * 3 + 1]!, b = meshColors[t * 3 + 2]!;
              colors[idx * 3] = r || g || b ? r : 1;
              colors[idx * 3 + 1] = r || g || b ? g : 1;
              colors[idx * 3 + 2] = r || g || b ? b : 1;
            }
          }
        }
      }
    }
  }

  if (opts.solid) {
    floodFillInterior(cells, nx, ny, nz);
    if (colors) propagateColors(cells, colors, nx, ny, nz);
  }

  let filledCount = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i]) filledCount++;
  return { nx, ny, nz, cells, filledCount, yAspect, ...(colors ? { colors } : {}) };
}

/**
 * Give interior-filled cells (colored 0,0,0 by the fill) the color of the
 * nearest surface cell: multi-source BFS out from every colored cell. A true
 * black surface (0,0,0) would be re-flooded — nudge it to (1,1,1) instead,
 * invisible after palette mapping.
 */
function propagateColors(cells: Uint8Array, colors: Uint8Array, nx: number, ny: number, nz: number): void {
  const queue: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) continue;
    if (colors[i * 3] || colors[i * 3 + 1] || colors[i * 3 + 2]) queue.push(i);
  }
  if (queue.length === 0) return;
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++]!;
    const x = i % nx;
    const y = Math.floor(i / nx) % ny;
    const z = Math.floor(i / (nx * ny));
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || X >= nx || Y < 0 || Y >= ny || Z < 0 || Z >= nz) continue;
      const j = X + Y * nx + Z * nx * ny;
      if (!cells[j] || colors[j * 3] || colors[j * 3 + 1] || colors[j * 3 + 2]) continue;
      colors[j * 3] = Math.max(1, colors[i * 3]!);
      colors[j * 3 + 1] = Math.max(1, colors[i * 3 + 1]!);
      colors[j * 3 + 2] = Math.max(1, colors[i * 3 + 2]!);
      queue.push(j);
    }
  }
}

function clampIndex(v: number, n: number): number {
  return Math.min(n - 1, Math.max(0, Math.floor(v)));
}

/** Mark interior: BFS the exterior air (6-connected), fill the rest. */
function floodFillInterior(cells: Uint8Array, nx: number, ny: number, nz: number): void {
  const OUTSIDE = 2;
  const queue: number[] = [];
  const push = (x: number, y: number, z: number) => {
    const i = x + y * nx + z * nx * ny;
    if (cells[i] === 0) {
      cells[i] = OUTSIDE;
      queue.push(i);
    }
  };
  // Seed all boundary faces.
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) { push(0, y, z); push(nx - 1, y, z); }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { push(x, 0, z); push(x, ny - 1, z); }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { push(x, y, 0); push(x, y, nz - 1); }

  while (queue.length > 0) {
    const i = queue.pop()!;
    const x = i % nx;
    const y = Math.floor(i / nx) % ny;
    const z = Math.floor(i / (nx * ny));
    if (x > 0) push(x - 1, y, z);
    if (x < nx - 1) push(x + 1, y, z);
    if (y > 0) push(x, y - 1, z);
    if (y < ny - 1) push(x, y + 1, z);
    if (z > 0) push(x, y, z - 1);
    if (z < nz - 1) push(x, y, z + 1);
  }

  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === 0) cells[i] = 1;      // unreached air = interior
    else if (cells[i] === OUTSIDE) cells[i] = 0;
  }
}

/**
 * Triangle/axis-aligned-box overlap (SAT, Akenine-Möller 2001):
 * 3 box axes, the triangle normal, and 9 cross-product axes.
 */
function triBoxOverlap(
  cx: number, cy: number, cz: number, half: number,
  a: number[], b: number[], c: number[],
): boolean {
  const v0x = a[0]! - cx, v0y = a[1]! - cy, v0z = a[2]! - cz;
  const v1x = b[0]! - cx, v1y = b[1]! - cy, v1z = b[2]! - cz;
  const v2x = c[0]! - cx, v2y = c[1]! - cy, v2z = c[2]! - cz;

  // Box axes.
  if (Math.min(v0x, v1x, v2x) > half || Math.max(v0x, v1x, v2x) < -half) return false;
  if (Math.min(v0y, v1y, v2y) > half || Math.max(v0y, v1y, v2y) < -half) return false;
  if (Math.min(v0z, v1z, v2z) > half || Math.max(v0z, v1z, v2z) < -half) return false;

  const e0x = v1x - v0x, e0y = v1y - v0y, e0z = v1z - v0z;
  const e1x = v2x - v1x, e1y = v2y - v1y, e1z = v2z - v1z;
  const e2x = v0x - v2x, e2y = v0y - v2y, e2z = v0z - v2z;

  // 9 cross-axis tests: axis = unit(i) × edge. Projecting all three vertices
  // (two always coincide per axis) sidesteps Akenine-Möller's per-edge vertex
  // pair bookkeeping, which is easy to get subtly wrong.
  if (!axisTest(e0z, -e0y, v0y, v0z, v1y, v1z, v2y, v2z, half)) return false;
  if (!axisTest(e1z, -e1y, v0y, v0z, v1y, v1z, v2y, v2z, half)) return false;
  if (!axisTest(e2z, -e2y, v0y, v0z, v1y, v1z, v2y, v2z, half)) return false;

  if (!axisTest(-e0z, e0x, v0x, v0z, v1x, v1z, v2x, v2z, half)) return false;
  if (!axisTest(-e1z, e1x, v0x, v0z, v1x, v1z, v2x, v2z, half)) return false;
  if (!axisTest(-e2z, e2x, v0x, v0z, v1x, v1z, v2x, v2z, half)) return false;

  if (!axisTest(e0y, -e0x, v0x, v0y, v1x, v1y, v2x, v2y, half)) return false;
  if (!axisTest(e1y, -e1x, v0x, v0y, v1x, v1y, v2x, v2y, half)) return false;
  if (!axisTest(e2y, -e2x, v0x, v0y, v1x, v1y, v2x, v2y, half)) return false;

  // Triangle plane vs box.
  const nxp = e0y * e1z - e0z * e1y;
  const nyp = e0z * e1x - e0x * e1z;
  const nzp = e0x * e1y - e0y * e1x;
  const d = -(nxp * v0x + nyp * v0y + nzp * v0z);
  const r = half * (Math.abs(nxp) + Math.abs(nyp) + Math.abs(nzp));
  return Math.abs(d) <= r;
}

/** 2D SAT projection test used by the cross-axis cases (all 3 vertices). */
function axisTest(
  a1: number, a2: number,
  p0a: number, p0b: number, p1a: number, p1b: number, p2a: number, p2b: number,
  half: number,
): boolean {
  const p0 = a1 * p0a + a2 * p0b;
  const p1 = a1 * p1a + a2 * p1b;
  const p2 = a1 * p2a + a2 * p2b;
  const rad = (Math.abs(a1) + Math.abs(a2)) * half;
  return Math.min(p0, p1, p2) <= rad && Math.max(p0, p1, p2) >= -rad;
}
