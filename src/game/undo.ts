/**
 * Undo/redo bridge — makes an applied insert respond to the editor's own
 * undo/redo buttons and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
 *
 * The editor's real undo stack lives in an untransformed lazy chunk that
 * mixins can't reach (TSPML#87), so applied batches are invisible to it. The
 * bridge keeps its OWN stack of applied batches and intercepts the user's
 * undo gesture in the capture phase while one of our batches is the newest
 * change to the track: it reverts/re-applies the batch itself and stops the
 * event so the editor's stack never sees it. The moment the user edits the
 * track by hand (detected by wrapping the captured track's setPart /
 * deleteSpecificPart), our batches are no longer top-of-history — the bridge
 * goes dormant and native undo behaves exactly as before. That trades depth
 * for correctness: we never mis-order history, and the common case (apply →
 * "oops" → Ctrl+Z) just works.
 */
import type { PlacedPart } from '../codec/parts';
import type { GameTrack } from './track';

export interface UndoBridge {
  /** Push an applied batch (FINAL coordinates) as the newest undoable change. */
  recordBatch(parts: readonly PlacedPart[]): void;
  /** Run `fn` (e.g. session.commit()) without its track writes counting as
   *  the user's own edits. */
  runInternal<T>(fn: () => T): T;
  /** Batches currently undoable / redoable (for status UI + tests). */
  readonly undoDepth: number;
  readonly redoDepth: number;
  dispose(): void;
}

type TrackFn = (...args: unknown[]) => unknown;

/** Structural Element view — the bridge runs against the game frame's DOM
 *  classes (a different realm), so duck-typing beats instanceof anyway. */
interface Elementish {
  closest?(sel: string): Elementish | null;
  querySelector?(sel: string): Elementish | null;
  getAttribute?(name: string): string | null;
}

/** The editor toolbar's undo/redo buttons carry webpack-emitted icon URLs
 *  ending in images/undo.svg / images/redo.svg — the one stable marker. */
export function gestureFor(target: EventTarget | null): 'undo' | 'redo' | null {
  const el = (target as Elementish | null)?.closest?.('button') ?? null;
  const src = el?.querySelector?.('img')?.getAttribute?.('src') ?? '';
  if (/undo\.svg/.test(src)) return 'undo';
  if (/redo\.svg/.test(src)) return 'redo';
  return null;
}

export function createUndoBridge(track: GameTrack, gameWindow: Window): UndoBridge {
  const undoStack: (readonly PlacedPart[])[] = [];
  const redoStack: (readonly PlacedPart[])[] = [];
  let internal = false;
  let disposed = false;

  // ---- foreign-edit detection: shadow the instance methods ----
  const trackRec = track as unknown as Record<string, TrackFn>;
  const origSetPart = trackRec['setPart']!;
  const origDelete = trackRec['deleteSpecificPart']!;
  const onForeignEdit = (): void => {
    // A hand edit sits on top of our batches in real history — undoing ours
    // first would reorder time. Go dormant until the next apply.
    undoStack.length = 0;
    redoStack.length = 0;
  };
  trackRec['setPart'] = function (this: unknown, ...args: unknown[]) {
    if (!internal) onForeignEdit();
    return origSetPart.apply(this, args);
  };
  trackRec['deleteSpecificPart'] = function (this: unknown, ...args: unknown[]) {
    if (!internal) onForeignEdit();
    return origDelete.apply(this, args);
  };

  function runInternal<T>(fn: () => T): T {
    const prev = internal;
    internal = true;
    try { return fn(); } finally { internal = prev; }
  }

  function revertBatch(parts: readonly PlacedPart[]): void {
    runInternal(() => {
      for (const p of parts) {
        try { track.deleteSpecificPart(p.partId, p.x, p.y, p.z, p.rotation, p.rotationAxis); } catch { /* already gone */ }
      }
      track.refreshMeshes();
    });
  }

  function reapplyBatch(parts: readonly PlacedPart[]): boolean {
    return runInternal(() => {
      const done: PlacedPart[] = [];
      try {
        for (const p of parts) {
          track.setPart(p.x, p.y, p.z, p.partId, p.rotation, p.rotationAxis, p.color, null, null);
          done.push(p);
        }
      } catch {
        for (const p of done) {
          try { track.deleteSpecificPart(p.partId, p.x, p.y, p.z, p.rotation, p.rotationAxis); } catch { /* best effort */ }
        }
        track.refreshMeshes();
        return false;
      }
      track.refreshMeshes();
      return true;
    });
  }

  /** Handle a gesture if it's ours to handle. Returns true when consumed. */
  function handle(gesture: 'undo' | 'redo'): boolean {
    if (gesture === 'undo') {
      const batch = undoStack.pop();
      if (!batch) return false;
      revertBatch(batch);
      redoStack.push(batch);
      return true;
    }
    const batch = redoStack.pop();
    if (!batch) return false;
    if (reapplyBatch(batch)) undoStack.push(batch);
    return true;
  }

  const swallow = (e: Event): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  // The game acts on click, but stop the whole pointer sequence so nothing
  // else (hover/active handlers) reacts to a press we consumed.
  const onPointer = (e: PointerEvent | MouseEvent): void => {
    if (disposed) return;
    const g = gestureFor(e.target);
    if (!g) return;
    const willHandle = g === 'undo' ? undoStack.length > 0 : redoStack.length > 0;
    if (!willHandle) return;
    swallow(e);
    if (e.type === 'click') handle(g);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (disposed || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const g: 'undo' | 'redo' | null =
      k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : k === 'y' && !e.shiftKey ? 'redo' : null;
    if (!g) return;
    const willHandle = g === 'undo' ? undoStack.length > 0 : redoStack.length > 0;
    if (!willHandle) return;
    swallow(e);
    handle(g);
  };

  gameWindow.addEventListener('pointerdown', onPointer, true);
  gameWindow.addEventListener('pointerup', onPointer, true);
  gameWindow.addEventListener('click', onPointer, true);
  gameWindow.addEventListener('keydown', onKeyDown, true);

  return {
    recordBatch(parts) {
      if (disposed || parts.length === 0) return;
      undoStack.push([...parts]);
      redoStack.length = 0; // a new apply is a new change — redo history dies
    },
    runInternal,
    get undoDepth() { return undoStack.length; },
    get redoDepth() { return redoStack.length; },
    dispose() {
      if (disposed) return;
      disposed = true;
      undoStack.length = 0;
      redoStack.length = 0;
      // Restore the original track methods (the instance outlives the editor).
      try {
        trackRec['setPart'] = origSetPart;
        trackRec['deleteSpecificPart'] = origDelete;
      } catch { /* frame gone */ }
      try {
        gameWindow.removeEventListener('pointerdown', onPointer, true);
        gameWindow.removeEventListener('pointerup', onPointer, true);
        gameWindow.removeEventListener('click', onPointer, true);
        gameWindow.removeEventListener('keydown', onKeyDown, true);
      } catch { /* frame gone */ }
    },
  };
}
