import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { b62Decode, b62Encode } from '../src/codec/b62';
import { fromExportString } from '../src/codec/decode';
import { toExportString } from '../src/codec/encode';
import { AXIS, COLOR, PART, type PlacedPart } from '../src/codec/parts';
import { fromV2ExportString } from './helpers/v2-legacy';

const FIXTURE = readFileSync(
  join(__dirname, 'fixtures', 'amethyst-skyscraper.code.txt'),
  'utf-8',
).trim();

describe('b62 bitstream codec', () => {
  it('round-trips random byte arrays', () => {
    for (let n = 0; n < 50; n++) {
      const bytes = new Uint8Array(n * 7 + 1);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + n * 101) & 255;
      const decoded = b62Decode(b62Encode(bytes));
      expect(decoded).not.toBeNull();
      // The encoder may emit trailing zero bits that decode to extra 0 bytes;
      // the payload prefix must match exactly (the game tolerates the same).
      expect([...decoded!.subarray(0, bytes.length)]).toEqual([...bytes]);
    }
  });

  it('rejects characters outside the alphabet', () => {
    expect(b62Decode('abc$')).toBeNull();
    expect(b62Decode('abc def')).toBeNull();
  });
});

describe('real community track (legacy v2 fixture)', () => {
  it('decodes via the v2 legacy format the game still imports', () => {
    const track = fromV2ExportString(FIXTURE);
    expect(track).not.toBeNull();
    expect(track!.name.length).toBeGreaterThan(0);
    expect(track!.parts.length).toBeGreaterThan(100);
    // A shared, playable track must have a start part.
    const startIds = [PART.Start, 91, 92, 93];
    expect(track!.parts.some((p) => startIds.includes(p.partId))).toBe(true);
  });

  it('adjacent same-id parts sit on a 4-tile x/z grid, 1-unit y grid', () => {
    // Empirically settles the grid-spacing question: current-format coords
    // are tile-grid; a full Block footprint is 4×4 tiles.
    const track = fromV2ExportString(FIXTURE)!;
    for (const p of track.parts) {
      expect(Math.abs(p.x % 4)).toBe(0);
      expect(Math.abs(p.z % 4)).toBe(0);
    }
  });

  it('round-trips through our PolyTrack2 encoder/decoder', () => {
    const v2 = fromV2ExportString(FIXTURE)!;
    const code = toExportString(v2.parts, { name: v2.name, author: 'legacy' });
    const back = fromExportString(code);
    expect(back).not.toBeNull();
    expect(back!.name).toBe(v2.name);
    expect(back!.parts.length).toBe(v2.parts.length);
  });
});

describe('toExportString', () => {
  const meta = { name: 'Test Cube', author: 'poly-to-track' };
  const cube: PlacedPart[] = [];
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 3; y++)
      for (let z = 0; z < 3; z++)
        cube.push({
          x, y: y + 1, z,
          partId: PART.Block,
          rotation: 0,
          rotationAxis: AXIS.YPositive,
          color: COLOR.Custom6,
        });
  cube.push({
    x: 0, y: 0, z: -3,
    partId: PART.Start, rotation: 0, rotationAxis: AXIS.YPositive,
    color: COLOR.Default, startOrder: 0,
  });
  cube.push({
    x: 2, y: 0, z: -3,
    partId: PART.Finish, rotation: 0, rotationAxis: AXIS.YPositive,
    color: COLOR.Default,
  });

  it('produces a PolyTrack2-prefixed code that our decoder round-trips', () => {
    const code = toExportString(cube, meta);
    expect(code.startsWith('PolyTrack2')).toBe(true);
    const back = fromExportString(code);
    expect(back).not.toBeNull();
    expect(back!.name).toBe('Test Cube');
    expect(back!.author).toBe('poly-to-track');
    expect(back!.parts.length).toBe(cube.length);
    const blocks = back!.parts.filter((p) => p.partId === PART.Block);
    expect(blocks.length).toBe(27);
    expect(blocks.every((p) => p.color === COLOR.Custom6)).toBe(true);
    const start = back!.parts.find((p) => p.partId === PART.Start);
    expect(start?.startOrder).toBe(0);
  });

  it('re-encoding a decoded real track reproduces its exact part set', () => {
    const v2 = fromV2ExportString(FIXTURE)!;
    const original = fromExportString(toExportString(v2.parts, { name: v2.name }))!;
    const reencoded = toExportString(original.parts, {
      name: original.name,
      author: original.author,
      lastModified: original.lastModified,
      environment: original.environment,
      sunRotation: original.sunRotation,
    });
    const back = fromExportString(reencoded)!;
    expect(back.parts).toEqual(original.parts);
    expect(back.name).toBe(original.name);
    expect(back.environment).toBe(original.environment);
  });

  it('negative coordinates survive the min-offset encoding', () => {
    const parts: PlacedPart[] = [
      { x: -1000, y: -5, z: -77, partId: PART.Block, rotation: 3, rotationAxis: AXIS.ZNegative, color: COLOR.Custom0 },
      { x: 500, y: 40, z: 900, partId: PART.Block, rotation: 1, rotationAxis: AXIS.XPositive, color: COLOR.Custom8 },
    ];
    const back = fromExportString(toExportString(parts, { name: 'neg' }))!;
    expect(back.parts).toHaveLength(2);
    expect(back.parts[0]).toMatchObject({ x: -1000, y: -5, z: -77, rotation: 3, rotationAxis: AXIS.ZNegative });
    expect(back.parts[1]).toMatchObject({ x: 500, y: 40, z: 900 });
  });

  it('throws when a checkpoint part lacks checkpointOrder', () => {
    const bad: PlacedPart[] = [
      { x: 0, y: 0, z: 0, partId: PART.Checkpoint, rotation: 0, rotationAxis: 0, color: 0 },
    ];
    expect(() => toExportString(bad, { name: 'x' })).toThrow(/checkpoint order/i);
  });
});
