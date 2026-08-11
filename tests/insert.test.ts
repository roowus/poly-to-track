import { describe, expect, it } from 'vitest';
import { AXIS, PART, type PlacedPart } from '../src/codec/parts';
import { rotatePartsY, rotatePartY, stageParts, translateParts } from '../src/game/insert';
import { asGameTrack, type GameTrack } from '../src/game/track';

function part(x: number, y: number, z: number, partId: number = PART.Block, rotation = 0): PlacedPart {
  return { x, y, z, partId, rotation, rotationAxis: AXIS.YPositive, color: 0 };
}

/** In-memory stand-in for the game track: same setPart/deleteSpecificPart
 *  contract, including the below-ground throw. */
function fakeTrack(): GameTrack & { parts: Map<string, PlacedPart> } {
  const parts = new Map<string, PlacedPart>();
  const key = (p: { x: number; y: number; z: number; partId: number; rotation: number }) =>
    `${p.partId}|${p.x}|${p.y}|${p.z}|${p.rotation}`;
  return {
    parts,
    setPart(x, y, z, partId, rotation, rotationAxis, color) {
      if (y < 0) throw new Error('Track part below ground');
      const p = part(x, y, z, partId, rotation);
      parts.set(key(p), { ...p, rotationAxis, color });
    },
    deleteSpecificPart(partId, x, y, z, rotation) {
      const k = key({ x, y, z, partId, rotation });
      const found = parts.get(k) ?? null;
      parts.delete(k);
      return found;
    },
    refreshMeshes() { /* meshes are the game's business */ },
  };
}

describe('rotatePartY', () => {
  it('maps origin (x,z) → (z,−x) and bumps rotation', () => {
    expect(rotatePartY(part(4, 1, 8))).toMatchObject({ x: 8, z: -4, rotation: 1 });
    expect(rotatePartY(part(0, 0, 0, PART.Block, 3))).toMatchObject({ x: 0, z: 0, rotation: 0 });
  });

  it('four turns is the identity', () => {
    let p = part(4, 2, -8, PART.HalfBlock, 1);
    for (let i = 0; i < 4; i++) p = rotatePartY(p);
    expect(p).toEqual(part(4, 2, -8, PART.HalfBlock, 1));
  });
});

describe('rotatePartsY', () => {
  it('keeps the min corner fixed', () => {
    const parts = [part(0, 1, 0), part(4, 1, 0), part(8, 1, 0)]; // a row along x
    const rotated = rotatePartsY(parts);
    // Row along x becomes a row along z, still starting at (0, *, 0).
    expect(Math.min(...rotated.map((p) => p.x))).toBe(0);
    expect(Math.min(...rotated.map((p) => p.z))).toBe(0);
    expect(new Set(rotated.map((p) => `${p.x},${p.z}`))).toEqual(new Set(['0,0', '0,4', '0,8']));
  });
});

describe('stageParts', () => {
  it('stages without touching the track; commit does the one placement', () => {
    const track = fakeTrack();
    const session = stageParts(track, [part(0, 1, 0), part(4, 1, 0)]);
    expect(track.parts.size).toBe(0); // NOTHING placed while staging
    expect(session.count).toBe(2);
    session.commit();
    expect(session.alive).toBe(false);
    expect(track.parts.size).toBe(2);
  });

  it('remove drops the staged model and never touches the track', () => {
    const track = fakeTrack();
    const session = stageParts(track, [part(0, 1, 0), part(4, 1, 0)]);
    session.remove();
    expect(track.parts.size).toBe(0);
    expect(session.alive).toBe(false);
  });

  it('translate accumulates the offset; commit places at the offset position', () => {
    const track = fakeTrack();
    const session = stageParts(track, [part(0, 1, 0)]);
    expect(session.translate(4, 1, -4)).toBe(true);
    expect(session.offset).toEqual({ x: 4, y: 1, z: -4 });
    expect(track.parts.size).toBe(0); // still staged
    session.commit();
    expect([...track.parts.values()][0]).toMatchObject({ x: 4, y: 2, z: -4 });
  });

  it('refuses to translate below ground', () => {
    const track = fakeTrack();
    const session = stageParts(track, [part(0, 0, 0)]);
    expect(session.translate(0, -1, 0)).toBe(false);
    expect(session.offset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('commit rolls back a partial placement and keeps the session alive', () => {
    const track = fakeTrack();
    // Second part is below ground: the whole commit must throw, place nothing,
    // and leave the session alive so the user can move the model and retry.
    const session = stageParts(track, [part(0, 1, 0), part(4, -1, 0)]);
    expect(() => session.commit()).toThrow(/below ground/);
    expect(track.parts.size).toBe(0);
    expect(session.alive).toBe(true);
    // Raise the model out of the ground; the retry succeeds.
    expect(session.translate(0, 1, 0)).toBe(true);
    session.commit();
    expect(track.parts.size).toBe(2);
  });

  it('replaceParts swaps the staged list but keeps the session offset', () => {
    const track = fakeTrack();
    const session = stageParts(track, [part(0, 1, 0)]);
    session.translate(4, 0, 0);
    session.replaceParts([part(0, 1, 0), part(0, 2, 0)]);
    expect(session.count).toBe(2);
    session.commit();
    // New parts ride the accumulated +4x offset.
    expect(new Set([...track.parts.values()].map((p) => `${p.x},${p.y}`))).toEqual(new Set(['4,1', '4,2']));
  });

  it('rotateY regenerates the staged list in place', () => {
    const track = fakeTrack();
    const session = stageParts(track, [part(0, 1, 0), part(4, 1, 0)]);
    session.rotateY();
    // Row along x became a row along z (min corner pinned).
    expect(new Set(session.parts.map((p) => `${p.x},${p.z}`))).toEqual(new Set(['0,0', '0,4']));
    expect(track.parts.size).toBe(0);
  });

  it('bounds include the session offset and follow translation', () => {
    const track = fakeTrack();
    const session = stageParts(track, [part(0, 0, 0), part(8, 2, 4)]);
    expect(session.bounds).toEqual({ min: [0, 0, 0], max: [8, 2, 4] });
    session.translate(4, 1, 0);
    expect(session.bounds).toEqual({ min: [4, 1, 0], max: [12, 3, 4] });
    session.remove();
    expect(session.bounds).toBeNull();
  });
});

describe('asGameTrack', () => {
  it('accepts the real method surface and rejects junk', () => {
    expect(asGameTrack(fakeTrack())).not.toBeNull();
    expect(asGameTrack(null)).toBeNull();
    expect(asGameTrack({})).toBeNull();
    expect(asGameTrack({ setPart() {} })).toBeNull();
  });
});

describe('translateParts', () => {
  it('is a plain shift', () => {
    expect(translateParts([part(1, 2, 3)], 4, -1, 8)[0]).toMatchObject({ x: 5, y: 1, z: 11 });
  });
});
