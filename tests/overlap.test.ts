import { describe, expect, it } from 'vitest';
import { AXIS, COLOR, PART, type PlacedPart } from '../src/codec/parts';
import { countOverlaps, FOOTPRINT_OFFSETS, type OccupancyTrack } from '../src/game/overlap';

function part(x: number, y: number, z: number): PlacedPart {
  return { x, y, z, partId: PART.Block, rotation: 0, rotationAxis: AXIS.YPositive, color: COLOR.Default };
}

/** In-memory track mirroring the game's tile map: every placed part claims
 *  the full Block footprint ([-2..1]² tiles, one y unit), exactly like the
 *  0.6.2 bundle's setPart does via tiles.rotated(). */
function fakeTrack(placed: readonly PlacedPart[]): OccupancyTrack & { calls: { at: number; within: number } } {
  const tiles = new Map<string, PlacedPart[]>();
  for (const p of placed) {
    for (const dx of FOOTPRINT_OFFSETS) {
      for (const dz of FOOTPRINT_OFFSETS) {
        const k = `${p.x + dx}|${p.y}|${p.z + dz}`;
        const list = tiles.get(k);
        if (list) list.push(p); else tiles.set(k, [p]);
      }
    }
  }
  const calls = { at: 0, within: 0 };
  return {
    calls,
    getPartsAt(x, y, z) {
      calls.at++;
      return tiles.get(`${x}|${y}|${z}`) ?? [];
    },
    getPartsWithin(minX, minY, minZ, maxX, maxY, maxZ) {
      calls.within++;
      return placed.filter((p) =>
        FOOTPRINT_OFFSETS.some((dx) => FOOTPRINT_OFFSETS.some((dz) => {
          const x = p.x + dx, z = p.z + dz;
          return x >= minX && x <= maxX && p.y >= minY && p.y <= maxY && z >= minZ && z <= maxZ;
        })));
    },
  };
}

const ZERO = { x: 0, y: 0, z: 0 };

describe('countOverlaps', () => {
  it('reports clear on an empty track with one getPartsWithin call', () => {
    const track = fakeTrack([]);
    const res = countOverlaps(track, [part(0, 1, 0), part(4, 1, 0)], ZERO);
    expect(res).toEqual({ overlapping: 0, supported: true, capped: false });
    expect(track.calls.within).toBe(1);
    expect(track.calls.at).toBe(0); // phase 2 never runs in free space
  });

  it('counts a staged part sitting exactly on an existing one', () => {
    const track = fakeTrack([part(0, 1, 0)]);
    const res = countOverlaps(track, [part(0, 1, 0)], ZERO);
    expect(res.overlapping).toBe(1);
  });

  it('detects footprint-only overlap (origins 4 tiles apart share no tile; 3 apart do)', () => {
    const track = fakeTrack([part(0, 1, 0)]);
    // 4 tiles apart = adjacent Blocks, no shared tile.
    expect(countOverlaps(track, [part(4, 1, 0)], ZERO).overlapping).toBe(0);
    // 3 tiles apart = footprints intersect.
    expect(countOverlaps(track, [part(3, 1, 0)], ZERO).overlapping).toBe(1);
  });

  it('applies the session offset before testing', () => {
    const track = fakeTrack([part(0, 1, 0)]);
    const staged = [part(0, 1, 0)];
    expect(countOverlaps(track, staged, { x: 8, y: 0, z: 0 }).overlapping).toBe(0);
    expect(countOverlaps(track, staged, { x: 8, y: 0, z: 0 })).toMatchObject({ supported: true });
    expect(countOverlaps(track, staged, ZERO).overlapping).toBe(1);
  });

  it('y must match — a part one level up does not overlap', () => {
    const track = fakeTrack([part(0, 1, 0)]);
    expect(countOverlaps(track, [part(0, 2, 0)], ZERO).overlapping).toBe(0);
  });

  it('counts each overlapping staged part once, not per tile', () => {
    // One existing part; a staged part right on top shares all 16 tiles but
    // counts as ONE overlapping part.
    const track = fakeTrack([part(0, 1, 0)]);
    const res = countOverlaps(track, [part(0, 1, 0), part(8, 1, 0)], ZERO);
    expect(res.overlapping).toBe(1);
  });

  it('skips staged parts far from any candidate (getPartsAt stays cheap)', () => {
    const track = fakeTrack([part(0, 1, 0)]);
    const staged = [part(0, 1, 0), part(400, 1, 0), part(800, 1, 0)];
    const res = countOverlaps(track, staged, ZERO);
    expect(res.overlapping).toBe(1);
    // Only the near part is tile-tested; a hit exits after ≤16 probes.
    expect(track.calls.at).toBeLessThanOrEqual(16);
  });

  it('caps the exact pass and flags it', () => {
    const track = fakeTrack([part(0, 1, 0)]);
    const staged = [part(0, 1, 0), part(1, 1, 0), part(2, 1, 0)];
    const res = countOverlaps(track, staged, ZERO, 2);
    expect(res.capped).toBe(true);
    expect(res.overlapping).toBe(2); // lower bound
  });

  it('reports unsupported when the track lacks the read methods', () => {
    expect(countOverlaps({}, [part(0, 1, 0)], ZERO).supported).toBe(false);
    expect(countOverlaps(null, [part(0, 1, 0)], ZERO).supported).toBe(false);
    expect(countOverlaps({ getPartsAt: () => [] }, [part(0, 1, 0)], ZERO).supported).toBe(false);
  });

  it('empty staged list is clear without any track calls', () => {
    const track = fakeTrack([part(0, 1, 0)]);
    const res = countOverlaps(track, [], ZERO);
    expect(res.overlapping).toBe(0);
    expect(track.calls.within).toBe(0);
  });
});
