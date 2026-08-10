/**
 * Live-editor insertion session: place the built parts into the captured game
 * track, then keep enough state to move / rotate / re-place / remove them
 * until the user commits — the Blender-style "object is selected until you
 * click away" phase, minus real gizmos (the editor's three.js scene belongs to
 * an untransformed lazy chunk, so we drive the game's own part API instead of
 * drawing handles inside its renderer).
 *
 * The editor's undo stack is NOT integrated (it lives in the same lazy chunk);
 * the session's own remove() is the undo for everything it placed.
 */
import type { PlacedPart } from '../codec/parts';
import type { GameTrack } from './track';

/** Quarter-turn a part origin about Y. Derived from the game's tile-rotation
 *  formula (chunk 5494: tile [x,z] → [z,−x−1]): applying it to a full 4×4
 *  footprint [−2..1]² shows the ORIGIN maps as (x,z) → (z,−x) with the part's
 *  own rotation bumped by 1 — the −1 is absorbed by the footprint's asymmetry. */
export function rotatePartY(p: PlacedPart): PlacedPart {
  // `|| 0` normalizes -0 (x=0 negated) — the codec serializes coordinates.
  return { ...p, x: p.z, z: -p.x || 0, rotation: (p.rotation + 1) % 4 };
}

/** Rotate a whole part list a quarter turn about Y, keeping its min corner
 *  fixed so the model doesn't orbit away from where the user put it. */
export function rotatePartsY(parts: readonly PlacedPart[]): PlacedPart[] {
  if (parts.length === 0) return [];
  const rotated = parts.map(rotatePartY);
  let minX0 = Infinity, minZ0 = Infinity, minX1 = Infinity, minZ1 = Infinity;
  for (const p of parts) { minX0 = Math.min(minX0, p.x); minZ0 = Math.min(minZ0, p.z); }
  for (const p of rotated) { minX1 = Math.min(minX1, p.x); minZ1 = Math.min(minZ1, p.z); }
  const dx = minX0 - minX1;
  const dz = minZ0 - minZ1;
  return rotated.map((p) => ({ ...p, x: p.x + dx, z: p.z + dz }));
}

/** Translate a part list. dx/dz are TILES (a Block cell is 4), dy is y units. */
export function translateParts(
  parts: readonly PlacedPart[], dx: number, dy: number, dz: number,
): PlacedPart[] {
  return parts.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy, z: p.z + dz }));
}

export interface InsertSession {
  /** Number of parts currently placed. */
  readonly count: number;
  /** Move by tiles/units. Refuses (returns false) if it would sink below ground. */
  translate(dx: number, dy: number, dz: number): boolean;
  /** Quarter-turn about Y, in place. */
  rotateY(): void;
  /** Swap the placed parts for a re-built list (scale / resolution change),
   *  keeping the current session position. Returns false if placement failed. */
  replaceParts(next: readonly PlacedPart[]): boolean;
  /** Where the session currently sits relative to the initial placement. */
  readonly offset: { x: number; y: number; z: number };
  /** Delete everything the session placed. The session is dead afterwards. */
  remove(): void;
  /** Keep everything as-is and stop tracking. The session is dead afterwards. */
  commit(): void;
  readonly alive: boolean;
}

/**
 * Place `parts` into `track` and return the live session, or throw if the
 * game refuses (e.g. below ground). Parts are placed WITHOUT checkpoint/start
 * orders — the open editor already owns its Start.
 */
export function insertParts(track: GameTrack, parts: readonly PlacedPart[]): InsertSession {
  let placed: PlacedPart[] = [];
  let alive = true;
  const offset = { x: 0, y: 0, z: 0 };

  const placeAll = (list: readonly PlacedPart[]): void => {
    const done: PlacedPart[] = [];
    try {
      for (const p of list) {
        track.setPart(p.x, p.y, p.z, p.partId, p.rotation, p.rotationAxis, p.color, null, null);
        done.push(p);
      }
    } catch (err) {
      // Roll back the partial placement so a failed move never leaves half a
      // model behind.
      for (const p of done) {
        try { track.deleteSpecificPart(p.partId, p.x, p.y, p.z, p.rotation, p.rotationAxis); } catch { /* already gone */ }
      }
      throw err;
    }
    placed = [...list];
  };

  const removeAll = (): void => {
    for (const p of placed) {
      try { track.deleteSpecificPart(p.partId, p.x, p.y, p.z, p.rotation, p.rotationAxis); } catch { /* user may have deleted it in the editor */ }
    }
    placed = [];
  };

  const swap = (next: readonly PlacedPart[]): boolean => {
    const prev = placed;
    removeAll();
    try {
      placeAll(next);
    } catch {
      // Restore the previous placement; if even that fails the game state is
      // unchanged (placeAll rolled itself back) and the session keeps prev
      // coordinates so remove() stays a no-op on the missing parts.
      try { placeAll(prev); } catch { /* rolled back to empty */ }
      track.refreshMeshes();
      return false;
    }
    track.refreshMeshes();
    return true;
  };

  placeAll(parts);
  track.refreshMeshes();

  return {
    get count() { return placed.length; },
    get alive() { return alive; },
    offset,

    translate(dx, dy, dz) {
      if (!alive || placed.length === 0) return false;
      // The game throws "Track part below ground" for y<0 — check first.
      const minY = Math.min(...placed.map((p) => p.y));
      if (minY + dy < 0) return false;
      const ok = swap(translateParts(placed, dx, dy, dz));
      if (ok) { offset.x += dx; offset.y += dy; offset.z += dz; }
      return ok;
    },

    rotateY() {
      if (!alive || placed.length === 0) return;
      swap(rotatePartsY(placed));
    },

    replaceParts(next) {
      if (!alive) return false;
      // Keep the session's accumulated translation so a rescale doesn't jump
      // the model back to its birth position.
      return swap(translateParts(next, offset.x, offset.y, offset.z));
    },

    remove() {
      if (!alive) return;
      alive = false;
      removeAll();
      track.refreshMeshes();
    },

    commit() {
      alive = false;
      placed = [];
    },
  };
}
