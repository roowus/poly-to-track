import { describe, expect, it } from 'vitest';
import { AXIS, PART, type PlacedPart } from '../src/codec/parts';
import { insertParts, rotatePartsY, rotatePartY, translateParts } from '../src/game/insert';
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

describe('insertParts', () => {
  it('places all parts and commit leaves them in the track', () => {
    const track = fakeTrack();
    const session = insertParts(track, [part(0, 1, 0), part(4, 1, 0)]);
    expect(track.parts.size).toBe(2);
    session.commit();
    expect(session.alive).toBe(false);
    expect(track.parts.size).toBe(2);
  });

  it('remove deletes everything it placed', () => {
    const track = fakeTrack();
    const session = insertParts(track, [part(0, 1, 0), part(4, 1, 0)]);
    session.remove();
    expect(track.parts.size).toBe(0);
    expect(session.alive).toBe(false);
  });

  it('translate moves the placed parts and accumulates offset', () => {
    const track = fakeTrack();
    const session = insertParts(track, [part(0, 1, 0)]);
    expect(session.translate(4, 1, -4)).toBe(true);
    expect([...track.parts.values()][0]).toMatchObject({ x: 4, y: 2, z: -4 });
    expect(session.offset).toEqual({ x: 4, y: 1, z: -4 });
  });

  it('refuses to translate below ground and leaves parts untouched', () => {
    const track = fakeTrack();
    const session = insertParts(track, [part(0, 0, 0)]);
    expect(session.translate(0, -1, 0)).toBe(false);
    expect([...track.parts.values()][0]).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(session.offset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('rolls back a partial placement when the game throws mid-batch', () => {
    const track = fakeTrack();
    // Second part is below ground: whole insert must throw and leave nothing.
    expect(() => insertParts(track, [part(0, 1, 0), part(4, -1, 0)])).toThrow(/below ground/);
    expect(track.parts.size).toBe(0);
  });

  it('replaceParts swaps the placement but keeps the session translation', () => {
    const track = fakeTrack();
    const session = insertParts(track, [part(0, 1, 0)]);
    session.translate(4, 0, 0);
    expect(session.replaceParts([part(0, 1, 0), part(0, 2, 0)])).toBe(true);
    expect(track.parts.size).toBe(2);
    // New parts ride the accumulated +4x offset.
    expect(new Set([...track.parts.values()].map((p) => `${p.x},${p.y}`))).toEqual(new Set(['4,1', '4,2']));
  });

  it('restores the previous placement when the replacement fails', () => {
    const track = fakeTrack();
    const session = insertParts(track, [part(0, 1, 0)]);
    expect(session.replaceParts([part(0, -5, 0)])).toBe(false);
    expect(track.parts.size).toBe(1);
    expect([...track.parts.values()][0]).toMatchObject({ x: 0, y: 1, z: 0 });
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
