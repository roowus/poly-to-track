import { describe, expect, it } from 'vitest';
import { COLOR, nearestColorId, PART } from '../src/codec/parts';
import { parseObj } from '../src/mesh/obj';
import { buildParts, PARTS_WARNING } from '../src/voxel/build';
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

  it('has NO hard part limit — huge grids build fine (soft warning only)', () => {
    const big: VoxelGrid = {
      nx: 100, ny: 101, nz: 11,
      cells: new Uint8Array(100 * 101 * 11).fill(1),
      filledCount: 111_100,
      yAspect: 1,
    };
    expect(big.filledCount).toBeGreaterThan(PARTS_WARNING); // over the old cap
    const parts = buildParts(big, { color: 0, withPad: false, shaped: false });
    expect(parts).toHaveLength(111_100);
  });
});

describe('model colors', () => {
  /** A colored unit cube: every vertex red (OBJ `v x y z r g b` extension). */
  const RED_CUBE_OBJ = CUBE_OBJ.replace(/^v (.+)$/gm, 'v $1 1 0 0');

  it('voxelize carries surface colors and fills the interior from them', () => {
    const mesh = parseObj(RED_CUBE_OBJ);
    expect(mesh.colors).toBeDefined();
    const grid = voxelize(mesh, { resolution: 4, solid: true, ySubdivisions: 1 });
    expect(grid.colors).toBeDefined();
    // Every filled cell (including the 2³ flood-filled interior) is red-ish.
    for (let i = 0; i < grid.cells.length; i++) {
      if (!grid.cells[i]) continue;
      expect(grid.colors![i * 3]).toBeGreaterThan(200);
      expect(grid.colors![i * 3 + 1]).toBeLessThan(30);
    }
  });

  it('buildParts maps voxel colors onto the game palette per part', () => {
    const mesh = parseObj(RED_CUBE_OBJ);
    const grid = voxelize(mesh, { resolution: 2, solid: true, ySubdivisions: 1 });
    const parts = buildParts(grid, { color: COLOR.Default, withPad: false, shaped: false });
    // Pure red maps to the game's red swatch (Custom1 = 33), not Default.
    expect(parts.every((p) => p.color === 33)).toBe(true);
  });

  it('useModelColors:false falls back to the flat color', () => {
    const mesh = parseObj(RED_CUBE_OBJ);
    const grid = voxelize(mesh, { resolution: 2, solid: true, ySubdivisions: 1 });
    const parts = buildParts(grid, { color: 40, useModelColors: false, withPad: false, shaped: false });
    expect(parts.every((p) => p.color === 40)).toBe(true);
  });

  it('an uncolored model produces no color channel at all', () => {
    const mesh = parseObj(CUBE_OBJ);
    expect(mesh.colors).toBeUndefined();
    const grid = voxelize(mesh, { resolution: 2, solid: true, ySubdivisions: 1 });
    expect(grid.colors).toBeUndefined();
  });

  it('nearestColorId picks sensible palette entries', () => {
    expect(nearestColorId(255, 0, 0)).toBe(33);     // red
    expect(nearestColorId(0, 0, 0)).toBe(32);       // black
    expect(nearestColorId(200, 200, 200)).toBe(0);  // light gray → Default
    expect(nearestColorId(40, 90, 45)).toBe(36);    // green
  });

  it('pale/tinted colors keep their hue instead of rounding to white', () => {
    // The "incredibly white" bug: these all mapped to the light gray Default
    // under a value-weighted metric because the palette's chromatic swatches
    // are all DARK.
    expect(nearestColorId(250, 180, 180)).toBe(33);  // pale pink → red
    expect(nearestColorId(255, 245, 157)).toBe(35);  // pastel yellow → yellow
    expect(nearestColorId(173, 216, 230)).toBe(38);  // light blue → blue
    expect(nearestColorId(152, 251, 152)).toBe(36);  // pale green → green
    expect(nearestColorId(230, 220, 250)).toBe(39);  // lavender → purple
  });

  it('true grays still pick a gray by value', () => {
    expect(nearestColorId(245, 245, 245)).toBe(0);   // white → light gray
    expect(nearestColorId(128, 128, 128)).toBe(0);   // mid gray
    expect(nearestColorId(20, 20, 20)).toBe(32);     // black swatch
    expect(nearestColorId(8, 8, 8)).toBe(32);
  });
});

