import { describe, expect, it } from 'vitest';
import { PART } from '../src/codec/parts';
import { parseObj } from '../src/mesh/obj';
import { buildParts, MAX_PARTS } from '../src/voxel/build';
import { voxelize } from '../src/voxel/voxelize';

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
    const hollow = voxelize(mesh, { resolution: 4, solid: false });
    const solid = voxelize(mesh, { resolution: 4, solid: true });
    expect(hollow.nx).toBe(4);
    expect(hollow.ny).toBe(4);
    expect(hollow.nz).toBe(4);
    // 4^3 = 64 total; hollow shell = 64 - 2^3 interior = 56
    expect(hollow.filledCount).toBe(56);
    expect(solid.filledCount).toBe(64);
  });

  it('a single triangle marks only cells it touches', () => {
    const mesh = parseObj('v 0 0 0\nv 4 0 0\nv 0 4 0\nf 1 2 3');
    const grid = voxelize(mesh, { resolution: 4, solid: false });
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
  it('emits one Block per voxel plus a Start/Finish pad', () => {
    const mesh = parseObj(CUBE_OBJ);
    const grid = voxelize(mesh, { resolution: 2, solid: true });
    const parts = buildParts(grid, { color: 33 });
    const blocks = parts.filter((p) => p.partId === PART.Block);
    expect(blocks).toHaveLength(8);
    expect(blocks.every((p) => p.color === 33)).toBe(true);
    expect(blocks.every((p) => p.y >= 1)).toBe(true); // model floats above pad level
    expect(parts.some((p) => p.partId === PART.Start && p.startOrder === 0)).toBe(true);
    expect(parts.some((p) => p.partId === PART.Finish)).toBe(true);
  });

  it('enforces the part budget', () => {
    const big = {
      nx: 100, ny: 100, nz: 11,
      cells: new Uint8Array(100 * 100 * 11).fill(1),
      filledCount: 110_000,
    };
    expect(110_000).toBeGreaterThan(MAX_PARTS);
    expect(() => buildParts(big)).toThrow(/lower the resolution/i);
  });
});
