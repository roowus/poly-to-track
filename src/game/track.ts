/**
 * Reaching the LIVE game objects. This mod ships a TSPML mixin (mixins.json)
 * that patches the track class's `setPart` — the class living in the game's
 * main bundle, anchored by its two unique error literals ("Track part below
 * ground" / "Track part color does not exist") — to publish `this` on the game
 * window as `__polyToTrackTrack`.
 *
 * The game reuses ONE track instance across play sessions and the editor
 * (the editor constructor receives it, calls `clear()` then places its Start
 * part through `setPart`), so the captured reference is stable and always
 * points at whatever the game currently has open. That is exactly the
 * "insert into whatever is open" semantic we want.
 *
 * The mod itself runs in the TSPML portal page; the game lives in a
 * same-origin iframe. `findGameWindow` locates it.
 */

export const TRACK_CAPTURE_GLOBAL = '__polyToTrackTrack';
export const RENDERER_CAPTURE_GLOBAL = '__polyToTrackRenderer';

/** The game's 2D bounds vectors are three.js Vector2s: `y` holds the z tile. */
export interface TrackBounds {
  readonly min: { readonly x: number; readonly y: number };
  readonly max: { readonly x: number; readonly y: number };
}

/**
 * The slice of the game's track class this mod calls. Coordinates are TILES
 * (a full Block spans 4×4 tiles in x/z, 1 in y); arg order verified against
 * the 0.6.2 bundle (`loadTrackData` forwards in exactly this order).
 */
export interface GameTrack {
  setPart(
    x: number, y: number, z: number,
    partId: number, rotation: number, rotationAxis: number, color: number,
    checkpointOrder?: number | null, startOrder?: number | null,
  ): void;
  deleteSpecificPart(
    partId: number, x: number, y: number, z: number,
    rotation: number, rotationAxis: number,
  ): unknown;
  refreshMeshes(): void;
  getBounds?(): TrackBounds;
  /** Read surface documented by TSPML's editor-internals research (#87):
   *  plain-data occupancy queries, used for the overlap warning. Optional —
   *  present on the 0.6.2 Track class, but nothing breaks without them. */
  getPartsAt?(x: number, y: number, z: number): readonly unknown[];
  getPartsWithin?(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): readonly unknown[];
}

/** Validate a captured value before trusting it as the game track. */
export function asGameTrack(v: unknown): GameTrack | null {
  if (typeof v !== 'object' || v === null) return null;
  const t = v as Record<string, unknown>;
  const ok =
    typeof t.setPart === 'function' &&
    typeof t.deleteSpecificPart === 'function' &&
    typeof t.refreshMeshes === 'function';
  return ok ? (v as unknown as GameTrack) : null;
}

/**
 * The same-origin game window: our own window when the mod was loaded inside
 * the game frame, else the first iframe whose document has the game's #ui /
 * #screen layers (the TSPML portal's proxied game frame).
 */
export function findGameWindow(from: Window = window): Window | null {
  if (looksLikeGame(from)) return from;
  for (const f of Array.from(from.document.querySelectorAll('iframe'))) {
    try {
      const w = f.contentWindow;
      if (w && looksLikeGame(w)) return w;
    } catch {
      // cross-origin frame — not the game
    }
  }
  return null;
}

function looksLikeGame(w: Window): boolean {
  try {
    return w.document.getElementById('ui') !== null || w.document.getElementById('screen') !== null;
  } catch {
    return false;
  }
}

/** The mixin-captured track instance on `gameWindow`, shape-checked. */
export function getCapturedTrack(gameWindow: Window | null): GameTrack | null {
  if (!gameWindow) return null;
  return asGameTrack((gameWindow as unknown as Record<string, unknown>)[TRACK_CAPTURE_GLOBAL]);
}

/**
 * The slice of the game's renderer wrapper this mod uses for in-viewport
 * gizmos. Captured by the second mixin (anchor "Failed to create WebGL
 * renderer", method `setCamera` — the editor calls it with its camera on
 * entry). `scene` is the live three.js Scene the game renders every frame, so
 * anything we `add()` to it shows up in the viewport with zero extra plumbing.
 */
export interface GameRenderer {
  readonly scene: SceneLike;
  readonly camera: unknown;
}

/** Minimal structural view of a three.js Object3D/Scene we rely on. */
export interface SceneLike {
  readonly isObject3D: boolean;
  add(obj: unknown): unknown;
  remove(obj: unknown): unknown;
}

export function asGameRenderer(v: unknown): GameRenderer | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as { scene?: { isObject3D?: unknown; add?: unknown; remove?: unknown } };
  const s = r.scene;
  const ok =
    typeof s === 'object' && s !== null &&
    s.isObject3D === true &&
    typeof s.add === 'function' &&
    typeof s.remove === 'function';
  return ok ? (v as GameRenderer) : null;
}

/** The mixin-captured renderer wrapper on `gameWindow`, shape-checked. */
export function getCapturedRenderer(gameWindow: Window | null): GameRenderer | null {
  if (!gameWindow) return null;
  return asGameRenderer((gameWindow as unknown as Record<string, unknown>)[RENDERER_CAPTURE_GLOBAL]);
}

/**
 * A build offset (in grid CELLS — ×4 tiles horizontally) that puts the model
 * just past everything already on the track, so it never lands on top of the
 * editor's Start part or the user's work.
 */
export function pickFreeOffsetCells(track: GameTrack): [number, number, number] {
  try {
    const b = track.getBounds?.();
    const maxX = b && Number.isFinite(b.max.x) ? b.max.x : 0;
    return [Math.floor(maxX / 4) + 2, 0, 0];
  } catch {
    return [2, 0, 0];
  }
}
