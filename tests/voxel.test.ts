import { describe, expect, it } from 'vitest';
import { COLOR, nearestColorId, PART } from '../src/codec/parts';
import { parseObj } from '../src/mesh/obj';
import { buildParts, PARTS_WARNING } from '../src/voxel/build';
import { fitShapes } from '../src/voxel/fit';
import { quantizeGridColors } from '../src/voxel/palette';
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

  it('NO slope ramps — empty cells stay empty (ramps removed by request)', () => {
    // y=0 layer: two cells in a row; y=1 layer: only x=0 — a one-cell step.
    // Builds contain only pieces in material-filled cells; the empty cell
    // above the lower run gets nothing.
    const step = gridOf([
      ['##'],
      ['#.'],
    ]);
    const parts = buildParts(step, { color: 0, withPad: false });
    expect(parts.some((p) => p.partId === PART.BlockSlopeUp)).toBe(false);
    expect(parts.some((p) => p.partId === 151)).toBe(false); // BlockSlopeUpLong
    expect(parts).toHaveLength(3); // the two y=0 cells + the one y=1 cell
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

describe('dominant-color quantization', () => {
  /** A 12×12 layer colored like a lit mountain: two big materials (grass,
   * rock) at ~50% coverage each, baked-lighting shade variants at a few
   * percent (yellow-shifted highlights, a warm ridge tint), and stray
   * single-voxel off-colors (paintball spots). */
  function mountainGrid(): VoxelGrid {
    const nx = 12, nz = 12;
    const cells = new Uint8Array(nx * nz).fill(1);
    const c = new Uint8Array(nx * nz * 3);
    const set = (i: number, r: number, g: number, b: number) => {
      c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
    };
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        const i = x + z * nx;
        x + z * nx < (nx * nz) / 2 ? set(i, 60, 120, 60) : set(i, 120, 90, 55);
      }
    }
    // ~4% each: sunlit + half-lit grass, sunlit rock — under MIN_COVERAGE.
    for (let k = 0; k < 6; k++) set(k * 7 % 72, 130, 170, 70);
    for (let k = 0; k < 5; k++) set(k * 11 % 72, 105, 150, 65);
    for (let k = 0; k < 6; k++) set(72 + (k * 7 % 72), 160, 130, 60);
    // Stray spots: 2 red among grass, 1 magenta among rock.
    set(20, 220, 60, 60);
    set(50, 220, 60, 60);
    set(100, 220, 60, 220);
    return { nx, ny: 1, nz, cells, filledCount: nx * nz, yAspect: 1, colors: c };
  }

  it('merges lighting shades into their materials — no scattered yellow/red', () => {
    const grid = mountainGrid();
    const out = quantizeGridColors(grid)!;
    expect(out).toBeDefined();
    const hues = new Set<number>();
    for (let i = 0; i < 144; i++) {
      hues.add(nearestColorId(out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!));
    }
    // Exactly the two materials (green + brown) survive quantization; the
    // yellow-shifted highlights, warm tints AND the stray spots are gone.
    expect(hues).toEqual(new Set([36, 40]));
  });

  it('repaints voxels with the exact swatch color (preview = build)', () => {
    const grid = mountainGrid();
    const out = quantizeGridColors(grid)!;
    // Green voxels carry green swatch #2a5e30 bytes, not the input 60,120,60.
    expect([out[0]!, out[1]!, out[2]!]).toEqual([0x2a, 0x5e, 0x30]);
    expect([out[143 * 3]!, out[143 * 3 + 1]!, out[143 * 3 + 2]!]).toEqual([0x30, 0x23, 0x18]);
  });

  it('a distinct accent material survives (blue body + yellow trim)', () => {
    // Two far-apart hues at 75/25 — the trim dominates its own hue
    // neighborhood, clears the floor, and fits inside the entry budget.
    const nx = 12, nz = 12;
    const cells = new Uint8Array(nx * nz).fill(1);
    const c = new Uint8Array(nx * nz * 3);
    for (let i = 0; i < nx * nz; i++) {
      const trim = i % 12 >= 9; // right column third
      c[i * 3] = trim ? 250 : 40;
      c[i * 3 + 1] = trim ? 230 : 60;
      c[i * 3 + 2] = trim ? 90 : 160;
    }
    const grid = { nx, ny: 1, nz, cells, filledCount: nx * nz, yAspect: 1, colors: c };
    const out = quantizeGridColors(grid)!;
    const hues = new Set<number>();
    for (let i = 0; i < nx * nz; i++) {
      hues.add(nearestColorId(out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!));
    }
    expect(hues).toEqual(new Set([38, 35])); // blue body + yellow trim
  });

  it('a pale character does not collapse into all-brown (value split)', () => {
    // Skin (224,172,150 — pale, hue ~20°) and a brown jacket (110,75,45,
    // hue ~26°) both vote for the dark orange swatch. Their VALUES are
    // bimodal, so the entry splits: dark half keeps the swatch (jacket),
    // light half becomes light gray (skin) — the character keeps 3 readable
    // materials instead of one brown mass.
    const nx = 20, nz = 10;
    const cells = new Uint8Array(nx * nz).fill(1);
    const c = new Uint8Array(nx * nz * 3);
    for (let i = 0; i < nx * nz; i++) {
      const skin = i < 120, jeans = i >= 180;
      c[i * 3] = jeans ? 50 : skin ? 224 : 110;
      c[i * 3 + 1] = jeans ? 70 : skin ? 172 : 75;
      c[i * 3 + 2] = jeans ? 140 : skin ? 150 : 45;
    }
    const grid = { nx, ny: 1, nz, cells, filledCount: nx * nz, yAspect: 1, colors: c };
    const out = quantizeGridColors(grid)!;
    const hues = new Set<number>();
    for (let i = 0; i < nx * nz; i++) {
      hues.add(nearestColorId(out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!));
    }
    expect(hues).toEqual(new Set([0, 34, 38])); // light-gray skin + orange jacket + blue jeans
    // The skin voxels specifically carry the light gray swatch bytes.
    expect([out[0]!, out[1]!, out[2]!]).toEqual([0xb8, 0xb8, 0xb8]);
  });

  it('maxColors option caps the material count', () => {
    // A 3-material character quantized to maxColors 1 → a single swatch.
    const nx = 20, nz = 10;
    const cells = new Uint8Array(nx * nz).fill(1);
    const c = new Uint8Array(nx * nz * 3);
    for (let i = 0; i < nx * nz; i++) {
      const skin = i < 120, jeans = i >= 180;
      c[i * 3] = jeans ? 50 : skin ? 224 : 110;
      c[i * 3 + 1] = jeans ? 70 : skin ? 172 : 75;
      c[i * 3 + 2] = jeans ? 140 : skin ? 150 : 45;
    }
    const grid = { nx, ny: 1, nz, cells, filledCount: nx * nz, yAspect: 1, colors: c };
    const out = quantizeGridColors(grid, { maxColors: 1 })!;
    const hues = new Set<number>();
    for (let i = 0; i < nx * nz; i++) {
      hues.add(nearestColorId(out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!));
    }
    expect(hues.size).toBe(1);
  });

  it('shadeMerge 0 keeps the mountain bands (merging disabled)', () => {
    // The v0.6.9 mountain merges to exactly 2 with defaults; shadeMerge 0
    // disables the hue-neighbor rule so the yellow band survives.
    const nx = 12, nz = 12;
    const cells = new Uint8Array(nx * nz).fill(1);
    const c = new Uint8Array(nx * nz * 3);
    const set = (i: number, r: number, g: number, b: number) => {
      c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
    };
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        const i = x + z * nx;
        x + z * nx < 72 ? set(i, 60, 120, 60) : set(i, 120, 90, 55);
      }
    }
    for (let k = 0; k < 6; k++) set(k * 7 % 72, 130, 170, 70);
    for (let k = 0; k < 6; k++) set(72 + (k * 7 % 72), 160, 130, 60);
    const grid = { nx, ny: 1, nz, cells, filledCount: nx * nz, yAspect: 1, colors: c };
    const out = quantizeGridColors(grid, { shadeMerge: 0 })!;
    const hues = new Set<number>();
    for (let i = 0; i < nx * nz; i++) {
      hues.add(nearestColorId(out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!));
    }
    expect(hues.size).toBeGreaterThanOrEqual(3); // yellow band survives
  });

  it('uncolored grids and sentinel cells pass through', () => {
    const plain = gridOf([['##']]);
    expect(quantizeGridColors(plain)).toBeNull(); // no colors channel
  });
});