describe('per-voxel texture sampling', () => {
  // 4×1 stripe texture: red | green | blue | white.
  const STRIPES = {
    width: 4,
    height: 1,
    data: new Uint8Array([
      255, 0, 0, 255,  0, 255, 0, 255,  0, 0, 255, 255,  255, 255, 255, 255,
    ]),
  };
  /** Flat 4×4 quad in the xz-plane, u = x/4 across the stripe texture. */
  const QUAD_OBJ = [
    'usemtl tex',
    'v 0 0 0', 'v 4 0 0', 'v 4 0 4', 'v 0 0 4',
    'vt 0 0', 'vt 1 0', 'vt 1 1', 'vt 0 1',
    'f 1/1 2/2 3/3 4/4',
  ].join('\n');
  const texturedQuad = () => {
    const mats = new Map([['tex', { kd: [0, 0, 0] as const, mapKd: 's.png', image: STRIPES }]]);
    return parseObj(QUAD_OBJ, mats);
  };

  it('parseObj emits the texture channel for map_Kd triangles', () => {
    const mesh = texturedQuad();
    expect(mesh.texturing).toBeDefined();
    expect(mesh.texturing!.textures).toHaveLength(1);
    expect([...mesh.texturing!.triTexture]).toEqual([0, 0]);
    // 2 triangles × 3 vertices × (u,v)
    expect(mesh.texturing!.uvs).toHaveLength(12);
  });

  it('each voxel samples its own texel — one triangle spans many colors', () => {
    const mesh = texturedQuad();
    const grid = voxelize(mesh, { resolution: 4, solid: false, ySubdivisions: 1 });
    expect(grid.nx).toBe(4);
    expect(grid.nz).toBe(4);
    // Column x samples texel x: red, green, blue, white — for EVERY z row,
    // even though each triangle only covers half the quad.
    const expected = [
      [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255],
    ];
    for (let z = 0; z < 4; z++) {
      for (let x = 0; x < 4; x++) {
        const i = x + z * grid.nx * grid.ny;
        expect(grid.cells[i]).toBe(1);
        expect([
          grid.colors![i * 3], grid.colors![i * 3 + 1], grid.colors![i * 3 + 2],
        ]).toEqual(expected[x]);
      }
    }
  });

  it('the whole build no longer collapses to two flat triangle colors', () => {
    const mesh = texturedQuad();
    const grid = voxelize(mesh, { resolution: 4, solid: false, ySubdivisions: 1 });
    const parts = buildParts(grid, { color: COLOR.Default, withPad: false, shaped: false });
    expect(new Set(parts.map((p) => p.color)).size).toBeGreaterThanOrEqual(3);
  });

  it('linear tints multiply the sampled texel (voxelize path)', () => {
    const mesh = texturedQuad();
    const texturing = mesh.texturing!;
    const tinted = {
      ...mesh,
      texturing: {
        ...texturing,
        // Kill green+blue: the white column must come out red.
        tints: new Float32Array(Array.from({ length: mesh.triangleCount }, () => [1, 0, 0]).flat()),
      },
    };
    const grid = voxelize(tinted, { resolution: 4, solid: false, ySubdivisions: 1 });
    const i = 3; // x=3, z=0 — the white texel's column
    expect([grid.colors![i * 3], grid.colors![i * 3 + 1], grid.colors![i * 3 + 2]]).toEqual([255, 0, 0]);
  });

  it('vertex-colored triangles stay untextured (vertex colors win)', () => {
    const mats = new Map([['tex', { kd: [0, 0, 0] as const, mapKd: 's.png', image: STRIPES }]]);
    const obj = [
      'usemtl tex',
      'v 0 0 0 1 0 1', 'v 4 0 0 1 0 1', 'v 4 0 4 1 0 1',
      'vt 0 0', 'vt 1 0', 'vt 1 1',
      'f 1/1 2/2 3/3',
    ].join('\n');
    const mesh = parseObj(obj, mats);
    expect(mesh.texturing).toBeUndefined();
    expect([...mesh.colors!]).toEqual([255, 0, 255]);
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
