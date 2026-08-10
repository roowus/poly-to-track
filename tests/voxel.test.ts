import { describe, expect, it } from 'vitest';
import { PART } from '../src/codec/parts';
import { parseObj } from '../src/mesh/obj';
import { buildParts, MAX_PARTS } from '../src/voxel/build';
import { fitShapes } from '../src/voxel/fit';
import { voxelize, type VoxelGrid } from '../src/voxel/voxelize';

/** Build a grid from string layers: rows are z, chars are x, layers are y. */
function gridOf(layers: string[][]): VoxelGrid {
  const ny = layers.length;
  const nz = layers[0]!.length;
  const nx = layers[0]![0]!.length;
  const cells = new Uint8Array(nx * ny * nz);
  let filledCount = 0;
  layers.forEach((rows, y) => rows.forEach((row, z) => {
    for (let x = 0; x < nx; x++) {
      if (row[x] === '#') {
        cells[x + y * nx + z * nx * ny] = 1;
        filledCount++;
      }
    }
  }));
  return { nx, ny, nz, cells, filledCount, yAspect: 1 };
}

const CUBE_OBJ = `
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
v 1 0 1
v 1 1 1
v 0 1 1
f 1 2 3 4
f 5 8 7 6
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 4 8 5 1
`;

describe('voxelize', () => {
  it('a closed cube at resolution 4: hollow keeps a shell, solid fills it', () => {
    const mesh = parseObj(CUBE_OBJ);
    const hollow = voxelize(mesh, { resolution: 4, solid: false, ySubdivisions: 1 });
    const solid = voxelize(mesh, { resolution: 4, solid: true, ySubdivisions: 1 });
    expect(hollow.nx).toBe(4);
    expect(hollow.ny).toBe(4);
    expect(hollow.nz).toBe(4);
    // 4^3 = 64 total; hollow shell = 64 - 2^3 interior = 56
    expect(hollow.filledCount).toBe(56);
    expect(solid.filledCount).toBe(64);
  });

  it('defaults to 4 y-subdivisions to match the Block slab (20×5×20)', () => {
    // A unit cube at resolution 4 becomes 4×16×4 anisotropic cells — one
    // Block per cell then rebuilds the cube at true world proportions.
    const mesh = parseObj(CUBE_OBJ);
    const solid = voxelize(mesh, { resolution: 4, solid: true });
    expect(solid.nx).toBe(4);
    expect(solid.ny).toBe(16);
    expect(solid.nz).toBe(4);
    expect(solid.yAspect).toBe(1 / 4);
    expect(solid.filledCount).toBe(4 * 16 * 4);
  });

  it('stays watertight at odd resolutions (boundary-plane float error)', () => {
    // cell = 1/24 is not exactly representable; faces on cell-boundary
    // planes must still register or the solid fill leaks and empties the cube.
    const mesh = parseObj(CUBE_OBJ);
    const solid = voxelize(mesh, { resolution: 24, solid: true, ySubdivisions: 1 });
    expect(solid.filledCount).toBe(24 * 24 * 24);
  });

  it('stays watertight with anisotropic y cells too', () => {
    const mesh = parseObj(CUBE_OBJ);
    const solid = voxelize(mesh, { resolution: 6, solid: true });
    expect(solid.filledCount).toBe(6 * 24 * 6);
  });

  it('a single triangle marks only cells it touches', () => {
    const mesh = parseObj('v 0 0 0\nv 4 0 0\nv 0 4 0\nf 1 2 3');
    const grid = voxelize(mesh, { resolution: 4, solid: false, ySubdivisions: 1 });
    // The triangle lies in the z=0 plane: exactly the lower-left triangle
    // half of the 4x4 layer (plus the diagonal) is touched.
    expect(grid.filledCount).toBeGreaterThanOrEqual(10);
    expect(grid.filledCount).toBeLessThanOrEqual(16);
  });

  it('degenerate/empty meshes produce empty or single-cell grids', () => {
    expect(voxelize({ positions: new Float32Array(0), triangleCount: 0 }, { resolution: 8, solid: true }).filledCount).toBe(0);
  });
});