describe('fitShapes', () => {
  it('rounds 3×3 plan corners with OuterCorners and keeps edges as Blocks', () => {
    // One 3×3 solid layer: 4 corners → rounded OuterCorner (sides continue
    // past each corner), 4 edges + center → Block.
    const grid = gridOf([
      ['###', '###', '###'],
    ]);
    const fit = fitShapes(grid);
    const kinds = [...fit.filledParts.values()].map((c) => c.partId);
    expect(kinds.filter((k) => k === PART.OuterCorner)).toHaveLength(4);
    expect(kinds.filter((k) => k === PART.Block)).toHaveLength(5);
  });

  it('corner OuterCorner rotations are all distinct and cut the open quadrant', () => {
    const grid = gridOf([
      ['###', '###', '###'],
    ]);
    const fit = fitShapes(grid);
    const rots = [...fit.filledParts.values()]
      .filter((c) => c.partId === PART.OuterCorner)
      .map((c) => c.rotation)
      .sort();
    expect(rots).toEqual([0, 1, 2, 3]);
  });

  it('a 2×2 block rounds into four OuterCorners', () => {
    const grid = gridOf([
      ['##', '##'],
    ]);
    const fit = fitShapes(grid);
    const kinds = [...fit.filledParts.values()].map((c) => c.partId);
    expect(kinds.filter((k) => k === PART.OuterCorner)).toHaveLength(4);
  });

  it('fills a concave L-notch with an InnerCorner', () => {
    // A 3×3 layer with the +x column removed below the top row: the cell
    // inside the notch is a concave corner → InnerCorner; the row tip
    // beyond it is a wall tip → QuarterBlock.
    const grid = gridOf([
      ['###', '##.', '##.'],
    ]);
    const fit = fitShapes(grid);
    const kinds = [...fit.filledParts.values()].map((c) => c.partId);
    expect(kinds.filter((k) => k === PART.InnerCorner)).toHaveLength(1);
    expect(kinds.filter((k) => k === PART.QuarterBlock)).toHaveLength(1);
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

  it('softEdges places BlockSlopedUp lips at single rises (off by default)', () => {
    // A 1-step terrace: y0 full row of 4, y1 first cell only. With softEdges
    // the exposed y0 cells adjacent to the rise become BlockSlopedUp (71).
    const grid = gridOf([
      ['####'],
      ['#...'],
    ]);
    const off = [...fitShapes(grid).filledParts.values()];
    expect(off.some((c) => c.partId === 71)).toBe(false); // default: plain

    const on = [...fitShapes(grid, { softEdges: true }).filledParts.values()];
    const lips = on.filter((c) => c.partId === 71);
    expect(lips.length).toBeGreaterThan(0);
    // The rise is the y1 cell at x=0 — the lip at (x1,y0) faces −x
    // (DIRS[2]) → SLOPED_UP_ROT[2] = 1.
    expect(lips.some((c) => c.rotation === 1)).toBe(true);
  });

  it('NO ramps anywhere — fitShapes emits filled cells only', () => {
    // Both ramp-friendly terrains (a single step, a gentle rise) now yield
    // nothing in empty cells: ramps are removed from the shape vocabulary
    // by request. fitShapes has no rampParts at all.
    const grid = gridOf([
      ['######..'],
      ['....####'],
      ['......##'],
    ]);
    const fit = fitShapes(grid);
    const kinds = [...fit.filledParts.values()].map((c) => c.partId);
    expect(kinds).not.toContain(85); // BlockSlopeUp
    expect(kinds).not.toContain(151); // BlockSlopeUpLong
    // Filled-cell shaping still works.
    expect(kinds.every((k) => [29, 53, 54, 155, 188].includes(k))).toBe(true);
  });

  it('shape toggles fall back to plainer pieces', () => {
    // A 3×3 plate: all shaping on → 4 OuterCorners; outer corners OFF →
    // 4 HalfBlocks; halves OFF too → 9 plain Blocks.
    const grid = gridOf([
      ['###', '###', '###'],
    ]);
    const onlyOuter = [...fitShapes(grid, { outerCorners: false }).filledParts.values()];
    expect(onlyOuter.filter((c) => c.partId === PART.OuterCorner)).toHaveLength(0);
    expect(onlyOuter.filter((c) => c.partId === PART.HalfBlock)).toHaveLength(4);

    const plain = [...fitShapes(grid, { outerCorners: false, halfBlocks: false }).filledParts.values()];
    expect(new Set(plain.map((c) => c.partId))).toEqual(new Set([PART.Block]));
    expect(plain).toHaveLength(9);

    // Quarter blocks off: a 1×3 wall keeps plain Blocks.
    const wall = gridOf([['###']]);
    const wallFit = [...fitShapes(wall, { quarterBlocks: false }).filledParts.values()];
    expect(new Set(wallFit.map((c) => c.partId))).toEqual(new Set([PART.Block]));

    // Inner corners off: the L-notch keeps Block/Half instead of InnerCorner.
    const notch = gridOf([['###', '##.', '##.']]);
    const notchFit = [...fitShapes(notch, { innerCorners: false }).filledParts.values()];
    expect(notchFit.some((c) => c.partId === PART.InnerCorner)).toBe(false);
  });
});