describe('buildParts', () => {
  it('emits one Block per voxel plus a Start/Finish pad (shaping off)', () => {
    const mesh = parseObj(CUBE_OBJ);
    const grid = voxelize(mesh, { resolution: 2, solid: true, ySubdivisions: 1 });
    const parts = buildParts(grid, { color: 33, shaped: false });
    const blocks = parts.filter((p) => p.partId === PART.Block);
    expect(blocks).toHaveLength(8);
    expect(blocks.every((p) => p.color === 33)).toBe(true);
    expect(blocks.every((p) => p.y >= 1)).toBe(true); // model floats above pad level
    expect(parts.some((p) => p.partId === PART.Start && p.startOrder === 0)).toBe(true);
    expect(parts.some((p) => p.partId === PART.Finish)).toBe(true);
  });

  it('adds slope ramps on single steps when shaping is on', () => {
    // y=0 layer: two cells in a row; y=1 layer: only x=0 — a one-cell step.
    const step = gridOf([
      ['##'],
      ['#.'],
    ]);
    const parts = buildParts(step, { color: 0, withPad: false });
    const ramp = parts.find((p) => p.partId === PART.BlockSlopeUp);
    expect(ramp).toBeDefined();
    // The ramp fills the empty cell above the lower run: x=1 (tile 4), y=1 (+1 pad lift = 2).
    expect(ramp!.x).toBe(4);
    expect(ramp!.y).toBe(2);
  });

  it('enforces the part budget', () => {
    const big = {
      nx: 100, ny: 100, nz: 11,
      cells: new Uint8Array(100 * 100 * 11).fill(1),
      filledCount: 110_000,
      yAspect: 1,
    };
    expect(110_000).toBeGreaterThan(MAX_PARTS);
    expect(() => buildParts(big)).toThrow(/lower the resolution/i);
  });
});

describe('fitShapes', () => {
  it('turns convex plan corners into HalfBlocks and keeps straight edges as Blocks', () => {
    // One 3×3 solid layer: 4 corners → HalfBlock, 4 edges + center → Block.
    const grid = gridOf([
      ['###', '###', '###'],
    ]);
    const fit = fitShapes(grid);
    const kinds = [...fit.filledParts.values()].map((c) => c.partId);
    expect(kinds.filter((k) => k === PART.HalfBlock)).toHaveLength(4);
    expect(kinds.filter((k) => k === PART.Block)).toHaveLength(5);
  });

  it('turns wall tips into QuarterBlocks', () => {
    // A 1×3 wall: both ends have 3 open sides.
    const grid = gridOf([
      ['###'],
    ]);
    const fit = fitShapes(grid);
    const kinds = [...fit.filledParts.values()].map((c) => c.partId);
    expect(kinds.filter((k) => k === PART.QuarterBlock)).toHaveLength(2);
    expect(kinds.filter((k) => k === PART.Block)).toHaveLength(1);
  });

  it('corner HalfBlock rotations are all distinct', () => {
    const grid = gridOf([
      ['###', '###', '###'],
    ]);
    const fit = fitShapes(grid);
    const rots = [...fit.filledParts.values()]
      .filter((c) => c.partId === PART.HalfBlock)
      .map((c) => c.rotation)
      .sort();
    expect(rots).toEqual([0, 1, 2, 3]);
  });

  it('does not ramp gaps between two runs (only single steps)', () => {
    // y=0 full row of 3; y=1 has ends filled with an empty middle: the middle
    // sits on material but has TWO filled neighbors — ambiguous, no ramp.
    const grid = gridOf([
      ['###'],
      ['#.#'],
    ]);
    const fit = fitShapes(grid);
    expect(fit.rampParts.size).toBe(0);
  });
});
